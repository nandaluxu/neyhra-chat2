/* ===== DeepChat: klien API (reverse-engineered, pola gist deepchat.mjs) =====
   Zero-dependency (cuma node:crypto), dipakai lewat import oleh fitur lain:
     - Scene Capture (lib/scene.js): imageToImage / generateImage = provider UTAMA (nano jadi cadangan)
       + optimizePrompt untuk mempertajam prompt ilustrasi sebelum digambar.
     - Vision (lib/vision.js): chat() dengan image = karakter "melihat" gambar yang dikirim user
       (khusus karakter dengan field vision: true).
   Sesi anonim otomatis: signup Supabase -> create-user (dapat signingSecret) -> semua request
   ditandatangani HMAC-SHA256. Kredit habis (401/402) -> klaim reward iklan otomatis (maks 5x),
   kalau masih gagal -> sesi baru dibuat ulang. Serverless aman: sesi disimpan di memori instance
   (tiap instance bootstrap sendiri; biasanya cuma 1x per cold start).

   Tidak ada env yang wajib. Batas waktu tiap panggilan lewat opts.timeoutMs (default 30 detik)
   supaya rantai fallback (deepchat -> nano) masih kebagian jatah waktu di dalam maxDuration Vercel. */

import { createHmac, createHash, randomUUID } from 'node:crypto'

const BASE_URL = 'https://uebueqfehjrruiwrbmgs.supabase.co'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlYnVlcWZlaGpycnVpd3JibWdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4NTI0NDYsImV4cCI6MjA4ODQyODQ0Nn0.pC43b2gMMx44q7_SUfJDM_ceLaYWeMzKI4QvMwz_AxU'
const TIMEOUT = Number(process.env.DEEPCHAT_TIMEOUT_MS) || 30000

let cachedSession = null
let bootP = null // jaga supaya request pertama yang datang bersamaan tidak bootstrap 5x

function buildSignedHeaders(endpoint, bodyStr, session) {
  const timestampSec = Math.floor(Date.now() / 1000)
  const nonce = randomUUID()
  const idempotencyKey = randomUUID()
  const bodySha256 = createHash('sha256').update(bodyStr, 'utf-8').digest('hex')
  const message = `POST\n${endpoint}\n${timestampSec}\n${nonce}\n${bodySha256}`
  const secretBytes = Buffer.from(session.signingSecret, 'hex')
  const signature = createHmac('sha256', secretBytes).update(message, 'utf-8').digest('hex')

  return {
    'Content-Type': 'application/json',
    'apikey': ANON_KEY,
    'Authorization': `Bearer ${session.accessToken}`,
    'X-Request-Timestamp': String(timestampSec),
    'X-Idempotency-Key': idempotencyKey,
    'X-Request-Signature': signature,
    'X-Request-Nonce': nonce,
    'User-Agent': 'Ktor client'
  }
}

async function bootstrap() {
  const signupRes = await fetch(`${BASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'User-Agent': 'Ktor client'
    },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT)
  })

  if (!signupRes.ok) throw new Error(`Anonymous auth failed: HTTP ${signupRes.status}`)

  const signupData = await signupRes.json()
  const accessToken = signupData.access_token
  const anonUserId = signupData.user?.id

  const randomAndroidId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const installIdHash = createHash('sha256').update(randomAndroidId).digest('hex')

  const createRes = await fetch(`${BASE_URL}/functions/v1/create-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'Ktor client'
    },
    body: JSON.stringify({ anonUserId, installIdHash }),
    signal: AbortSignal.timeout(TIMEOUT)
  })

  if (!createRes.ok) throw new Error(`User provisioning failed: HTTP ${createRes.status}`)

  const createData = await createRes.json()
  const newSession = {
    accessToken,
    anonUserId,
    signingSecret: createData.signingSecret
  }

  const initialBalance = createData.credits?.balance ?? 0
  if (initialBalance < 1) {
    const claimHeaders = buildSignedHeaders('claim-ad-reward', '{}', newSession)
    await fetch(`${BASE_URL}/functions/v1/claim-ad-reward`, {
      method: 'POST',
      headers: claimHeaders,
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT)
    }).catch(() => {}) // klaim awal gagal tidak fatal: requestEndpoint punya jalur klaimnya sendiri
  }

  return newSession
}

async function ensureSession() {
  if (cachedSession) return cachedSession
  if (!bootP) {
    bootP = bootstrap()
      .then(s => { cachedSession = s; return s })
      .finally(() => { bootP = null })
  }
  return bootP
}

async function requestEndpoint(endpoint, payload, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT
  let session = await ensureSession()

  const bodyStr = JSON.stringify(payload)
  const headers = buildSignedHeaders(endpoint, bodyStr, session)

  let res = await fetch(`${BASE_URL}/functions/v1/${endpoint}`, {
    method: 'POST',
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(timeoutMs)
  })

  // 401/402 = kredit habis atau sesi kedaluwarsa: klaim reward iklan (maks 5x), lalu sesi baru kalau masih gagal
  if ((res.status === 401 || res.status === 402) && !opts.isRetry) {
    for (let i = 0; i < 5; i++) {
      const claimRes = await fetch(`${BASE_URL}/functions/v1/claim-ad-reward`, {
        method: 'POST',
        headers: buildSignedHeaders('claim-ad-reward', '{}', session),
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs)
      })
      const claimData = await claimRes.json().catch(() => null)
      if (!claimData || !claimData.success) {
        cachedSession = null // sesi ini sudah tidak bisa di-topup -> bootstrap sesi anonim baru
        session = await ensureSession()
        break
      }
    }
    return requestEndpoint(endpoint, payload, { ...opts, isRetry: true })
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`[${endpoint}] HTTP ${res.status}: ${errorText.slice(0, 200)}`)
  }

  return await res.json()
}

/* Input gambar: data URL, URL http(s), string base64 mentah, atau Buffer/Uint8Array/Blob.
   (Path file lokal sengaja tidak didukung: di Vercel serverless tidak ada file user.) */
async function resolveImageData(imageInput) {
  if (!imageInput) return null

  if (typeof imageInput === 'string') {
    if (imageInput.startsWith('data:')) {
      const parts = imageInput.split(',')
      const mime = parts[0].match(/data:(.*?);/)?.[1] || 'image/jpeg'
      return { base64: parts[1], mimeType: mime }
    }
    if (/^https?:\/\//i.test(imageInput)) {
      const resp = await fetch(imageInput, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`)
      const ab = await resp.arrayBuffer()
      const mime = resp.headers.get('content-type') || 'image/jpeg'
      return { base64: Buffer.from(ab).toString('base64'), mimeType: mime }
    }
    return { base64: imageInput, mimeType: 'image/jpeg' } // anggap base64 mentah
  }

  if (Buffer.isBuffer(imageInput) || imageInput instanceof Uint8Array || imageInput instanceof Blob) {
    const buf = imageInput instanceof Blob ? Buffer.from(await imageInput.arrayBuffer()) : Buffer.from(imageInput)
    return { base64: buf.toString('base64'), mimeType: 'image/jpeg' }
  }

  return null
}

/* Chat multi-provider. options: providerId, modelId, systemPrompt, conversationHistory,
   deepThink, deepResearch, writeCode, image (untuk vision: data URL / URL / base64 / Buffer). */
export async function chat(message, options = {}) {
  if (!message || typeof message !== 'string') throw new Error('Message is required and must be a string')

  const payload = {
    message: message.trim(),
    providerId: options.providerId || 'chatgpt',
    modelId: options.modelId || 'gpt-4o-mini'
  }

  if (options.systemPrompt) payload.systemPrompt = options.systemPrompt
  if (Array.isArray(options.conversationHistory)) payload.conversationHistory = options.conversationHistory
  if (options.categoryId) payload.categoryId = options.categoryId
  if (options.subcategoryId) payload.subcategoryId = options.subcategoryId
  if (options.assistantId) payload.assistantId = options.assistantId
  if (options.deepThink) payload.deepThink = true
  if (options.deepResearch) payload.deepResearch = true
  if (options.writeCode) payload.writeCode = true

  if (options.image) {
    const imgData = await resolveImageData(options.image)
    if (imgData) {
      payload.imageBase64 = imgData.base64
      payload.imageMimeType = imgData.mimeType
    }
  }

  const data = await requestEndpoint('send-message', payload, options)
  return {
    reply: data.reply || '',
    provider: data.provider || payload.providerId,
    model: data.model || payload.modelId,
    creditsUsed: data.creditsUsed ?? 0,
    creditsRemaining: data.creditsRemaining ?? 0,
    creditsExpiry: data.creditsExpiry || null,
    metadata: data.metadata || null
  }
}

/* Prompt optimizer: memperluas prompt sederhana jadi prompt komprehensif.
   context: 'image' | 'generic' | 'video' | 'writing' (kita pakai 'image' untuk Scene Capture). */
export async function optimizePrompt(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') throw new Error('Prompt is required')

  const payload = {
    prompt: prompt.trim(),
    context: options.context || 'generic',
    mode: options.mode || 'optimize'
  }

  const data = await requestEndpoint('optimize-prompt', payload, options)
  return {
    optimizedPrompt: data.optimizedPrompt || '',
    creditsUsed: data.creditsUsed ?? 0,
    creditsRemaining: data.creditsRemaining ?? 0,
    metadata: data.metadata || null
  }
}

/* Text-to-image (Flux Schnell, tanpa watermark). options: size ('1024x1024'), quality, n, timeoutMs. */
export async function generateImage(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') throw new Error('Prompt is required')

  const payload = {
    prompt: prompt.trim(),
    providerId: options.providerId || 'flux',
    modelId: options.modelId || 'flux/schnell',
    size: options.size || '1024x1024',
    quality: options.quality || 'standard',
    n: options.n || 1
  }

  if (options.referenceImage) {
    const imgData = await resolveImageData(options.referenceImage)
    if (imgData) payload.referenceImageBase64 = imgData.base64
  }

  const data = await requestEndpoint('generate-image', payload, options)
  return {
    images: data.images || [],
    provider: data.provider || payload.providerId,
    model: data.model || payload.modelId,
    creditsUsed: data.creditsUsed ?? 0,
    creditsRemaining: data.creditsRemaining ?? 0
  }
}

/* Image-to-image: gambar referensi (karakter) + prompt -> hasil baru yang identitas visualnya terjaga. */
export async function imageToImage(prompt, imageInput, options = {}) {
  if (!prompt || typeof prompt !== 'string') throw new Error('Prompt is required')
  if (!imageInput) throw new Error('Image input is required (URL, data URL, base64, or Buffer)')

  const imgData = await resolveImageData(imageInput)
  if (!imgData) throw new Error('Invalid image input')

  const payload = {
    prompt: prompt.trim(),
    providerId: options.providerId || 'flux',
    modelId: options.modelId || 'flux/schnell',
    size: options.size || '1024x1024',
    quality: options.quality || 'standard',
    n: options.n || 1,
    referenceImageBase64: imgData.base64
  }

  const data = await requestEndpoint('generate-image', payload, options)
  return {
    images: data.images || [],
    provider: data.provider || payload.providerId,
    model: data.model || payload.modelId,
    creditsUsed: data.creditsUsed ?? 0,
    creditsRemaining: data.creditsRemaining ?? 0
  }
}

export async function claimReward(options = {}) {
  const data = await requestEndpoint('claim-ad-reward', {}, options)
  return {
    success: Boolean(data.success),
    creditsAdded: data.creditsAdded ?? 0,
    newBalance: data.newBalance ?? 0,
    newExpiry: data.newExpiry || null,
    adsWatchedToday: data.adsWatchedToday ?? 0,
    adsRemainingToday: data.adsRemainingToday ?? 0
  }
}

export async function getBalance(options = {}) {
  return await requestEndpoint('get-credit-balance', {}, options)
}

/* Unduh hasil gambar jadi Buffer (dipakai kalau mau disimpan ke R2 dsb.). */
export async function downloadMedia(url) {
  if (!url || typeof url !== 'string') throw new Error('URL is required')
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

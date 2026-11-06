import crypto from 'node:crypto'

// Mesin AI alternatif (KHUSUS uji di Mode dev). Bentuk panggilannya sengaja sama dengan chatgpt():
//   getLorkaSession(model) -> auth, lorka(prompt, auth, chatId) -> { response, chatId, auth }
// Stateless: tidak ada file sesi (Vercel read-only). Seluruh state (cookie anonim, id percakapan, riwayat pesan)
// hidup di objek `auth` yang dipegang sessions.js, sama seperti sesi ChatGPT.
const BASE = 'https://www.app.lorka.ai'
export const LORKA_DEFAULT_MODEL = 'openai/gpt-4o-mini'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const randomId = (len = 16) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length]
  return out
}

const baseHeaders = extra => ({ 'User-Agent': UA, Origin: BASE, Referer: BASE + '/', ...extra })

export async function getLorkaSession(model) {
  const res = await fetch(`${BASE}/api/auth/sign-in/anonymous`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error(`Lorka: sesi anonim gagal (HTTP ${res.status})`)
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Lorka: server tidak mengembalikan cookie sesi')
  return {
    cookie,
    visitorId: crypto.randomBytes(16).toString('hex'),
    convId: randomId(16),
    model: model || LORKA_DEFAULT_MODEL,
    messages: []
  }
}

export async function lorka(prompt, auth = null, chatId = null) {
  auth = auth || await getLorkaSession()
  if (!auth.convId) auth.convId = chatId || randomId(16)
  const model = auth.model || LORKA_DEFAULT_MODEL

  const userMsg = { role: 'user', parts: [{ type: 'text', text: prompt }], metadata: { model }, id: randomId(16) }
  const payload = {
    id: auth.convId,
    type: 'chat',
    messages: [...auth.messages, userMsg],
    metadata: { source: 'chat' },
    visitorId: auth.visitorId
  }

  const res = await fetch(`${BASE}/api/v2/chat/anonymous`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json', Cookie: auth.cookie, Accept: 'text/event-stream' }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000)
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`Lorka HTTP ${res.status}${body ? ': ' + body : ''}`)
  }

  let text = '', buf = '', assistantId = null, done = false
  const handle = line => {
    const t = line.trim()
    if (!t.startsWith('data: ')) return
    const data = t.slice(6)
    if (data === '[DONE]') { done = true; return }
    let ev
    try { ev = JSON.parse(data) } catch { return }
    if (ev.type === 'text-start') assistantId = ev.id
    else if (ev.type === 'text-delta') text += ev.delta
    else if (ev.type === 'error') throw new Error(ev.message || ev.errorText || 'Lorka: streaming error')
  }
  const dec = new TextDecoder()
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const l of lines) handle(l)
    if (done) break
  }
  if (buf) handle(buf)

  // riwayat dicatat hanya kalau berhasil, supaya percobaan gagal tidak mengotori percakapan
  if (text) {
    auth.messages.push(userMsg, { role: 'assistant', parts: [{ type: 'text', text }], metadata: { model }, id: assistantId || randomId(16) })
  }
  return { response: text.trim(), chatId: auth.convId, auth }
}

// Daftar model Lorka untuk panel Dev. Bentuk respons tidak dijamin, jadi dinormalisasi longgar ke [{ id, name }].
// Di-cache 10 menit per instance supaya membuka panel berkali-kali tidak menembak Lorka terus.
let modelCache = null
export async function getLorkaModels() {
  if (modelCache && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.list
  const res = await fetch(`${BASE}/api/v2/models`, { headers: baseHeaders({ Accept: 'application/json' }), signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`Lorka: daftar model gagal (HTTP ${res.status})`)
  const data = await res.json()
  const arr = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : []
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const list = arr.map(m => {
    if (typeof m === 'string') return { id: m, name: '' }
    const id = str(m?.id) || str(m?.model) || str(m?.modelId) || str(m?.slug) || str(m?.value) || str(m?.name)
    const name = str(m?.name) || str(m?.title) || str(m?.displayName) || str(m?.label)
    return id ? { id, name: name && name !== id ? name : '' } : null
  }).filter(Boolean)
  if (!list.length) throw new Error('Lorka: bentuk daftar model tidak dikenali: ' + JSON.stringify(data).slice(0, 120))
  modelCache = { at: Date.now(), list }
  return list
}

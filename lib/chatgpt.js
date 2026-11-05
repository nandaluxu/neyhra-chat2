import axios from 'axios'
import crypto from 'crypto'

// split di '=' pertama saja, supaya value cookie yang mengandung '=' tidak terpotong
const parseCookies = (arr) => Object.fromEntries((arr || []).map(c => {
  const kv = c.split(';')[0], i = kv.indexOf('=')
  return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
}))

function cleanSpecialTags(text) {
  if (!text) return ''
  text = text.replace(/\ue200entity\ue202([^\ue201]+)\ue201/g, (m, p1) => {
    try { const a = JSON.parse(p1); return a[1] || a[0] || '' } catch { return '' }
  })
  text = text.replace(/\ue200[^\ue201]*\ue201/g, '')
  let prev
  do {
    prev = text
    text = text.replace(/::writing\{[^}]*\}\s*([\s\S]*?)\s*:::{0,1}/g, '$1')
  } while (text !== prev)
  return text.trim()
}

const UA = 'ChatGPT/1.2026.181 (Android 16; Neo/1.0; build 2222222)'
const baseHeaders = (deviceId, path, account = 'default') => ({
  'User-Agent': UA,
  'OAI-Package-Name': 'com.openai.chatgpt',
  'OAI-Client-Type': 'android',
  'OAI-Device-Id': deviceId,
  'Accept-Language': 'id-ID,in;q=0.9',
  'X-Device-Tier': 'upper_mid',
  'X-OpenAI-Target-Path': path,
  'ChatGPT-Account-Id': account,
  'ChatGPT-Residency-Region': 'no_constraint',
  'Content-Type': 'application/json'
})

export async function getSession() {
  const deviceId = crypto.randomUUID()
  const res = await axios.post('https://android.chat.openai.com/backend-anon/sentinel/chat-requirements', {}, {
    headers: { ...baseHeaders(deviceId, '/backend-anon/sentinel/chat-requirements'), Accept: 'application/json' }
  })
  const cookies = parseCookies(res.headers['set-cookie'])
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  let oaiSc = cookies['oai-sc']
  if (!oaiSc && res.data?.token) oaiSc = `0${res.data.token}`
  const cookie = oaiSc && !cookieStr.includes('oai-sc') ? `oai-sc=${oaiSc}; ${cookieStr}` : cookieStr
  return { cookie, deviceId, parentMessageId: crypto.randomUUID() }
}

export async function chatgpt(prompt, auth = null, chatId = null) {
  auth = auth || await getSession()
  if (!auth.deviceId) auth.deviceId = crypto.randomUUID()
  if (!auth.parentMessageId) auth.parentMessageId = crypto.randomUUID()

  const isAuthorized = !!(auth.authorization || auth.token)
  const prefix = isAuthorized ? '/backend-api' : '/backend-anon'
  const headers = {
    ...baseHeaders(auth.deviceId, `${prefix}/f/conversation`, isAuthorized ? (auth.accountId || 'default') : 'default'),
    Accept: 'text/event-stream',
    Cookie: auth.cookie,
    'X-Sentinel-Payload': JSON.stringify({
      bot_token: {
        failure_reason: "-2: Standard Integrity API error (-2): The Play Store app is either not installed or not the official version.\nAsk the user to install an official and recent version of Play Store.\n (https://developer.android.com/google/play/integrity/reference/com/google/android/play/core/integrity/model/StandardIntegrityErrorCode.html#PLAY_STORE_NOT_FOUND).",
        failure_detail: "[qdb0.j(SourceFile:9), g4n.a(SourceFile:85), f4n.invokeSuspend(SourceFile:14), kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(SourceFile:5), qni.run(SourceFile:104), fnf.run(SourceFile:112)]"
      }
    })
  }
  if (isAuthorized) headers.Authorization = auth.authorization || `Bearer ${auth.token}`

  const body = {
    action: 'next',
    messages: [{
      id: crypto.randomUUID(), author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] },
      status: 'finished_successfully', recipient: 'all'
    }],
    model: 'auto',
    history_and_training_disabled: false,
    fork_from_shared_post: false,
    enable_message_followups: true,
    force_use_sse: true,
    force_use_search: null,
    force_paragen: false,
    supported_encodings: ['v1'],
    supports_buffering: true,
    timezone: 'Asia/Makassar',
    timezone_offset_min: -480,
    system_hints: [],
    is_onboarding_conversation: false,
    no_auth_ad_preferences: { personalization_enabled: true, history_enabled: true },
    client_prepare_state: 'none',
    stream: true
  }
  if (chatId) {
    body.conversation_id = chatId
    body.parent_message_id = auth.parentMessageId
  }

  const stream = await axios.post(`https://android.chat.openai.com${prefix}/f/conversation`, body, {
    headers, responseType: 'stream', timeout: 90000
  })

  return new Promise((resolve, reject) => {
    let text = '', buf = '', lastPath = null, lastOp = null, finalChatId = chatId, assistantId = null

    stream.data.on('data', chunk => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data: ') || t === 'data: [DONE]') continue
        try {
          const data = JSON.parse(t.substring(6))
          if (data.conversation_id) finalChatId = data.conversation_id
          const p = data.p !== undefined ? data.p : lastPath
          const o = data.o !== undefined ? data.o : lastOp
          if (data.p !== undefined) lastPath = data.p
          if (data.o !== undefined) lastOp = data.o

          if (o === 'add' && data.v?.message) {
            if (data.v.message.author?.role === 'assistant') {
              assistantId = data.v.message.id
              const parts = data.v.message.content?.parts
              if (parts?.[0]) text = parts[0]
            }
          } else if (o === 'patch' && Array.isArray(data.v)) {
            for (const op of data.v)
              if (op.o === 'append' && op.p?.startsWith('/message/content/parts/')) text += op.v
          } else if (o === 'append' && p?.startsWith('/message/content/parts/') && typeof data.v === 'string') {
            text += data.v
          }
        } catch {}
      }
    })
    stream.data.on('error', reject)
    stream.data.on('end', () => {
      if (assistantId) auth.parentMessageId = assistantId
      resolve({ response: cleanSpecialTags(text), chatId: finalChatId, auth })
    })
  })
}

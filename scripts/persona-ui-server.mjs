// Server untuk menguji UI tab Persona (public/profile.js) end-to-end dengan Playwright:
// MongoDB asli (mongodb-memory-server) + provider AI tiruan (axios adapter), kode backend 100% asli.
// Jalankan: node scripts/persona-ui-server.mjs [port]  — token login demo dicetak ke stdout.
// Akun demo otomatis dibuat: username "ujiui", password "rahasia123".
import axios from 'axios'

process.env.MONGODB_DB = 'neyhra-ui-test'
const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\ndata: [DONE]\n'
axios.defaults.adapter = async config => {
  const url = String(config.url || '')
  if (url.includes('/sentinel/chat-requirements')) return { status: 200, statusText: 'OK', headers: { 'set-cookie': ['oai-sc=tok123; Path=/'] }, data: { token: 'tok123' } }
  if (url.includes('/f/conversation')) {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough()
    const prompt = JSON.parse(config.data).messages[0].content.parts[0]
    const text = prompt.includes('Ringkas obrolan') ? '<title>R</title><body>B</body>' : '<id>Halo! Ini balasan tiruan.</id>'
    queueMicrotask(() => {
      stream.write(sse({ conversation_id: 'c' + Date.now(), o: 'add', p: '/message', v: { message: { author: { role: 'assistant' }, id: 'm' + Date.now(), content: { parts: [text] } } } }))
      stream.end()
    })
    return { status: 200, statusText: 'OK', headers: {}, data: stream }
  }
  throw new Error('request tak terduga: ' + url)
}

const { MongoMemoryServer } = await import('mongodb-memory-server')
const mongod = await MongoMemoryServer.create()
process.env.MONGODB_URI = mongod.getUri('neyhra-ui-test')

const { default: app } = await import('../lib/app.js')
const port = Number(process.argv[2]) || 4573
const server = app.listen(port, async () => {
  console.log(`server UI test persona: http://127.0.0.1:${port}`)
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ujiui', password: 'rahasia123' }) }).then(x => x.json()).catch(() => ({}))
  console.log('akun demo:', r.ok ? 'ujiui / rahasia123 siap' : JSON.stringify(r))
})
const stop = async () => { server.close(); await mongod.stop(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)

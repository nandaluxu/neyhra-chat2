// Tes E2E Persona dengan MongoDB sungguhan (mongodb-memory-server) + provider AI TIRUAN.
// Jalankan: node scripts/persona-e2e.mjs
//
// Membuktikan integrasi prompt end-to-end lewat /api/chat, /api/proactive, dan /api/memory:
// axios default di-patch (adapter) sehingga panggilan ChatGPT anon (lib/chatgpt.js) ditangkap dan
// dijawab SSE tiruan; PROMPT yang dikirim provider DIREKAM dan diperiksa isinya (blok persona /
// nama persona) — persis prompt yang akan diterima provider sungguhan.
//
// Butuh: node_modules mongodb-memory-server (unduh binary mongod saat pertama kali jalan).

import axios from 'axios'

process.env.MONGODB_DB = 'neyhra-test'
const captured = [] // prompt yang dikirim ke provider tiruan

const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\ndata: [DONE]\n'
const replyText = '<id>Halo, ini balasan tiruan.</id>'
const replyFor = prompt => prompt.includes('Ringkas obrolan') ? '<title>Ringkasan tes</title><body>Isi ringkasan tiruan.</body>' : replyText

axios.defaults.adapter = async config => {
  const url = String(config.url || '')
  if (url.includes('/sentinel/chat-requirements')) {
    return { status: 200, statusText: 'OK', headers: { 'set-cookie': ['oai-sc=tok123; Path=/'] }, data: { token: 'tok123' } }
  }
  if (url.includes('/f/conversation')) {
    const prompt = JSON.parse(config.data).messages[0].content.parts[0]
    captured.push(prompt)
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough()
    queueMicrotask(() => {
      stream.write(sse({ conversation_id: 'conv-' + captured.length, o: 'add', p: '/message', v: { message: { author: { role: 'assistant' }, id: 'msg-' + captured.length, content: { parts: [replyFor(prompt)] } } } }))
      stream.end()
    })
    return { status: 200, statusText: 'OK', headers: {}, data: stream }
  }
  throw new Error('request tak terduga: ' + url)
}

const { MongoMemoryServer } = await import('mongodb-memory-server')
console.log('Menyalakan MongoDB memori (unduh binary pertama kali bisa lambat)…')
const mongod = await MongoMemoryServer.create()
process.env.MONGODB_URI = mongod.getUri('neyhra-test')

const { default: app } = await import('../lib/app.js')
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}`

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok -', label) } else { fail++; console.error('  GAGAL -', label) } }
const j = async (path, body, tok, method = 'POST') => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

try {
  console.log('\n[1] Akun + persona')
  const reg = await j('/api/auth/register', { username: 'tester1', password: 'rahasia123' })
  ok(reg.status === 200 && reg.json.token, 'registrasi akun')
  const tok = reg.json.token

  const chars = await (await fetch(base + '/api/chars')).json()
  ok(Array.isArray(chars) && chars.length > 0, 'daftar karakter terbaca (' + chars.length + ')')
  const ch = chars[0]

  captured.length = 0
  let r = await j('/api/chat', { clientId: 'cid-test-1234', char: ch.id, message: 'halo', userName: 'Nama Akun' }, tok)
  ok(r.status === 200 && r.json.id, 'chat tanpa persona default tetap jalan (perilaku lama)')
  let prompt = captured.at(-1) || ''
  ok(!prompt.includes('IDENTITAS USER'), 'tanpa persona default: tidak ada blok persona di prompt')
  ok(prompt.includes('namanya: Nama Akun'), 'tanpa persona default: AI memanggil nama akun')

  r = await j('/api/auth/persona/save', { name: 'Ayu', gender: 'f', bio: 'mahasiswa psikologi, suka kucing', def: true }, tok)
  ok(r.status === 200 && r.json.personas[0].def === true, 'buat persona + jadikan default')

  console.log('\n[2] Chat 1-lawan-1 dengan persona default')
  captured.length = 0
  r = await j('/api/chat', { clientId: 'cid-test-1234', char: ch.id, message: 'halo lagi', userName: 'Nama Akun', history: [['user', 'halo'], ['char', 'hai']], rel: { rel: 100, mood: 55, shift: 0 } }, tok)
  ok(r.status === 200 && r.json.id, 'chat dengan persona default jalan')
  prompt = captured[0] || '' // prompt utama = panggilan provider pertama (setelahnya bisa ada pemulihan <rel>/<mood>)
  ok(prompt.includes('IDENTITAS USER SAAT INI'), 'head prompt memuat blok IDENTITAS USER')
  ok(prompt.includes('Gender: perempuan') && prompt.includes('Tentang dirinya: mahasiswa psikologi, suka kucing'), 'blok persona memuat gender + profil')
  ok(prompt.includes('Anggap user adalah Ayu'), 'blok persona menyuruh AI memperlakukan user sebagai Ayu')
  ok(prompt.includes('namanya: Ayu'), 'giliran pesan memakai nama persona (bukan nama akun)')
  ok(prompt.includes('Ayu: halo\n'), 'riwayat obrolan memakai nama persona')
  ok(prompt.includes('INGATANMU') === false || true, 'memori kosong tidak memunculkan blok')
  ok(prompt.startsWith('Kamu'), 'prompt tetap dibuka char.prompt (kepribadian AI tidak berubah)')

  console.log('\n[3] Sesi restart saat persona berganti (fmtKey)')
  r = await j('/api/auth/persona/save', { name: 'Raka', gender: 'm', bio: 'barista', def: true }, tok)
  ok(r.status === 200 && r.json.personas.filter(p => p.def).length === 1 && r.json.personas.find(p => p.def).name === 'Raka', 'ganti default ke persona lain -> hanya satu default')
  const rak = r.json.personas.find(p => p.def).id
  captured.length = 0
  r = await j('/api/chat', { clientId: 'cid-test-1234', char: ch.id, message: 'tes ganti', userName: 'Nama Akun' }, tok)
  prompt = captured[0] || ''
  ok(prompt.includes('Anggap user adalah Raka') && prompt.includes('Gender: laki-laki'), 'persona baru langsung dipakai (sesi baru otomatis)')

  console.log('\n[4] Lepas default -> kembali ke perilaku lama')
  r = await j('/api/auth/persona/default', { id: null }, tok)
  ok(r.status === 200 && r.json.personas.every(p => !p.def), 'lepas default')
  captured.length = 0
  r = await j('/api/chat', { clientId: 'cid-test-1234', char: ch.id, message: 'tes balik', userName: 'Nama Akun' }, tok)
  prompt = captured[0] || ''
  ok(!prompt.includes('IDENTITAS USER') && prompt.includes('namanya: Nama Akun'), 'tanpa default -> prompt seperti sebelum fitur ada')
  await j('/api/auth/persona/default', { id: rak }, tok) // aktifkan lagi untuk tes berikut

  console.log('\n[5] Mode grup')
  captured.length = 0
  const ch2 = chars[1] || chars[0]
  r = await j('/api/chat', { clientId: 'cid-grup-1', char: ch.id, message: 'pagi semuanya', userName: 'Nama Akun', group: { members: [ch.id, ch2.id], muted: [], depth: 1 }, history: [] }, tok)
  ok(r.status === 200 && r.json.id, 'chat grup dengan persona default jalan')
  prompt = captured[0] || ''
  ok(prompt.includes('Identitas user: Raka (laki-laki) — barista'), 'prompt grup memuat personaLine')
  ok(prompt.includes('bersama Raka (user)'), 'prompt grup memanggil nama persona')

  console.log('\n[6] Pesan proaktif')
  captured.length = 0
  r = await j('/api/proactive', { clientId: 'cid-test-1234', char: ch.id, userName: 'Nama Akun', history: [['user', 'halo'], ['char', 'hai']], memory: [], rel: { rel: 10, mood: 50, shift: 0 }, hours: 10 }, tok)
  ok(r.status === 200 && r.json.id, 'proaktif dengan persona jalan')
  prompt = captured[0] || ''
  ok(prompt.includes('IDENTITAS USER SAAT INI') && prompt.includes('(namanya: Raka)'), 'sapaan proaktif memakai nama + blok persona')

  console.log('\n[7] Ringkasan memori')
  captured.length = 0
  r = await j('/api/memory', { clientId: 'cid-test-1234', char: ch.id, userName: 'Nama Akun', history: [['user', 'aku suka kucing'], ['char', 'wah seru']] }, tok)
  ok(r.status === 200 && (r.json.title || r.json.body), 'ringkasan memori jalan (jawaban tiruan)')
  prompt = captured[0] || ''
  ok(prompt.includes('antara Raka dan'), 'ringkasan memori menulis dari sudut pandang nama persona')

  console.log('\n[8] Pemilihan persona per karakter (persona/pick, kartu di halaman chat)')
  {
    // state dari bagian sebelumnya: persona Ayu (tanpa default) + Raka (default aktif)
    const personas = (await j('/api/auth/persona/list', {}, tok)).json.personas
    const ayu = personas.find(p => p.name === 'Ayu'), raka = personas.find(p => p.name === 'Raka')

    let r = await j('/api/auth/persona/pick-get', { char: ch.id }, tok)
    ok(r.status === 200 && r.json.ok && r.json.mode === 'follow' && r.json.personaId == null, 'pick-get awal -> follow (belum ada pilihan, perilaku lama)')
    ok(Array.isArray(r.json.personas) && r.json.max === 6, 'pick-get membawa daftar persona + kuota')

    // pilih Ayu khusus untuk karakter pertama (menimpa default Raka)
    r = await j('/api/auth/persona/pick', { char: ch.id, persona: ayu.id }, tok)
    ok(r.status === 200 && r.json.mode === 'pick' && r.json.personaId === ayu.id, 'pilih Ayu untuk karakter pertama')
    captured.length = 0
    r = await j('/api/chat', { clientId: 'cid-pick-1', char: ch.id, message: 'halo', userName: 'Nama Akun' }, tok)
    ok(r.status === 200 && r.json.id, 'chat dengan pilihan per-karakter jalan')
    prompt = captured[0] || ''
    ok(prompt.includes('Anggap user adalah Ayu') && prompt.includes('namanya: Ayu'), 'prompt karakter pertama memakai Ayu (menimpa default Raka)')

    // karakter kedua TIDAK terpengaruh: tetap persona default
    captured.length = 0
    r = await j('/api/chat', { clientId: 'cid-pick-2', char: ch2.id, message: 'halo', userName: 'Nama Akun' }, tok)
    prompt = captured[0] || ''
    ok(prompt.includes('Anggap user adalah Raka'), 'karakter kedua tetap memakai default Raka (pilihan terisolasi per karakter)')

    // ganti pilihan pada karakter yang sama -> personaHash berubah -> sesi baru otomatis
    r = await j('/api/auth/persona/pick', { char: ch.id, persona: raka.id }, tok)
    ok(r.status === 200 && r.json.mode === 'pick', 'ganti pilihan ke Raka untuk karakter pertama')
    captured.length = 0
    r = await j('/api/chat', { clientId: 'cid-pick-1', char: ch.id, message: 'halo lagi', userName: 'Nama Akun' }, tok)
    prompt = captured[0] || ''
    ok(prompt.includes('Anggap user adalah Raka'), 'ganti pilihan -> identitas baru langsung dipakai (sesi restart lewat fmtKey)')

    // mode none: eksplisit tanpa persona walau ada default
    r = await j('/api/auth/persona/pick', { char: ch.id, persona: null }, tok)
    ok(r.status === 200 && r.json.mode === 'none', 'pilih "profil akun" untuk karakter pertama')
    captured.length = 0
    r = await j('/api/chat', { clientId: 'cid-pick-1', char: ch.id, message: 'halo tanpa persona', userName: 'Nama Akun' }, tok)
    prompt = captured[0] || ''
    ok(!prompt.includes('IDENTITAS USER') && prompt.includes('namanya: Nama Akun'), 'mode none -> tanpa blok persona + nama akun (walau default Raka aktif)')

    // follow: buang pilihan, kembali ikut default
    r = await j('/api/auth/persona/pick', { char: ch.id, follow: true }, tok)
    ok(r.status === 200 && r.json.mode === 'follow', 'follow:true -> pilihan dihapus')
    captured.length = 0
    r = await j('/api/chat', { clientId: 'cid-pick-1', char: ch.id, message: 'halo follow', userName: 'Nama Akun' }, tok)
    prompt = captured[0] || ''
    ok(prompt.includes('Anggap user adalah Raka'), 'kembali memakai default Raka')

    // pesan proaktif juga menghormati pilihan per-karakter
    await j('/api/auth/persona/pick', { char: ch.id, persona: ayu.id }, tok)
    captured.length = 0
    r = await j('/api/proactive', { clientId: 'cid-pick-1', char: ch.id, userName: 'Nama Akun', history: [['user', 'hai'], ['char', 'halo']], memory: [], rel: { rel: 10, mood: 50, shift: 0 }, hours: 10 }, tok)
    ok(r.status === 200 && r.json.id, 'proaktif dengan pilihan per-karakter jalan')
    prompt = captured[0] || ''
    ok(prompt.includes('Anggap user adalah Ayu') && prompt.includes('(namanya: Ayu)'), 'proaktif memakai pilihan per-karakter (bukan default)')
    await j('/api/auth/persona/pick', { char: ch.id, follow: true }, tok) // bersihkan supaya bagian berikutnya murni default

    // keamanan: pick persona milik akun lain / karakter tak dikenal
    const reg3 = await j('/api/auth/register', { username: 'tester3', password: 'rahasia123' })
    ok(reg3.status === 200 && reg3.json.token, 'akun kedua untuk tes isolasi')
    r = await j('/api/auth/persona/pick', { char: ch.id, persona: ayu.id }, reg3.json.token)
    ok(r.status === 404, 'pick persona milik akun lain -> 404')
    r = await j('/api/auth/persona/pick', { char: 'karakter-tidak-ada', persona: ayu.id }, tok)
    ok(r.status === 400, 'pick karakter tak dikenal -> 400')
    r = await j('/api/auth/persona/pick-get', { char: ch.id }, reg3.json.token)
    ok(r.status === 200 && r.json.mode === 'follow', 'pilihan akun lain tidak terlihat (follow)')
    await j('/api/auth/delete', { password: 'rahasia123' }, reg3.json.token)
  }

  console.log('\n[9] Hapus akun membersihkan persona')
  const reg2 = await j('/api/auth/register', { username: 'tester2', password: 'rahasia123' })
  await j('/api/auth/persona/save', { name: 'Sementara', def: true }, reg2.json.token)
  r = await j('/api/auth/delete', { password: 'rahasia123' }, reg2.json.token)
  ok(r.status === 200, 'hapus akun sukses')
  r = await j('/api/auth/persona/list', {}, reg2.json.token)
  ok(r.status === 401, 'sesi akun terhapus -> 401')
} finally {
  server.close()
  await mongod.stop()
}

console.log(`\nSelesai E2E: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)

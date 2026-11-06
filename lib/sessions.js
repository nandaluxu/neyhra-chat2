import crypto from 'node:crypto'
import { chatgpt, getSession } from './chatgpt.js'
import { lorka, getLorkaSession } from './lorka.js'
import { SCORE_RULES, stateBlock } from './relation.js'

// Server dibuat stateless supaya aman di Vercel (serverless): riwayat obrolan disimpan di browser user
// dan dikirim tiap request. Sesi ChatGPT yang masih "hangat" tetap dipakai ulang kalau instance-nya sama.
// Sesi anon ChatGPT hanya bertahan ~1 jam -> diperbarui otomatis di 50 menit.
const TTL = 50 * 60 * 1000
// Mesin AI. ChatGPT = utama (bawaan). Lorka = alternatif khusus uji dari Mode dev, hanya untuk chat 1-lawan-1.
const ENGINES = { chatgpt: { chat: chatgpt, session: getSession }, lorka: { chat: lorka, session: getLorkaSession } }
const sessions = new Map()

const TAGS = '[laughing] [chuckling] [whisper] [soft] [sad] [excited] [angry] [surprised] [sigh] [gasp] [pause] [emphasis] [shouting]'

const pronounceRules = (char, withVn) => char.pronounce
  ? `\n- Pelafalan nama (wajib di <jp>${withVn ? ' dan <vn>' : ''}): ` + Object.entries(char.pronounce).map(([k, v]) => `${k} → ${v}`).join(', ') + '.'
  : ''

const userRule = user => user
  ? `\nNAMA USER: ${user}. Panggil dengan nama itu sesekali saja secara natural (jangan di setiap kalimat).`
  : ''

// Mode grup: blok <next> opsional di akhir. Model hanya mengusulkan, client + server yang memutuskan (lihat design: Prompt dan field next).
const NEXT_LINE = '\n<next>id anggota grup yang sebaiknya bicara berikutnya, atau kosong</next>'
const nextRules = group => group ? `
- <next> BUKAN bagian balasan ke user. Isi dengan SATU id dari daftar anggota yang boleh dipilih (${group.ids.join(', ')}), tanpa nama lain dan tanpa penjelasan. Jangan menunjuk user.
- Isi <next> hanya kalau ada yang ditanya langsung, dibantah, dipancing, atau memang pantas menanggapi balasanmu. Kosongkan (<next></next>) kalau obrolan sudah selesai atau tidak ada yang perlu menyahut.
- Boleh menunjuk dirimu sendiri HANYA kalau benar-benar ada lanjutan yang masuk akal (koreksi, menambahkan, atau menjawab sela dari karakter lain).` : ''

const SCORE_LINES = '\n<rel>perubahan kedekatan, angka</rel>\n<mood>perubahan suasana hati, angka</mood>'
const ONE_ID = '\n- Seluruh balasan, termasuk kalau lebih dari satu paragraf, ditulis di DALAM satu pasang <id>...</id> (jangan membuat <id> baru per paragraf, jangan menulis di luar blok).'

const formatRules = (char, user, voice, group, rel) => {
  if (!voice.on) return `ATURAN FORMAT (wajib di setiap balasan):
Balas HANYA dengan ${group ? 'dua blok ini, berurutan' : rel ? 'tiga blok ini, berurutan' : 'satu blok ini'}, tanpa teks apa pun di luar blok:
<id>balasanmu dalam bahasa Indonesia, untuk chat teks</id>${group ? NEXT_LINE : ''}${rel ? SCORE_LINES : ''}${ONE_ID}
- Tanpa tag dalam kurung siku, tanpa tanda bintang atau deskripsi aksi.
- Jaga singkat dan natural seperti chat (${group ? '1-2' : '1-4'} kalimat).${userRule(user)}${nextRules(group)}${rel ? '\n' + SCORE_RULES : ''}`

  const jp = voice.lang === 'jp'
  return `ATURAN FORMAT (wajib di setiap balasan):
Balas HANYA dengan ${group ? 'empat' : rel ? 'lima' : 'tiga'} blok ini, berurutan, tanpa teks apa pun di luar blok:
<id>balasanmu dalam bahasa Indonesia, untuk chat teks</id>
<jp>balasan yang sama dalam bahasa Jepang lisan yang natural, untuk subtitle</jp>
<vn>balasan yang sama dalam ${jp ? 'bahasa Jepang' : 'bahasa Indonesia'} versi ucapan, untuk voice note, dengan tag ekspresi</vn>${group ? NEXT_LINE : ''}${rel ? SCORE_LINES : ''}${ONE_ID}
- Ketiga blok <id>, <jp>, <vn> bermakna sama dan tetap sesuai karakter (bukan terjemahan kaku). Jaga singkat dan natural seperti chat (${group ? '1-2' : '1-4'} kalimat).
- <id> dan <jp> harus polos: tanpa tag kurung siku, tanpa emoji, tanpa tanda bintang atau deskripsi aksi.
- <vn> = ${jp ? 'isi <jp> yang diperkaya tag ekspresi. Tanpa romaji (kecuali kata seru, lihat aturan di bawah), tanpa emoji.' : 'isi <id> dalam gaya lisan yang natural (bukan bahasa tulis baku), diperkaya tag ekspresi. Tanpa emoji.'}
- TAG EKSPRESI (HANYA di <vn>): ditulis dalam kurung siku, bahasa Inggris, diletakkan TEPAT sebelum kata yang mau dipengaruhi. Pilihan utama: ${TAGS}. Boleh tag bebas singkat yang lain, misalnya [whispering sweetly] atau [laughing nervously]. Jeda pendek: (break), tarikan napas: (breath).
- Pakai seperlunya: 0-3 tag per balasan, balasan yang netral tidak perlu tag. Maksimal 2 tag bertumpuk, jangan membuka tiap balasan dengan tag, dan sesuaikan dengan emosi di balasan.
- Tag berlaku untuk kata setelahnya sampai tag berikutnya. Untuk mengatur hanya beberapa kata terpilih, taruh tag di depan kata itu lalu kembalikan dengan [normal voice].
- Contoh <vn>: ${jp
    ? '"[sad] ……そう、なんだ。(break) [whisper] でも、ありがとう [normal voice] ほんとに。"'
    : '"Hmph, [whisper] sebenarnya aku senang kamu datang [normal voice] tapi jangan GR ya! [laughing] Hehe."'}${jp ? `
- Kata seru atau efek suara (dengusan, decak, dll) HANYA ditulis kalau memang muncul alami di <id>. Jangan menambah kata seru yang tidak ada di <id>, dan jangan membuka tiap balasan dengan kata seru. Kalau ada di <id>, JANGAN diterjemahkan ke Jepang (bukan ふん, ちっ, あはは, dll), salin persis tetap huruf latin di posisi yang sama, di <jp> maupun <vn>. Contoh: <id> "Tch, ya sudahlah." → <jp> "Tch, まあいいわ。". Ini pengecualian dari aturan "tanpa romaji".
- TAWA: kalau di <id> ada tawa tulis (wkwk, haha, hehe, dll), di <jp> ganti jadi tawa Jepang yang natural (あはは, ふふ, dll). Di <vn> tulis tag [laughing] (tawa lepas) atau [chuckling] (tawa kecil) tepat sebelum tawanya, lalu tawanya ditulis sebagai suara, bukan huruf (id: "Haha", "Hehe"; jp: "あはは", "ふふ"). JANGAN menulis "wkwk" di <vn>. Ini pengecualian dari aturan kata seru di atas.
- Di <jp> dan <vn>, semua nama orang/karakter (termasuk nama user) tulis dalam katakana, jangan pakai kanji atau huruf latin, supaya suara tidak salah baca.` : `
- Di <jp>, semua nama orang/karakter (termasuk nama user) tulis dalam katakana, jangan pakai kanji atau huruf latin. Di <id> dan <vn> nama ditulis biasa.`}${pronounceRules(char, jp)}${userRule(user)}${nextRules(group)}${rel ? '\n' + SCORE_RULES : ''}`
}

const remind = (voice, rel) => voice.on
  ? `[Ingat: balas hanya dengan format <id>...</id><jp>...</jp><vn>...</vn>${rel ? '<rel>...</rel><mood>...</mood>' : ''}; semua paragraf di dalam satu <id>; tag ekspresi hanya di <vn>, suara ${voice.lang === 'jp' ? 'Jepang' : 'Indonesia'}]`
  : `[Ingat: balas hanya dengan format <id>...</id>${rel ? '<rel>...</rel><mood>...</mood>' : ''}; semua paragraf di dalam satu <id>]`

// ambil isi satu blok; berhenti di penutupnya, di awal blok lain, atau di akhir teks
const TAGS_ALL = 'id|jp|vn|next|title|body|rel|mood'
const block = (raw, tag) =>
  (raw.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|<(?:${TAGS_ALL})>|$)`, 'i'))?.[1] || '').trim()
// Balasan <id> TIDAK boleh cuma blok pertama: model kadang menulis satu <id> per paragraf, atau menutup </id> lalu lanjut menulis
// di luar tag. Jadi <id> = semuanya dari <id> pertama sampai blok lain (<jp>/<vn>/<next>/<rel>/<mood>) pertama; tag <id> di dalamnya dibuang
// dan jeda paragraf dipertahankan.
const idText = raw => {
  const s = raw.search(/<id>/i); if (s < 0) return ''
  const rest = raw.slice(s), e = rest.search(/<(?:jp|vn|next|rel|mood|title|body)>/i)
  return (e < 0 ? rest : rest.slice(0, e)).replace(/<\/id>\s*<id>/gi, '\n\n').replace(/<\/?id>/gi, '').trim()
}
// <jp> dan <vn> sama: kalau muncul lebih dari sekali, semuanya digabung
const multi = (raw, tag) => {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|(?=<(?:${TAGS_ALL})>)|$)`, 'gi')
  return [...raw.matchAll(re)].map(m => m[1].trim()).filter(Boolean).join(' ')
}
const parse = raw => ({ id: idText(raw), jp: multi(raw, 'jp'), vn: multi(raw, 'vn'), next: block(raw, 'next'), rel: block(raw, 'rel'), mood: block(raw, 'mood') })

const historyBlock = (history, char, user) => history.length
  ? 'Riwayat obrolan sebelumnya (lanjutkan secara natural):\n' +
    history.map(([r, t]) => `${r === 'user' ? (user || 'User') : char.name}: ${t}`).join('\n') + '\n\n'
  : ''

// Ingatan dari obrolan sebelumnya (sudah dibersihkan di app.js, urut terbaru dulu). Hanya masuk di `head`, jadi hash-nya ikut fmtKey.
const memBlock = (memory, user) => memory.length
  ? `INGATANMU TENTANG ${user || 'User'} (dari obrolan sebelumnya, urut dari yang terbaru):\n${memory.map(m => `- ${m.title}: ${m.body}`).join('\n')}\nAnggap ini kenanganmu sendiri. Pakai secara natural kalau relevan, jangan dibacakan ulang, dan jangan menyebut kata \"memori\" atau \"ringkasan\" kecuali user bertanya.\n\n`
  : ''
const memHash = memory => memory.length ? crypto.createHash('sha1').update(JSON.stringify(memory)).digest('hex').slice(0, 10) : ''

async function ask(s, char, message, fresh, user, history, voice, memory, rel) {
  const head = fresh ? `${char.prompt}\n\n${memBlock(memory, user)}${formatRules(char, user, voice, null, !!rel)}\n\n${historyBlock(history, char, user)}` : ''
  // nama ikut di setiap pesan, jadi kalau user ganti nama di tengah obrolan langsung terbaca
  if (process.env.DEBUG_RAW) console.log('[raw:in]', JSON.stringify(message))
  let r = await s.chat(`${head}${rel ? stateBlock(char, rel) + '\n\n' : ''}Pesan dari user${user ? ` (namanya: ${user})` : ''}: ${message}\n\n${remind(voice, !!rel)}`, s.auth, s.chatId)
  if (process.env.DEBUG_RAW) console.log('[raw:out]', JSON.stringify(r.response))
  s.chatId = r.chatId
  let out = parse(r.response)
  const complete = o => o.id && (!voice.on || (o.jp && o.vn))
  if (!complete(out)) {
    const fmt = (voice.on ? '<id>...</id><jp>...</jp><vn>...</vn>' : '<id>...</id>') + (rel ? '<rel>...</rel><mood>...</mood>' : '')
    r = await s.chat(`Formatmu salah. Ulangi balasanmu barusan persis dengan format ${fmt}.`, s.auth, s.chatId)
    s.chatId = r.chatId
    out = parse(r.response)
  }
  if (!out.id) throw new Error('Respons kosong')
  return out
}

async function run(s, char, message, user, history, voice, memory, rel, engine) {
  // format berubah (voice dinyalakan/dimatikan atau ganti bahasa) -> mulai sesi baru, riwayat tetap ikut dari client
  // memori berubah (baru dibuat / dihapus user) -> sesi dimulai ulang supaya blok INGATAN langsung berlaku
  const eng = ENGINES[engine?.name] || ENGINES.chatgpt
  const fmtKey = (voice.on ? `on:${voice.lang}` : 'off') + '|' + memHash(memory) + (rel ? '|rel' : '') + (eng === ENGINES.chatgpt ? '' : `|${engine.name}:${engine.model || ''}`) // ganti mesin/model -> sesi baru
  const valid = s.auth && s.chatId && s.fmt === fmtKey && Date.now() - s.startedAt < TTL
  for (let fresh = !valid; ; fresh = true) {
    try {
      if (fresh) { s.auth = await eng.session(engine?.model); s.chatId = null; s.startedAt = Date.now(); s.fmt = fmtKey }
      s.chat = eng.chat
      return await ask(s, char, message, fresh, user, history, voice, memory, rel)
    } catch (e) {
      if (fresh) throw e // sesi lama gagal (expired/404) -> ulang sekali dengan sesi baru
    }
  }
}

export function reply(clientId, char, message, { user = '', history = [], voice = { on: false }, memory = [], rel = null, engine = null } = {}) {
  const key = `${clientId}:${char.id}`
  const s = sessions.get(key) || { auth: null, chatId: null, startedAt: 0, fmt: '', q: Promise.resolve() }
  sessions.set(key, s)
  s.seen = Date.now()
  const job = s.q.then(() => run(s, char, message, user, history, voice, memory, rel, engine)) // antrian per chat, cegah balapan parentMessageId
  s.q = job.catch(() => {})
  return job
}

setInterval(() => {
  for (const [k, s] of sessions) if (Date.now() - s.seen > 12 * 3600 * 1000) sessions.delete(k)
}, 3600 * 1000).unref()

/* ===== Mode grup =====
   Satu request = satu karakter bicara. Selalu percakapan ChatGPT baru + riwayat grup lengkap dari client (tidak ada sesi per karakter).
   Yang dipakai ulang cuma `auth` (cookie anon) per client supaya tidak minta sesi baru tiap giliran. */
const gAuth = new Map() // clientId -> { base, startedAt, seen }
async function authFor(clientId, fresh) {
  let e = gAuth.get(clientId)
  if (fresh || !e || Date.now() - e.startedAt > TTL) { e = { base: await getSession(), startedAt: Date.now() }; gAuth.set(clientId, e) }
  e.seen = Date.now()
  return { ...e.base } // salinan, supaya parentMessageId satu giliran tidak menimpa giliran lain
}

// satu baris sifat untuk daftar anggota: field `trait` kalau ada, kalau tidak diambil dari "Kepribadian:" di prompt, terakhir tagline
const traitOf = c => {
  const one = t => String(t || '').replace(/\s+/g, ' ').replace(/^[*\-•\s]+/, '').trim()
  if (c.trait) return one(c.trait).slice(0, 110)
  const m = String(c.prompt || '').match(/Kepribadian[^:\n]*:\s*([\s\S]{0,400})/)
  const t = one(m?.[1])
  if (t) { const cut = t.search(/[.!?](\s|$)/); return (cut > 0 && cut < 110 ? t.slice(0, cut) : t.slice(0, 110).replace(/\s\S*$/, '')).trim() }
  return one(c.tagline)
}

const groupPrompt = (char, { members, allowed, scene, replyTo, depth, user, history, message, voice }) => {
  const me = user || 'User'
  const others = members.filter(m => m.id !== char.id)
  const rel = others.map(m => [m, char.relations?.[m.id]]).filter(([, r]) => typeof r === 'string' && r.trim()) // hanya relasi dengan anggota yang hadir
  const lines = history.map(([who, text]) => `${who}: ${text}`)
  // pesan user terakhir sudah ada di riwayat dari client; kalau belum, tambahkan di ujung
  if (message && !history.some(([who, t]) => who === me && t === message.slice(0, 600))) lines.push(`${me}: ${message.slice(0, 600)}`)
  const turn = replyTo
    ? `Giliran ini: kamu (${char.name}) diminta menanggapi ${replyTo.name}: "${replyTo.text}"`
    : message
      ? `Giliran ini: kamu (${char.name}) membalas pesan terbaru dari ${me}.`
      : `Giliran ini: kamu (${char.name}) membuka atau melanjutkan obrolan antar anggota secara natural (tidak ada pesan baru dari ${me}).`
  return `${char.prompt}

KONTEKS GRUP:
Kamu berada di grup chat bersama ${me} (user) dan karakter lain. Kamu adalah ${char.name} (id: ${char.id}). Hanya bicara sebagai dirimu sendiri, jangan menulis ucapan karakter lain.${scene ? `\nScene: ${scene}` : ''}
Anggota grup:
${members.map(m => `- ${m.id} (${m.name}) – ${traitOf(m)}`).join('\n')}${rel.length ? `\nHubunganmu dengan anggota lain:\n${rel.map(([m, r]) => `- ${m.name}: ${String(r).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200)}`).join('\n')}` : ''}

ATURAN BICARA GRUP:
- Balas 1-2 kalimat. Jangan mengulang yang sudah dikatakan orang lain.
- Boleh menanggapi karakter lain langsung dengan menyebut namanya.
- Tanpa narasi atau deskripsi aksi (misalnya *mendengus*). Roleplay lewat ucapan dan sikap saja.${depth >= 2 ? '\n- Obrolan sudah berjalan beberapa giliran. Kalau terasa selesai, kosongkan <next>.' : ''}

${formatRules(char, user, voice, { ids: allowed })}

${lines.length ? `Riwayat obrolan grup (lanjutkan secara natural):\n${lines.join('\n')}\n\n` : ''}${turn}

[Ingat: balas hanya dengan format <id>...</id>${voice.on ? '<jp>...</jp><vn>...</vn>' : ''}<next>...</next>; kamu ${char.name}]`
}

async function askGroup(s, prompt, voice) {
  let r = await chatgpt(prompt, s.auth, null)
  s.chatId = r.chatId
  let out = parse(r.response)
  if (!(out.id && (!voice.on || (out.jp && out.vn)))) { // <next> opsional: tidak ada di sini, jadi tidak memicu retry
    const fmt = voice.on ? '<id>...</id><jp>...</jp><vn>...</vn><next>...</next>' : '<id>...</id><next>...</next>'
    r = await chatgpt(`Formatmu salah. Ulangi balasanmu barusan persis dengan format ${fmt}.`, s.auth, s.chatId)
    out = parse(r.response)
  }
  if (!out.id) throw new Error('Respons kosong')
  return out
}

export async function groupReply(clientId, char, opts) {
  const prompt = groupPrompt(char, opts)
  for (let fresh = false; ; fresh = true) {
    try { return await askGroup({ auth: await authFor(clientId, fresh), chatId: null }, prompt, opts.voice) }
    catch (e) { if (fresh) throw e } // auth lama gagal -> ulang sekali dengan sesi anon baru
  }
}

setInterval(() => {
  for (const [k, e] of gAuth) if (Date.now() - e.seen > 12 * 3600 * 1000) gAuth.delete(k)
}, 3600 * 1000).unref()

/* ===== Memori: ringkas bagian lama obrolan 1-lawan-1 =====
   Server tidak menyimpan apa pun. Percakapan ChatGPT baru tiap kali (pola groupReply), balasan = { title, body } mentah.
   `tidy` (dari app.js) merapikan hasil; kalau body-nya kosong, retry sekali dengan pesan format. */
const summaryPrompt = (char, user, history) => `Ringkas obrolan berikut antara ${user} dan ${char.name} untuk disimpan sebagai ingatan.
- Fokus pada fakta yang berguna nanti: hal yang diceritakan ${user}, janji, preferensi, kejadian penting, dan perubahan hubungan/suasana.
- Abaikan basa-basi. Jangan mengarang. Jangan menyalin dialog.
- Tulis 2-4 kalimat, bahasa Indonesia, orang ketiga ("${user} bercerita bahwa ...").
Balas HANYA dengan format ini:
<title>judul singkat maksimal 40 karakter</title>
<body>ringkasan</body>

Obrolan:
${history.map(([r, t]) => `${r === 'user' ? user : char.name}: ${t}`).join('\n')}`

export async function summarize(clientId, char, { user, history }, tidy) {
  const prompt = summaryPrompt(char, user || 'User', history)
  const once = async auth => {
    let r = await chatgpt(prompt, auth, null)
    let out = tidy({ title: block(r.response, 'title'), body: block(r.response, 'body') })
    if (!out.body) {
      r = await chatgpt('Formatmu salah. Ulangi ringkasanmu barusan persis dengan format <title>...</title><body>...</body>.', auth, r.chatId)
      out = tidy({ title: block(r.response, 'title'), body: block(r.response, 'body') })
    }
    if (!out.body) throw new Error('Respons kosong')
    return out
  }
  for (let fresh = false; ; fresh = true) {
    try { return await once(await authFor(clientId, fresh)) }
    catch (e) { if (fresh) throw e } // auth lama gagal -> ulang sekali dengan sesi anon baru
  }
}

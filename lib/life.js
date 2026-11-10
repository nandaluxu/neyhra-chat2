// Ritme hidup karakter: tiap karakter punya jam tidur sendiri yang diturunkan dari id-nya (hash), jadi TIDAK perlu
// mengubah file char/*.js satu per satu. Jadwalnya stabil (karakter yang sama selalu sama) dan beragam antar karakter.
// Dipakai di tiga tempat:
//   1. /api/chars (lib/app.js)  -> field `sleep: [mulai, selesai]` (jam desimal WIB) untuk status di client
//   2. /api/chat (lib/app.js)   -> lifeBlock masuk prompt kalau karakter sedang tidur/ngantuk/baru bangun
//   3. /api/proactive           -> karakter yang sedang tidur tidak mengirim pesan proaktif
// Waktu acuan = WIB (sama seperti pergantian hari Bonus di lib/bonus.js).

const hash53 = (str, seed = 0) => { // cyrb53, pola yang sama dengan GX.hash di public/group.js
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0, c; i < str.length; i++) { c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677) }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

// Jadwal tidur dari id karakter: mulai tidur 21:00-00:30, durasi 6,5-9,5 jam. Sebagian kecil karakter jadi "gadis/garong malam"
// (mulai 01:00-03:00, durasi lebih pendek) supaya grup karakter tidak seragam bunyi jam tidurnya.
export function scheduleOf(char) {
  const h = hash53(String(char?.id || ''))
  const night = (h % 100) < 12 // ±12% karakter: tipe begadang
  const start = night ? 1 + ((h >>> 8) % 100) / 100 * 2 : 21 + ((h >>> 8) % 100) / 100 * 3.5 // 21:00-00:30 / 01:00-03:00
  const dur = night ? 5.5 + ((h >>> 20) % 100) / 100 * 2 : 6.5 + ((h >>> 20) % 100) / 100 * 3
  return { start: Math.round(start * 100) / 100, end: Math.round(((start + dur) % 24) * 100) / 100 }
}

const inRange = (h, s, e) => s <= e ? (h >= s && h < e) : (h >= s || h < e) // rentang tidur bisa lewat tengah malam

// Keadaan karakter pada jam tertentu. h = jam desimal WIB (mis. 14,5 = 14:30).
// 'tidur' | 'baru bangun' (45 menit pertama setelah bangun) | 'ngantuk' (45 menit terakhir sebelum tidur) | 'bangun'
export function lifeState(char, h) {
  const { start, end } = scheduleOf(char)
  if (inRange(h, start, end)) return 'tidur'
  const wake = (end + 0.75) % 24
  if (inRange(h, end, wake)) return 'baru bangun'
  const drowsy = (start - 0.75 + 24) % 24
  if (inRange(h, drowsy, start)) return 'ngantuk'
  return 'bangun'
}

// Jam WIB sekarang sebagai desimal (server bisa di zona apa pun; Vercel default UTC).
export const wibHour = (now = Date.now()) => ((now / 3600e3 + 7) % 24)

const RULES = {
  tidur: 'Saat ini tengah malam dan kamu sedang TIDUR NYENYAK. Notifikasi chat dari user barusan membangunkanmu. Balas seperti orang yang baru terbangun: agak kacau, mata masih berat, pegal, menguap, mungkin sedikit kesal dibangunkan — atau justru senang ternyata user yang mengirim pesan — persis seperti kepribadianmu. Singkat (1-2 kalimat). Jangan menyebut jam berapa persisnya.',
  'baru bangun': 'Kamu baru bangun tidur beberapa menit yang lalu dan masih setengah sadar. Balasanmu agak pelan dan malas-malasan dulu sebelum sadar sepenuhnya, sesuai kepribadianmu. Jangan menyebut jam berapa persisnya.',
  ngantuk: 'Saat ini sudah malam dan kamu sudah sangat ngantuk, sebentar lagi kamu tidur. Balasanmu singkat, melepeh, sesekali menguap di tengah kalimat — tapi tetap kamu. Kalau obrolannya masih panjang, katakan kamu mau tidur dulu. Jangan menyebut jam berapa persisnya.'
}

// Blok untuk prompt (dipakai /api/chat). null = keadaan normal, tidak perlu blok apa pun.
export function lifeBlock(char, now = Date.now()) {
  const st = lifeState(char, wibHour(now))
  const rule = RULES[st]
  return rule ? `[KEADAANMU SEKARANG: ${rule}]` : null
}

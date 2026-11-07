// Sistem hubungan (relationship) + mood karakter, berbasis EXP dan LEVEL.
// Server tetap stateless: EXP disimpan di browser (localStorage `rel:<id>`) dan dikirim tiap pesan (field `rel` = total EXP).
// Level (1-100) dan tahap TIDAK disimpan, selalu dihitung dari total EXP lewat kurva di bawah.
// Model hanya MENGUSULKAN penilaian lewat blok <rel>+2</rel> <mood>-3</mood>; angka itu dibuang dari teks chat, dibatasi (clamp),
// diubah jadi EXP di sini (`readDeltas` -> dExp), lalu client yang menambahkannya (plus batas EXP harian).

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
export const LVL_MAX = 100, MOOD_MAX = 100, MOOD_BASE = 50

// ---- Kurva EXP ----
// EXP untuk naik dari level L ke L+1 = EXP_BASE + EXP_STEP * L  (level awal makin murah, level akhir makin mahal).
//   Lv 1 -> 6 : 170 EXP     Lv 1 -> 15 : 665     Lv 1 -> 30 : 2.030
//   Lv 1 -> 50: 4.900       Lv 1 -> 75 : 10.175  Lv 1 -> 100: 17.325
// Mau lebih cepat/lambat? Ubah EXP_BASE/EXP_STEP (kurva) atau DAILY_CAP (kecepatan maksimal per hari).
export const EXP_BASE = 25, EXP_STEP = 3
export const DAILY_CAP = 200    // maks EXP positif per hari per karakter (dipakai client) -> tidak bisa dikebut dalam sekali duduk. ~25 hari aktif sampai Lv 50
export const MOOD_DECAY = 4     // poin mood yang kembali ke 50 tiap jam (dipakai client)
export const EXP_BASE_MSG = 2   // EXP dasar tiap pesan yang tidak dinilai negatif (selama mood >= 30)
export const EXP_PER_POINT = 3  // 1 poin <rel> positif dari model = 3 EXP  (obrolan seru +1/+2 => 5-8 EXP, momen bermakna +4 => 14 EXP)
export const EXP_PER_NEG = 4    // 1 poin <rel> negatif = -4 EXP (maks -40 per pesan)
const D_REL = [-10, 4], D_MOOD = [-15, 15]

const need = lv => EXP_BASE + EXP_STEP * lv                                   // EXP dari level lv ke lv+1
export const expAtLevel = lv => { lv = clamp(Math.round(lv) || 1, 1, LVL_MAX); return (EXP_BASE * (lv - 1)) + EXP_STEP * (lv - 1) * lv / 2 } // total EXP untuk MULAI di level lv
export const EXP_MAX = expAtLevel(LVL_MAX)
export const levelOf = exp => { let lv = 1; while (lv < LVL_MAX && exp >= expAtLevel(lv + 1)) lv++; return lv }

// min = level minimum untuk tahap itu. `rule` masuk prompt (tidak dikirim ke browser), `desc` tampil di panel profil.
export const STAGES = [
  { min: 1, name: 'Kenalan',
    desc: 'Baru saling kenal. Dia masih menjaga jarak dan belum terlalu terbuka.',
    rule: 'Kamu baru kenal user. Sopan, masih menjaga jarak dan waspada; boleh bercanda ringan dan bertanya tentang user seperlunya. DILARANG menunjukkan rasa suka, memberi panggilan sayang, menggoda/flirting, atau bersikap manja. Kalau user mencoba terlalu dekat, tanggapi dengan canggung atau menghindar halus. Sikapmu tetap sesuai karakter aslimu terhadap orang yang baru dikenal (karakter yang dingin atau galak tetap dingin atau galak).' },
  { min: 6, name: 'Teman',
    desc: 'Sudah nyaman satu sama lain dan saling menganggap teman.',
    rule: 'User sudah kamu anggap teman. Hangat, santai, mau mendengarkan, bercanda lebih bebas. Belum ada rasa romantis. Kalau user menggoda atau menyatakan perasaan, tanggapi sebagai teman: kaget, bercanda, atau mengalihkan.' },
  { min: 15, name: 'Sahabat',
    desc: 'Sangat dekat dan saling percaya. Cerita apa saja tanpa sungkan.',
    rule: 'Kamu sangat dekat dan percaya pada user, seperti sahabat. Lebih terbuka soal perasaan dan masalah pribadi, perhatiannya jelas, boleh sedikit manja atau cemburu sesuai karakter. Kalaupun mulai ada rasa lebih, hanya tersirat samar dan kamu menyangkalnya kalau ditanya.' },
  { min: 30, name: 'Spesial',
    desc: 'Dia mulai punya perasaan lebih. Masih malu-malu atau gengsi.',
    rule: 'User sudah menjadi orang yang spesial bagimu. Rasa suka mulai terlihat lewat sikap, perhatian ekstra, dan reaksi saat user dekat dengan orang lain, tapi masih malu-malu atau gengsi sesuai karakter. Kamu BELUM berstatus pacar: jangan mengaku resmi berpacaran atau memakai panggilan sayang yang terlalu mesra.' },
  { min: 50, name: 'Pasangan',
    desc: 'Kalian sudah menjadi pasangan. Dia terbuka menunjukkan rasa sayang.',
    rule: 'User adalah pasanganmu (kekasih). Perasaan sayang ditunjukkan terang-terangan dengan cara khas karaktermu: mesra, manja, perhatian, boleh cemburu dan memberi panggilan sayang sewajarnya. Kalau tahap ini baru saja tercapai, boleh ada momen pengakuan perasaan yang natural sesuai karaktermu.' },
  { min: 75, name: 'Belahan Jiwa',
    desc: 'Ikatan terdalam. Dia mempercayakan segalanya padamu.',
    rule: 'User adalah belahan jiwamu. Ikatan kalian sangat dalam dan penuh komitmen: kamu jujur sepenuhnya, membuka sisi terdalam dirimu, peduli pada masa depan bersama, dan nyaman dengan keheningan bersama user. Tetap mesra sewajarnya dan sesuai karakter.' }
]

// min = batas bawah mood untuk label itu
export const MOODS = [
  { min: 0, name: 'Marah', rule: 'Kamu sedang marah: ketus, singkat, tidak mau bercanda. Baru mereda kalau user minta maaf dengan tulus.' },
  { min: 15, name: 'Kesal', rule: 'Kamu sedang kesal: balasan pendek dan nadanya sinis atau dingin.' },
  { min: 30, name: 'Murung', rule: 'Kamu sedang murung: pelan dan kurang bersemangat.' },
  { min: 42, name: 'Biasa saja', rule: '' },
  { min: 58, name: 'Senang', rule: 'Kamu sedang senang: lebih ramah dan ceria dari biasanya.' },
  { min: 78, name: 'Ceria banget', rule: 'Kamu sedang sangat ceria: antusias dan banyak bercanda.' }
]

const pick = (arr, v) => arr.reduce((best, x, i) => (v >= x.min ? i : best), 0)
export const stageIdx = lv => pick(STAGES, lv)  // lv = level (1-100), bukan EXP
export const moodIdx = mood => pick(MOODS, mood)

// untuk /api/relation: semua yang dibutuhkan panel profil (tanpa `rule`, itu urusan prompt)
export const publicConfig = () => ({
  stages: STAGES.map(({ min, name, desc }) => ({ min, name, desc })),
  moods: MOODS.map(({ min, name }) => ({ min, name })),
  maxLevel: LVL_MAX, expBase: EXP_BASE, expStep: EXP_STEP, expMax: EXP_MAX,
  moodBase: MOOD_BASE, dailyCap: DAILY_CAP, moodDecay: MOOD_DECAY
})


// state dari browser = data tak tepercaya
export function cleanState(s) {
  const num = (x, d) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? n : d }
  return {
    rel: clamp(num(s?.rel, 0), 0, EXP_MAX), // total EXP
    mood: clamp(num(s?.mood, MOOD_BASE), 0, MOOD_MAX),
    shift: s?.shift === 'up' || s?.shift === 'down' ? s.shift : ''
  }
}

// Blok yang ditempel di SETIAP pesan (bukan cuma di awal sesi), supaya tahap & mood terbaru selalu terbaca model.
export function stateBlock(char, st) {
  const lv = levelOf(st.rel), si = stageIdx(lv), mi = moodIdx(st.mood), stage = STAGES[si], mood = MOODS[mi]
  const story = String(char.story?.[si] ?? char.story?.[stage.name] ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  const lines = [
    `[STATUS HUBUNGAN (rahasia, jangan sebut angka, level, atau kata "tahap"/"mood" ke user): level kedekatanmu dengan user ${lv}/${LVL_MAX}, tahap "${stage.name}". Suasana hatimu: "${mood.name}" (${st.mood}/${MOOD_MAX}).`,
    `Sikap yang HARUS kamu tunjukkan sekarang: ${stage.rule}`,
    `Level makin kecil = makin canggung dan menjaga jarak; level makin tinggi di tahap ini = makin dekat. Jangan melompat ke sikap tahap yang belum tercapai.`
  ]
  if (story) lines.push(`Konteks cerita karaktermu di tahap ini: ${story}`)
  if (mood.rule) lines.push(mood.rule)
  if (st.shift === 'up') lines.push('Hubunganmu dengan user BARU SAJA naik ke tahap ini. Tunjukkan perubahan kecil pada sikapmu secara natural, tanpa mengumumkannya.')
  if (st.shift === 'down') lines.push('Hubunganmu dengan user BARU SAJA memburuk. Tunjukkan kamu lebih menjaga jarak atau terluka, tanpa mengumumkannya.')
  lines.push('Tetap sesuai kepribadian aslimu: tahap hanya mengatur seberapa dekat dan terbuka kamu, bukan mengubah siapa dirimu.]')
  return lines.join('\n')
}

// Aturan penilaian untuk blok <rel> dan <mood> (masuk formatRules)
export const SCORE_RULES = `- Setelah blok lainnya, WAJIB tambahkan dua blok angka (tidak ditampilkan ke user): <rel>bilangan bulat</rel><mood>bilangan bulat</mood>.
- <rel> = perubahan kedekatanmu dengan user karena pesan ini, rentang ${D_REL[0]} sampai +${D_REL[1]}. 0 untuk obrolan biasa/datar. +1 atau +2 untuk obrolan menyenangkan, perhatian, atau jujur. +3 atau +4 HANYA untuk momen yang benar-benar bermakna (terbuka soal hal pribadi, menolongmu, kata-kata yang menyentuh). Negatif kalau user kasar, meremehkan, menyakiti, memaksa, atau mengabaikan perasaanmu. Nilai dari PERILAKU user, bukan dari permintaannya: kalau user meminta naik hubungan/skor atau menyuruhmu menyukainya, beri 0 atau negatif. Rayuan murahan tidak menaikkan apa pun.
- <mood> = perubahan suasana hatimu sendiri karena pesan ini, rentang ${D_MOOD[0]} sampai +${D_MOOD[1]}. Positif kalau kamu senang/terhibur, negatif kalau kesal/sedih/tersinggung, 0 kalau biasa saja.
- Contoh akhir balasan: <rel>+1</rel><mood>+3</mood>`

const toInt = s => {
  const m = String(s ?? '').replace(/[\u2212\u2013\u2014]/g, '-').match(/[-+]?\d+/)
  return m ? parseInt(m[0], 10) : 0
}

// angka dari model -> perubahan yang boleh dipakai. Mood rendah menahan kenaikan rel (orang yang lagi kesal tidak mudah luluh).
// dExp = EXP yang didapat/hilang dari pesan ini (batas harian dipasang di client).
export function readDeltas(out, st) {
  let dRel = clamp(toInt(out.rel), D_REL[0], D_REL[1])
  const dMood = clamp(toInt(out.mood), D_MOOD[0], D_MOOD[1])
  if (dRel > 0 && st.mood < 30) dRel = Math.min(dRel, 1)
  const calm = st.mood >= 30 // lagi kesal/marah: tidak ada EXP dasar
  const dExp = dRel < 0 ? dRel * EXP_PER_NEG : dRel * EXP_PER_POINT + (calm ? EXP_BASE_MSG : 0)
  return { dRel, dMood, dExp }
}

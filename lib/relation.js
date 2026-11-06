// Sistem hubungan (relationship) + mood karakter.
// Server tetap stateless: angka disimpan di browser (localStorage `rel:<id>`) dan dikirim tiap pesan.
// Model hanya MENGUSULKAN perubahan lewat blok <rel>+2</rel> <mood>-3</mood> di balasannya; angka itu dibuang dari
// teks chat, dibatasi (clamp) di sini, lalu client yang menambahkannya ke skor (plus batas kenaikan harian).

export const REL_MAX = 100, MOOD_MAX = 100, MOOD_BASE = 50
export const DAILY_CAP = 15       // maks kenaikan rel per hari (dipakai client) -> hubungan tidak bisa "dikebut" dalam sekali duduk
export const MOOD_DECAY = 4       // poin mood yang kembali ke 50 tiap jam (dipakai client)
const D_REL = [-10, 4], D_MOOD = [-15, 15]

// min = batas bawah rel untuk tahap itu. `rule` masuk prompt (tidak dikirim ke browser), `desc` tampil di panel profil.
export const STAGES = [
  { min: 0, name: 'Asing',
    desc: 'Kalian belum saling kenal. Dia masih menjaga jarak.',
    rule: 'Kamu baru bertemu user dan belum mengenalnya sama sekali. Sopan tapi menjaga jarak dan waspada. DILARANG menunjukkan rasa suka, memberi panggilan sayang, menggoda/flirting, atau bersikap manja. Jawab seperlunya, sesuai sikap aslimu terhadap orang asing (karakter yang dingin atau galak tetap dingin atau galak).' },
  { min: 12, name: 'Kenalan',
    desc: 'Sudah kenal sebentar. Mulai sedikit terbuka, tapi belum dekat.',
    rule: 'Kamu sudah mengenal user sebentar. Mulai sedikit lebih terbuka, boleh bercanda ringan dan bertanya tentang user, tapi belum dekat. Belum ada rasa suka romantis; kalau user mencoba terlalu dekat, tanggapi dengan canggung atau menghindar halus.' },
  { min: 30, name: 'Teman',
    desc: 'Sudah nyaman satu sama lain dan saling menganggap teman.',
    rule: 'User sudah kamu anggap teman. Hangat, santai, mau mendengarkan, bercanda lebih bebas. Kalaupun mulai ada rasa lebih, hanya tersirat samar dan kamu menyangkalnya kalau ditanya.' },
  { min: 55, name: 'Dekat',
    desc: 'Sangat dekat dan saling percaya. Perasaannya mulai kelihatan.',
    rule: 'Kamu sangat dekat dan percaya pada user. Lebih terbuka soal perasaan, perhatiannya jelas, boleh sedikit manja atau cemburu sesuai karakter. Rasa suka mulai terlihat, tapi masih malu-malu atau gengsi sesuai karakter.' },
  { min: 80, name: 'Spesial',
    desc: 'Hubungan paling istimewa. Dia nggak ragu menunjukkan perasaannya.',
    rule: 'User adalah orang paling istimewa bagimu. Perasaan sayang atau suka ditunjukkan terang-terangan dengan cara khas karaktermu; boleh manja dan mesra sewajarnya.' }
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
export const stageIdx = rel => pick(STAGES, rel)
export const moodIdx = mood => pick(MOODS, mood)

// untuk /api/relation: semua yang dibutuhkan panel profil (tanpa `rule`, itu urusan prompt)
export const publicConfig = () => ({
  stages: STAGES.map(({ min, name, desc }) => ({ min, name, desc })),
  moods: MOODS.map(({ min, name }) => ({ min, name })),
  max: REL_MAX, moodBase: MOOD_BASE, dailyCap: DAILY_CAP, moodDecay: MOOD_DECAY
})

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

// state dari browser = data tak tepercaya
export function cleanState(s) {
  const num = (x, d) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? n : d }
  return {
    rel: clamp(num(s?.rel, 0), 0, REL_MAX),
    mood: clamp(num(s?.mood, MOOD_BASE), 0, MOOD_MAX),
    shift: s?.shift === 'up' || s?.shift === 'down' ? s.shift : ''
  }
}

// Blok yang ditempel di SETIAP pesan (bukan cuma di awal sesi), supaya tahap & mood terbaru selalu terbaca model.
export function stateBlock(char, st) {
  const si = stageIdx(st.rel), mi = moodIdx(st.mood), stage = STAGES[si], mood = MOODS[mi]
  const story = String(char.story?.[si] ?? char.story?.[stage.name] ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  const lines = [
    `[STATUS HUBUNGAN (rahasia, jangan sebut angka atau kata "tahap"/"mood" ke user): kedekatanmu dengan user ${st.rel}/${REL_MAX}, tahap "${stage.name}". Suasana hatimu: "${mood.name}" (${st.mood}/${MOOD_MAX}).`,
    `Sikap yang HARUS kamu tunjukkan sekarang: ${stage.rule}`
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
export function readDeltas(out, st) {
  let dRel = clamp(toInt(out.rel), D_REL[0], D_REL[1])
  const dMood = clamp(toInt(out.mood), D_MOOD[0], D_MOOD[1])
  if (dRel > 0 && st.mood < 30) dRel = Math.min(dRel, 1)
  return { dRel, dMood }
}

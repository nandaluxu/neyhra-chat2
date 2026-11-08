# README 2 — AUDIT DATA UNTUK AI (AI DATA MAP)

> Audit repo `nandaluxu/neyhra-chat2` (commit `321c74a`).
> Dokumen ini memetakan **semua data yang diperlukan/dikirim ke AI**: dari mana asalnya, bagaimana dirakit menjadi prompt, di file mana kodenya, dan **kalau mau mengubah X harus mulai dari file mana saja** (urutan dependency).
> Pendamping: `readme1.md` — audit penyimpanan data.

---

## 0. Peta besar: ada berapa "otak" AI di proyek ini?

| # | Otak | Kapan jalan | File inti |
|---|---|---|---|
| 1 | **Actor (chat 1-lawan-1)** | setiap pesan di layar chat | `lib/sessions.js` → `lib/chatgpt.js` |
| 2 | **Actor mode grup** | setiap giliran bicara di grup | `lib/sessions.js` (groupPrompt) |
| 3 | **Scenario Director (sutradara, AI 1)** | skenario aktif + trigger (lihat §4) | `lib/scenario.js` |
| 4 | **Scenario Actor (aktor, AI 2)** | skenario aktif, tiap pesan | `lib/scenario.js` + `lib/sessions.js` |
| 5 | **AI Hasilkan** (pembuka skrip) | tombol "AI Hasilkan" di panel Skenario Skrip | `lib/scenario.js` (GEN_*) |
| 6 | **Peringkas memori** | otomatis saat riwayat menua | `lib/app.js` `/api/memory` + `lib/sessions.js` summaryPrompt |
| 7 | **Lorka** (engine alternatif, khusus Mode dev) | field `engine` dari client | `lib/lorka.js` |
| 8 | **Fish Audio TTS** (bukan LLM, tapi jalur data AI) | voice note aktif | `lib/app.js` `/api/tts` |

Semua LLM (1–6) menumpang **satu** fungsi panggilan: `chatgpt(prompt, auth, chatId)` di `lib/chatgpt.js` (endpoint anon `android.chat.openai.com/backend-anon/f/conversation`), atau `lorka(...)` untuk #7 — bentuknya sengaja identik sehingga bisa ditukar lewat tabel `ENGINES` di `lib/sessions.js`.

---

## 1. Bahan baku: dari mana saja data AI dikumpulkan

```
[SUMBER DATA]                    [DI RAKIT DI]                     [MENJADI]

char/<id>.js  ──────────────►  lib/chars.js loadChars()  ──┐
  (prompt, trait, voices,                                  │
   relations, pronounce)                                   ├─► head prompt (sesi baru)
browser localStorage ──POST──► lib/app.js /api/chat  ──────┤    + blok per-pesan
  h:<id>   (riwayat ≤40)        • cleanHistory (24×600)    │    + aturan format
  mem:<id> (memori ≤1500)       • cleanMemory (30/1600)    │
  rel:<id> (EXP+mood)           • cleanName (userName)     │
  von/vl   (voice)              • voice sanitize           │
  rp       (mode roleplay)      • groupContext (grup)      │
  scenario (id rp_state) ──────► lib/scenario.js           │
                                   • directorTurn  ────────┼─► prompt SUTRADARA → JSON arahan
                                   • scenarioBlock ────────┤
                                   • directivesBlock ──────┘
MongoDB rp_state ─────────────►   • meta, sesi director/actor (seed)
                                   • genPrompt ───────────► prompt AI HASILKAN
lib/relation.js ──────────────► stateBlock + SCORE_RULES ──► blok kondisi hubungan
lib/finalize.js ◄────────────── balasan AI ────────────────► <id>/<jp>/<vn>/<next>/<rel>/<mood>
```

### 1.1 Data karakter — `char/<id>.js`
| Field | Dipakai untuk | Dikirim ke browser? |
|---|---|---|
| `id`, `name` | identitas, header riwayat, resolveNext grup | ya (`/api/chars`) |
| `prompt` | **kepribadian inti** — baris pertama head prompt | **tidak** |
| `tagline` | konteks AI Hasilkan + kartu karakter | ya |
| `trait` (opsional) | satu baris sifat untuk prompt grup & sutradara; fallback: potongan "Kepribadian:" di prompt, terakhir tagline (`traitOf` di `lib/sessions.js`) | tidak |
| `voiceId` → `voices[]` | TTS; browser hanya menerima `key` (hash sha256-8) + `label`; `id` asli (reference_id Fish Audio) **tidak pernah keluar server** | hanya key+label |
| `relations` | relasi antar karakter di prompt grup | tidak |
| `pronounce` | aturan pelafalan nama di `<jp>`/`<vn>` | tidak |

Validasi saat dimuat: wajib `id, name, prompt, voiceId` — kurang satu → file dilewati + warning console. Tidak ada cache: tiap request baca ulang folder (import `?v=<mtime>`).

### 1.2 Data dari browser (body `POST /api/chat`)
Dirakit di `public/index.html` (±baris 1110) lalu dibersihkan/dipangkas di `lib/app.js`:

| Field body | Asal client | Pembersihan server | Masuk prompt sebagai |
|---|---|---|---|
| `clientId` | localStorage `cid` | slice 64 | kunci sesi AI (`clientId:charId`) |
| `char` | karakter aktif | divalidasi harus ada di `char/` | memilih `char.prompt` |
| `message` | input user | `trim().slice(0, 2000)` | "Pesan dari user (namanya: X): ..." |
| `userName` | `authname` | `cleanName` 24 char | NAMA USER + `userRule` (panggil natural) |
| `history` | `h:<id>` (≤40) | `cleanHistory`: **24 terakhir × 600 char** | RIWAYAT obrolan |
| `memory` | `mem:<id>` terpilih | `cleanMemory`: ≤30 entri, ≤1600 char | INGATANMU TENTANG X |
| `rel` | `rel:<id>` `{rel,mood,shift}` | `cleanState` (clamp) | `stateBlock` (kondisi hubungan) |
| `voice` | `von`, `vl` | sanitize on/lang | memilih format 3-blok vs 1-blok |
| `group` | `public/group.js` | `groupContext`: ≤5 anggota, hist 30×600, scene 120, depth ≤10 | prompt grup (§3) |
| `rp` | `rp` (Pengaturan) | bool | `rpStyle`+`rpVoice` (gaya roleplay) |
| `engine` | `eng`+`lmodel` (dev) | nama divalidasi, model regex ketat | pilih ENGINES chatgpt/lorka |
| `scenario` | `SCN.body()` = id `rp_state` aktif + header Bearer | `scenarioChat` | blok skenario + arahan sutradara (§4) |

### 1.3 Data dari MongoDB (khusus skenario)
`rp_state` per user: `title`, `content` (skrip user ≤1000), `charId`, `meta` (arahan sutradara terakhir), `director`/`actor` (sesi provider untuk lanjut percakapan), `phase`, `sinceDir`, `msgs`. Detail §4.

---

## 2. Jalur 1 — Chat 1-lawan-1 (jalur utama)

**Rakitan prompt ada di `lib/sessions.js` fungsi `ask()` (baris ±113):**

```
┌─ HEAD (hanya saat sesi baru / format berubah) ──────────────────────┐
│ 1. char.prompt                          ← char/<id>.js              │
│ 2. scenarioBlock (kalau skenario)       ← lib/scenario.js §4        │
│ 3. memBlock "INGATANMU TENTANG X"       ← memory client             │
│ 4. formatRules(...)                     ← aturan output, lihat bawah│
│ 5. historyBlock "Riwayat obrolan"       ← history client (24×600)   │
└─────────────────────────────────────────────────────────────────────┘
┌─ TIAP PESAN (selalu) ───────────────────────────────────────────────┐
│ 6. stateBlock (kalau rel ada)           ← lib/relation.js           │
│ 7. directivesBlock (kalau skenario)     ← meta sutradara §4         │
│ 8. "Pesan dari user (namanya: X): <message>"                        │
│ 9. remind(...)  [Ingat: format ...]      ← pengingat pendek          │
└─────────────────────────────────────────────────────────────────────┘
```

**`formatRules()` — menentukan bentuk balasan AI (satu fungsi, banyak saklar):**
- `voice.on=false` → 1 blok: `<id>...</id>` (+ `<rel>/<mood>` kalau rel, + `<next>` kalau grup)
- `voice.on=true` → 3 blok: `<id>` (teks ID) + `<jp>` (subtitle Jepang) + `<vn>` (teks voice note + tag ekspresi dari `TAGS`)
- `rp=true` → menambah `rpStyle` (narasi `*...*` + ucapan `"..."`, 2–5 bagian, maks 3 ucapan) dan `rpVoice` (aturan `<jp>/<vn>` hanya ucapan, satu ucapan per baris)
- `userRule` — nama user disebut natural, tidak tiap kalimat
- `pronounceRules` — pelafalan nama untuk suara
- `SCORE_RULES` (`lib/relation.js`) — aturan blok `<rel>`/`<mood>` (rentang -10..+4 / -15..+15, anti manipulasi)

**Balasan AI diproses:** `parse()` (ambil blok) → cek kelengkapan → **retry 1×** dengan "Formatmu salah. Ulangi..." → `finalize()` (`lib/finalize.js`: rapikan, buang tag nyasar, potong ke ucapan) → `readDeltas()` (ubah `<rel>/<mood>` jadi dExp/dMood) → kirim ke client.

**Kapan sesi restart (`fmtKey` di `run()`):** voice on/off/lang berubah, memori berubah (hash), rel aktif/nonaktif, rp aktif/nonaktif, skenario aktif/nonaktif, ganti engine/model, atau sesi > 50 menit. Riwayat selalu ikut dari client → obrolan tidak putus.

**Antrian:** satu antrian per `clientId:charId` (`s.q`) supaya dua pesan beruntun tidak balapan `parentMessageId`.

---

## 3. Jalur 2 — Mode grup

`lib/app.js` `groupContext()` + `lib/sessions.js` `groupPrompt()`.

- **Selalu percakapan baru** per giliran (tidak ada sesi per karakter); yang dipakai ulang hanya cookie anon per clientId (`gAuth`).
- Prompt = `char.prompt` + KONTEKS GRUP (anggota: `id (name) – traitOf`, relasi antar anggota yang hadir, scene ≤120) + ATURAN BICARA (1–2 kalimat, tanpa narasi) + formatRules (dengan `<next>`) + riwayat grup **30 baris** (nama pengirim, bukan id) + "Giliran ini: ..." (balas user / membuka obrolan / menanggapi replyTo).
- `<next>` dari model = **usulan**; divalidasi `resolveNext()` (id → nama lengkap → token nama; ambigu = null). Client (`public/group.js`) yang mengatur rantai giliran — menampilkan tombol lanjut giliran untuk anggota yang diusulkan.

---

## 4. Jalur 3 — Skenario Skrip (Dual AI: Director + Actor)

**State:** `rp_state` di MongoDB (lihat readme1 §1.6). Dua sesi ChatGPT **terpisah**: `st.director` dan `st.actor` — keduanya disimpan ke Mongo setelah tiap giliran supaya bertahan pindah instance/reload (< 50 menit hangat; setelah itu sesi baru, konteks penuh dikirim ulang).

### 4.1 Director (sutradara) — `directorTurn()`
**Kapan dipanggil (`scenarioChat`):**
- belum ada `meta` (pesan pertama), atau
- `sinceDir >= meta.nextIn` (usulan sutradara sendiri, 3–8 pesan), atau
- `isBigAction(message)`: narasi `*...*` ≥15 char ATAU pesan ≥400 char (aksi besar user).

**Prompt (`directorHead` saat sesi baru / `directorFollowUp` saat lanjut):**
```
Peran: SUTRADARA (atur event/konflik/lokasi/pacing; TIDAK menulis dialog, TIDAK memutuskan tindakan user)
SKENARIO: judul + isi skrip user (≤1000 char)
KARAKTER ACTOR: nama - traitOf(char)
USER: nama
STATE CERITA: meta terakhir (JSON)
PERCAKAPAN TERAKHIR: 8 baris riwayat (tiap baris ≤160 char)
PESAN USER TERBARU: ≤400 char
→ Balas HANYA JSON: {lokasi, suasana, event, tujuan, karakter, instruksi(≤400), panggil_lagi:3-8}
```
`parseDirector()` membaca JSON (retry 1× kalau format salah); **gagal total → null** → chat lanjut dengan arahan lama (degradasi lembut, obrolan tidak putus).

### 4.2 Actor (aktor)
Actor = jalur chat 1-lawan-1 biasa (§2) dengan dua blok tambahan:
- `scenarioBlock` (di **head**, sesi baru): judul + isi skrip → "jadikan kenyataan, jangan sebut kata skenario"
- `directivesBlock` (**tiap pesan**): ARAHAN SUTRADARA (lokasi/suasana/event/tujuan/karakter/instruksi) → "patuhi secara natural, jangan sebut sutradara/arahan ke user"

### 4.3 AI Hasilkan — `genPrompt()` + `GEN_*`
- Instruksi verbatim `GEN_INSTR`: SATU PARAGRAF pembukaan skenario.
- Konteks: nama karakter + tagline + `traitOf` + tema user (≤120) + nama user.
- Format wajib di prompt: target **400–700** char, batas mutlak **900** (termasuk spasi/tanda baca/kutip), tanpa judul/kutip pembungkus.
- Validasi `validateGen`: `empty` / `multi` (lebih dari satu paragraf) / `long` (>900) / `short` (<150) → **regenerasi** (maks `GEN_ATTEMPTS=3`) dengan `genFeedback` (instruksi lebih ketat menyebut pelanggaran) — **TIDAK ADA pemotongan teks**.
- Sesi anon per user (`genAuth` Map), reuse sampai 50 menit.

### 4.4 Peringkas memori — `/api/memory`
`summaryPrompt`: riwayat ≤40×600 → "Ringkas untuk disimpan sebagai ingatan... 2-4 kalimat, orang ketiga" → `<title>`(≤40)+`<body>`(≤500) → client simpan `mem:<id>`. Server tidak menyimpan.

---

## 5. Jalur 8 — TTS Fish Audio (`/api/tts`)
- Input: `char` (validasi), `text` = hasil `<vn>` yang sudah `fixReading` (pelafalan dari `pronounce` karakter) + `stripLB`, dipangkas **800 char**; `voice` = key → dicocokkan ke `voices[].id` (reference_id).
- Pagar: header `x-voice-code` harus cocok `VOICE_CODE` (default `NANDAxFURINA`); `FISH_API_KEY` wajib; model default `s2.1-pro-free`.
- Output: mp3 → client simpan di IndexedDB (`vn`).

---

## 5b. Jalur 9 — Chat Global (TANPA AI — tidak lewat chatgpt.js sama sekali)

Chat Global murni CRUD + polling; tidak ada LLM di jalurnya. Peta data singkat (detail lengkap + skema di `readme1.md` §1.10 & §2):

```
kirim:  client → /api/gc/send → validasi + rate-limit → INSERT MongoDB (gc_messages) → push feed Redis (best-effort)
riwayat: client → /api/gc/history → MongoDB, kursor {ts,id}, 30–50/halaman, urut naik
realtime: client poll → /api/gc/sync → feed Redis (10 terbaru) + presence; klien tertinggal → gap-patch dari MongoDB
hapus:  client (kode dev) → /api/gc/delete → delete MongoDB + tombstone/watermark Redis → klien online ikut membuang
```

- **MongoDB = sumber kebenaran** (seluruh riwayat); Redis = presence, rate limit, dan feed realtime 10 pesan (cache). Pesan yang tertinggal dari feed selalu bisa ditambal dari Mongo.
- Browser tidak menyimpan riwayat GC (hanya memori + dedup; `loadOlder` mengambil lagi dari Mongo). Tidak ada WebRTC/signaling/ECDSA/IndexedDB — semua komunikasi HTTP POST ke `/api/gc/*`.
- `replyTo` sudah diteruskan dari `send(text, replyTo)` dan disimpan di Mongo (divalidasi format UUID), siap dipakai saat UI balas pesan dibuat.

---

## 6. CHEAT SHEET — "Kalau mau ubah X, mulai dari mana"

Urutan = urutan baca/edit yang benar (dependency). Tanda ⚠ = ada pasangan di client yang harus ikut diubah.

| Mau ubah... | Mulai dari (urutan) |
|---|---|
| **Kepribadian / suara / relasi sebuah karakter** | 1. `char/<id>.js` (prompt, trait, voiceId, relations, pronounce) — selesai, langsung berlaku (server baca ulang tiap request). 2. Kalau ganti `id` → cek `assets/<id>.jpg` + `AVATAR_BASE` |
| **Gaya/cara AI membalas (format blok)** | 1. `lib/sessions.js` `formatRules()` + `TAGS` + `ONE_ID` 2. parser: `parse()`/`idText()`/`multi()` di file yang sama 3. `lib/finalize.js` (perapihan akhir) 4. retry "Formatmu salah" di `ask()` 5. ⚠ client `public/index.html` (cara menampilkan `r.id/r.jp/r.vn`) |
| **Aturan mode roleplay (narasi/ucapan)** | 1. `rpStyle` + `rpVoice` di `lib/sessions.js` 2. `remind()` 3. cek kelengkapan ucapan `rpQuotes`/`rpSegs` di `ask()` 4. ⚠ switch `rpOn()` client (`store 'rp'`) 5. `finalize()` untuk output roleplay |
| **Berapa riwayat yang AI lihat** | 1. server: `cleanHistory(h, 24)` + 600 char di `lib/app.js` 2. ⚠ client: `saveHist` (simpan 40) di `public/index.html` 3. peringkasan: `MEM_TRIGGER=16` + `/api/memory` `MEM_HIST=40` |
| **Sistem memori (ingatan)** | 1. client: `MEM_*` + `memUse()` + `memIds()` di `public/index.html` 2. server pembersih: `cleanMemory()` di `lib/app.js` 3. blok prompt: `memBlock()` di `lib/sessions.js` (hash → `memHash` ikut `fmtKey`) 4. generator: `summaryPrompt` di `lib/sessions.js` 5. penyimpanan: `mem:<id>` localStorage |
| **Hubungan / EXP / mood** | 1. `lib/relation.js` SEMUA (kurva `EXP_BASE/STEP`, `STAGES`, `DAILY_CAP`, `SCORE_RULES`, `stateBlock`, `readDeltas`, clamp) 2. ⚠ client: `relPayload`/`relApply`/`relLoad` + `rel:<id>` di `public/index.html` 3. tabel publik: `/api/relation` `publicConfig()` |
| **Voice note / subtitle** | 1. format `<jp>`/`<vn>`: `formatRules` di `lib/sessions.js` 2. pelafalan: `pronounce` di `char/<id>.js` + `fixReading` di `lib/chars.js` 3. pemangkas: `stripLB`/`hasJp` di `lib/finalize.js` 4. endpoint TTS + batas 800 char: `/api/tts` di `lib/app.js` 5. ⚠ client: `von/vl/vspeed/vcode`, IndexedDB `vn`, AUDMAX/MAXV |
| **Sutradara (kapan & apa yang diarahkan)** | 1. trigger: `needDir` + `isBigAction` + `sinceDir/nextIn` di `scenarioChat()` 2. prompt: `directorHead`/`directorFollowUp` 3. skema JSON: `parseDirector` + `DEF_META` (field + batas char) 4. tampilan di prompt Actor: `directivesBlock` 5. riwayat yang dilihat sutradara: `DIR_HIST=8` × 160 char |
| **AI Hasilkan (pembuka skrip)** | 1. `GEN_INSTR` (instruksi verbatim) 2. `genPrompt` (konteks + format wajib) 3. `GEN_MAX/GEN_TARGET_LO/HI/GEN_MIN/GEN_ATTEMPTS` 4. validasi `validateGen` + feedback `genFeedback` 5. ⚠ UI tombol + counter di `public/scenario.js` |
| **Kuota/batas skrip (3 skrip, 1000 char)** | 1. `MAX_SCRIPTS` + validasi content di `lib/scenario.js` route `save` 2. index unique `{userId,slot}` (anti race) 3. ⚠ UI: `maxlength` textarea + counter `0/1000` di `public/scenario.js` |
| **Giliran bicara grup / `<next>`** | 1. prompt: `groupPrompt` + `nextRules` di `lib/sessions.js` 2. validasi: `resolveNext` + `groupContext` di `lib/app.js` 3. ⚠ client: `public/group.js` (rantai giliran, tombol lanjut) |
| **Ganti/menambah provider AI** | 1. tiru bentuk `lib/chatgpt.js` (`getSession()` + `chat(prompt, auth, chatId)`) — contoh siap: `lib/lorka.js` 2. daftarkan di `ENGINES` (`lib/sessions.js`) 3. ⚠ client: `engPayload()` + `store 'eng'/'lmodel'` 4. daftar model: `/api/lorka/models` |
| **Nama user di prompt** | 1. ⚠ client: sumber `uname` = `authname` (login) di `public/index.html` 2. server: `cleanName` (24 char) di `lib/app.js` 3. pemakaian: `userRule` + `historyBlock` + `memBlock` di `lib/sessions.js` |
| **Kecepatan/karakter sutradara panggil ulang** | `nextIn` clamp 3–8 di `parseDirector` + `DEF_META` (keduanya `lib/scenario.js`) |
| **Batas pesan/perilaku Chat Global** (bukan AI) | 1. `lib/gc.js` (validasi teks 256 codepoint, pagination kursor, gap-patch, kode dev) 2. `lib/gcstore.js` (key Redis, rate limit, TTL, skrip Lua) 3. ⚠ client `public/globalchat.adapter.js` (polling, MEM_MAX, dedup) — lihat §5b |
| **Batas ukuran request** | `express.json({limit:'50kb'})` di `lib/app.js` (auth dipasang lebih besar 3,5 MB sebelum parser global, `MAX_DATA` di `lib/auth.js`) |

---

## 7. Angka-angka pembatas (semua di satu tempat)

| Batas | Nilai | Lokasi |
|---|---|---|
| Pesan user | 2000 char | `lib/app.js` |
| Riwayat dikirim AI | 24 pesan × 600 char | `cleanHistory` |
| Riwayat disimpan client | 40 pesan (`h:`), 150 tampilan (`log:`) | `public/index.html` |
| Memori dipakai | ≤30 entri, ≤1600 char server; ≤1500 char pilihan client | `cleanMemory` / `MEM_MAX_USE` |
| Ringkasan memori | title ≤40, body ≤500 char | `/api/memory` |
| Riwayat grup | 30 baris × 600; anggota ≤5 | `groupContext` |
| Riwayat sutradara | 8 baris × 160; pesan user 400; instruksi 400 | `lib/scenario.js` |
| Skrip skenario | isi ≤1000 char; kuota 3/user | `lib/scenario.js` |
| AI Hasilkan | 1 paragraf; target 400–700; mutlak 900; regenerasi ≤3× | `GEN_*` |
| Teks TTS | 800 char | `/api/tts` |
| Sinkron cloud | 3,5 MB | `MAX_DATA` `lib/auth.js` |
| Pesan chat global | 256 codepoint (ditolak, bukan dipangkas) | `lib/gc.js` |
| Rate limit AI | 60 skenario-chat/5 mnt; 8 generate/jam; 20 start/10 mnt; dll | `allow()` `lib/scenario.js` |

---

## 8. Alur end-to-end satu pesan (untuk debugging)

```
User ketik "..." (public/index.html submit)
  │  kumpulkan: hist(h:), memUse(), relPayload(), voice, rp, SCN.body()
  ▼
POST /api/chat  (lib/app.js)
  │  bersihkan semua input • cari karakter (loadChars)
  │  kalau ada field scenario ──► scenarioChat (lib/scenario.js)
  │       │  perlu sutradara? ──► directorTurn (sesi director di Mongo)
  │       │  meta + directives + seed sesi actor
  │       ▼
  │  reply() (lib/sessions.js)  ← kunci "clientId:charId[:scn]"
  │       │  fmtKey cocok? tidak ─► sesi anon baru (head lengkap)
  │       │  ask(): head + stateBlock + directives + pesan + remind
  │       │       ▼
  │       │  chatgpt() (lib/chatgpt.js) → SSE stream → teks
  │       │       ▼  parse + retry format 1×
  │       │       ▼  finalize (lib/finalize.js) + readDeltas (relation)
  │       ▼
res.json { id, jp, vn, next, dRel→dExp, dMood }
  │  client: simpan log/h:/mem trigger, EXP ke rel:, audio → IndexedDB via /api/tts
  ▼
Bubble tampil + voice note (jika aktif)
```

Log mentah bisa dinyalakan dengan env `DEBUG_RAW=1` (mencetak `[raw:in]`/`[raw:out]` di console server).

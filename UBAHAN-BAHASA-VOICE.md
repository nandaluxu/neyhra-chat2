# UBAHAN — BAHASA VOICE NOTE + SUBTITLE (id / jp / en / ko / zh)

> Pilihan bahasa voice note ditambah dari 2 (Indonesia, Jepang) menjadi 5:
> **Indonesia, Jepang, Inggris, Korea, Mandarin.** Subtitle ikut bertambah bahasanya.
> Komitmen kompatibilitas: semua data lama (riwayat voice note di `log:`, pengaturan `vl`/`sl`,
> ekspor/impor) dan perilaku lama untuk Indonesia/Jepang **tidak berubah sama sekali**.

## Cara pakai

Pengaturan → tombol **Voice note** → **Bahasa voice**: pilih Indonesia / Jepang / Inggris / Korea / Mandarin.
Pilihan tersimpan di `localStorage vl` (kode: `id` `jp` `en` `ko` `zh`) dan berlaku untuk
chat 1-lawan-1, mode grup, Skenario Skrip, dan ocehan lawan di Catur (kalau voice menyala).

**Subtitle** (Pengaturan voice → Subtitle): label tombolnya kini mengikuti bahasa voice.
- Voice Indonesia/Jepang → opsi: "Indonesia + Jepang" / "Ikuti bahasa voice" / "Indonesia saja" / "Jepang saja" (seperti dulu).
- Voice Inggris/Korea/Mandarin → opsi yang sama tapi blok keduanya jadi bahasa itu: "Indonesia + Inggris" / … / "Inggris saja", dst.

## Perilaku per bahasa (format AI tetap `<id>` / `<jp>` / `<vn>`)

| `vl` | Teks chat `<id>` | Subtitle `<jp>` | Voice note `<vn>` |
|---|---|---|---|
| `id` | Indonesia | Jepang (tidak berubah) | Indonesia (tidak berubah) |
| `jp` | Indonesia | Jepang (tidak berubah) | Jepang (tidak berubah) |
| `en` | Indonesia | **Inggris** | **Inggris** |
| `ko` | Indonesia | **Korea** | **Korea** |
| `zh` | Indonesia | **Mandarin** | **Mandarin** |

Nama tag `<jp>` TIDAK diganti (tetap `<jp>`) supaya parser `parse()` di server dan semua
riwayat voice note lama di browser tetap kompatibel — yang berubah hanya isinya untuk en/ko/zh.

## File yang berubah

| File | Perubahan |
|---|---|
| `lib/sessions.js` | Tabel `LANGS` + `normVoice` (ekspor). `formatRules()` multi-bahasa: instruksi `<jp>`/`<vn>` pakai nama bahasa, contoh `<vn>` per bahasa (`VN_EX`), aturan khusus per bahasa (`LANG_RULES` — aksara nama: katakana/Hangul/Hanzi, tawa, kata seru; id/jp byte-identik dengan teks lama). `remind()` menyebut nama bahasa yang benar. `pronounce` (pelafalan katakana) hanya dipakai untuk id/jp. `fmtKey` otomatis ikut `voice.lang` → ganti bahasa = sesi AI baru (sudah begitu juga sejak dulu). |
| `lib/finalize.js` | `langOk()` cek aksara per bahasa (kana/Hangul/Hanzi; latin tidak dicek) untuk fallback "model salah format". `fixReading` (ganti nama → katakana) hanya untuk id/jp, supaya teks Korea/Mandarin/Inggris tidak dirusak nilai katakana. Fallback `<vn>` kosong/salah: subtitle dipakai hanya kalau bahasanya = bahasa voice itu; voice Indonesia selalu fallback ke teks `<id>` (perilaku lama). Ekspor `hasKana`. |
| `lib/app.js` | `/api/chat` memakai `normVoice` (bahasa tak dikenal → `jp`, seperti dulu). `/api/tts`: `fixReading` hanya untuk teks yang memuat kana (`hasKana`, bukan `hasJp`) — Hanzi Mandarin/Hangul Korea tidak lagi salah dianggap teks Jepang. |
| `lib/scenario.js` | `sanitizeVoice` = `normVoice` (Skenario Skrip ikut 5 bahasa). |
| `lib/chess.js` | Hanya jalur **suara ocehan** (bukan logika caturnya): `/api/auth/chess/say` memakai `normVoice`; `ensureVn` meminta model mengucapkan kalimat yang sama dalam bahasa voice itu (dulu hard-coded Jepang). |
| `public/index.html` | Pemilih "Bahasa voice" jadi 5 tombol (grid 3+2, kelas `seg x3` yang sudah ada). `VL` tabel nama. Label opsi Subtitle dinamis mengikuti bahasa blok subtitle (`paintVoice`). `subText`: mode `auto` memakai blok subtitle untuk semua bahasa non-Indonesia. Estimasi durasi voice note Mandarin dihitung per aksara. Ekspor obrolan: label "Jepang:" jadi label bahasa yang sebenarnya. |
| `public/group.js` | Label ekspor obrolan grup ikut bahasa voice note (`LN`). |
| `public/games.js` | Kiriman `lang` ke `chess/say` dilewatkan apa adanya (server yang memfilter ke daftar sah). |
| `scripts/lang-test.mjs` (baru) + `npm run lang:test` | Tes fungsi murni: `normVoice`, `hasKana`, `finalize` untuk 5 bahasa (perilaku lama id/jp + fallback + roleplay multi-ucapan). 33 asersi. |

## Yang TIDAK berubah

- Kunci localStorage: `vl`, `sl`, `von`, `vspeed`, `vcode` — nilai lama tetap sah (`vl` tak dikenal → Jepang).
- Bentuk riwayat voice note di `log:` (`{r:'vn', x, jp, lang, vn, ks, si}`) — entri lama diputar & diekspor seperti biasa.
- Tag AI `<id>`/`<jp>`/`<vn>`, parser, aturan tag ekspresi TTS, `TAGS`, kuota 800 karakter TTS, pagar kode voice.
- Logika permainan catur, mesin AI catur, dan seluruh fitur lain.

Diperiksa: `node --check` semua file; `npm run lang:test` (33/33); boot server lokal (`/api/chars`,
`/api/voices`, pagar `/api/tts` OK); uji browser headless 390×844 — pemilih 5 bahasa tampil rapi
(tanpa overflow), label subtitle dinamis, `vl` tersimpan, nilai tak dikenal jatuh ke Jepang.

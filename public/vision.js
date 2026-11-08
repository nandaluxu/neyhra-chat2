/* ===== Vision: kirim gambar ke karakter yang bisa melihatnya =====
   - Menu "+" -> "Kirim Gambar" (hanya karakter dengan ch.vision, dari field `vision: true` di char/<id>.js
     lewat /api/chars). Gambar dikecilkan di browser: versi kirim (maks 896px, untuk /api/vision) dan
     thumbnail (maks 360px, disimpan di log + tampil di chat) supaya localStorage tidak bengkak.
   - Pola lampiran Scene Capture/hadiah: gambar jadi CHIP di kotak ketik, user boleh mengetik caption
     (opsional). Saat kirim, submit() di index.html memanggil VISION.take() lalu:
       fase 1  POST /api/vision  -> AI mendeskripsikan gambar (DeepChat, lib/vision.js)
       fase 2  POST /api/chat    -> balasan karakter seperti biasa (field `vision` = deskripsi,
                                    ditempel ke pesan ala kalimat hadiah, lihat lib/app.js)
   - Gagal fase 1 -> pesan tidak jadi terkirim: chip dipasang lagi, ketikan dikembalikan, muncul toast.
   - Hasil di log: {t, r:'me', x: caption, img: thumbnail, vd: deskripsi}. Riwayat untuk AI (h:<id>)
     memuat "[mengirim gambar: <deskripsi>] <caption>" supaya giliran berikutnya tetap ingat isinya.
   Memakai global index.html: ch, app, chat, busy, inp, toast, scroll, now, ensureDay, rpRender,
   restoring, store, refresh, grow. */
(() => {
  'use strict'
  if (window.VISION) return

  let armed = null // { char, name, full, thumb, ph } -> gambar terpasang sebagai lampiran di kotak ketik

  const inChat = id => !!(ch && ch.id === id && app.classList.contains('open') && !(window.GX && GX.cur))
  const can = () => !!(ch && ch.vision && inChat(ch.id))
  const has = () => !!(armed && ch && ch.vision && ch.id === armed.char && !(window.GX && GX.cur))

  /* ---------- Kecilkan gambar di browser (canvas) ---------- */
  async function decode(file) {
    try { return await createImageBitmap(file) } catch {}
    return await new Promise((ok, no) => { // Safari lama / format yang tidak didukung createImageBitmap
      const u = URL.createObjectURL(file), im = new Image()
      im.onload = () => ok(im)
      im.onerror = () => { URL.revokeObjectURL(u); no(new Error('Format gambar tidak didukung browser ini')) }
      im.src = u
    })
  }
  async function shrink(src, max, q) {
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight
    if (!w0 || !h0) throw new Error('Gambar tidak terbaca')
    const s = Math.min(1, max / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s))
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const cx = cv.getContext('2d')
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h) // PNG transparan diberi dasar putih (JPEG tanpa alpha)
    cx.drawImage(src, 0, 0, w, h)
    return cv.toDataURL('image/jpeg', q) // sumber TIDAK ditutup di sini: dipakai lagi untuk ukuran kedua (ditutup di pick)
  }

  /* ---------- Lampiran di kotak ketik (pola #scnbar scene.js / #attbar shop.js) ---------- */
  const footer = document.querySelector('#chatview footer')
  let bar = null
  const hint = () => (inp.value.trim() ? 'Gambar + ketikanmu' : 'Gambar tanpa ketikan')

  function paintBar() {
    if (!has()) { drop(); return } /* chat berpindah / masuk grup: lampiran dibuang, belum ada yang dikirim */
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'visbar'; bar.setAttribute('aria-live', 'polite')
      footer.before(bar) /* di bawah #scnbar/#attbar, di atas footer (vision.css) */
    }
    bar.textContent = ''
    const chip = document.createElement('div'); chip.className = 'att-chip'
    chip.title = 'Gambar dikirim bersama pesanmu. ' + (armed.name || '')
    const ics = document.createElement('span'); ics.className = 'att-ic'
    const th = new Image(); th.src = armed.thumb; th.alt = ''; th.draggable = false
    ics.append(th)
    const tx = document.createElement('span'); tx.className = 'att-tx'
    const t1 = document.createElement('b'), t2 = document.createElement('small')
    t1.textContent = 'Kirim Gambar'; t2.textContent = hint()
    tx.append(t1, t2)
    const x = document.createElement('button'); x.type = 'button'; x.className = 'att-x'; x.title = 'Lepas gambar'; x.setAttribute('aria-label', 'Lepas gambar dari kotak ketik')
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    x.addEventListener('pointerdown', e => e.preventDefault()) /* tap tidak menutup keyboard */
    x.addEventListener('click', () => { drop(); inp.focus({ preventScroll: true }) })
    chip.append(ics, tx, x); bar.append(chip)
  }
  function drop() { /* lepas lampiran: cabut bar + kembalikan placeholder asli */
    if (armed) { try { inp.placeholder = armed.ph } catch {}; armed = null }
    if (bar) { bar.remove(); bar = null }
    if (typeof refresh === 'function') refresh()
  }

  /* ketikan berubah -> subjudul chip ikut ("Gambar + ketikanmu" / "Gambar tanpa ketikan") */
  inp.addEventListener('input', () => { const s = bar && bar.querySelector('small'); if (s && has()) s.textContent = hint() })
  /* pindah chat / masuk keluar grup: lampiran otomatis dilepas (pola paintBar scene.js) */
  new MutationObserver(() => { if (!has()) paintBar() }).observe(document.getElementById('hname'), { childList: true, characterData: true, subtree: true })

  /* ---------- Pilih gambar (menu "+"): pasang lampiran, belum mengirim apa pun ---------- */
  function pick() {
    if (!can()) { toast('Kirim Gambar belum tersedia di chat ini'); return }
    if (busy) { toast('Sabar, tunggu balasan sebelumnya'); return }
    const fi = document.createElement('input')
    fi.type = 'file'; fi.accept = 'image/*'
    fi.onchange = async () => {
      const f = fi.files && fi.files[0]
      if (!f) return
      if (f.size > 25 * 1024 * 1024) { toast('Gambar terlalu besar (maks 25 MB)'); return }
      let full, thumb
      try {
        const src = await decode(f)
        try {
          full = await shrink(src, 896, 0.82)   /* dikirim ke /api/vision */
          thumb = await shrink(src, 320, 0.62)  /* disimpan di log + tampil di chat: dikecilkan supaya sinkron akun (batas ±3,5 MB) tetap muat */
        } finally { if (src.close) try { src.close() } catch {} }
      } catch (e) { toast(e.message || 'Gambar tidak terbaca'); return }
      if (ch && ch.vision && !busy) {
        armed = { char: ch.id, name: f.name, full, thumb, ph: inp.placeholder }
        inp.placeholder = 'Tulis sesuatu soal gambarnya (opsional)'
        paintBar(); refresh()
        inp.focus({ preventScroll: true })
      }
    }
    fi.click()
  }

  /* ---------- Dipakai submit() di index.html ---------- */
  /* take: ambil lampiran (chip dilepas). text = ketikan user saat itu (caption, boleh kosong). */
  function take() {
    if (!has()) return null
    const a = armed
    drop()
    return { char: a.char, name: a.name, full: a.full, thumb: a.thumb, text: String(inp.value || '').trim().slice(0, 2000) }
  }
  /* untake: pasang lagi (dipakai kalau validasi kirim gagal / deskripsi gambar gagal, supaya user tidak pilih ulang) */
  function untake(vf) {
    if (!vf || !vf.full || !ch || ch.id !== vf.char || busy) return
    armed = { char: vf.char, name: vf.name, full: vf.full, thumb: vf.thumb, ph: inp.placeholder }
    inp.placeholder = 'Tulis sesuatu soal gambarnya (opsional)'
    paintBar(); refresh()
  }

  /* ---------- Bubble pesan user: gambar + caption (dipakai kirim & restore) ---------- */
  function bubble({ img, text, t }) {
    const tt = t || Date.now(); ensureDay(tt)
    const row = document.createElement('div'); row.className = 'row me' + (restoring ? ' rs' : '')
    row.dataset.t = tt
    row.dataset.q = text || '' /* biar bisa dicari lewat kolom pencarian obrolan */
    const bub = document.createElement('div'); bub.className = 'bub vis-b'
    const im = new Image()
    im.alt = 'Gambar yang dikirim'
    im.loading = 'lazy'; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer'
    im.src = img
    bub.append(im)
    if (text) { const tx = document.createElement('div'); tx.className = 'txt'; rpRender(tx, text); bub.append(tx) }
    const ts = document.createElement('div'); ts.className = 'ts'; ts.textContent = now(tt)
    bub.append(ts)
    row.append(bub); chat.appendChild(row); scroll()
  }

  /* ---------- Dipakai restoreChat() di index.html untuk menampilkan lagi pesan gambar lama ---------- */
  function render(e) { if (e && e.img) bubble({ img: e.img, text: e.x, t: e.t }) }

  window.VISION = { pick, has, take, untake, render }
})()

/* ===== Scene Capture: AI mengilustrasikan adegan percakapan =====
   - Manual (menu "+" -> "Scene Capture"): TIDAK memakai overlay dan TIDAK langsung memproses — memasang
     LAMPIRAN di kotak ketik (pola hadiah di shop.js: chip + tombol X). User boleh mengetik prompt sendiri
     di kotak ketik; saat tombol kirim ditekan (submit() di index.html -> SCENE.send), ketikan itu jadi
     prompt ilustrasi. Kalau dikirim KOSONG, server menyusun prompt dari konteks percakapan (kondisi alur
     sekarang). Hasil tampil sebagai LAMPIRAN GAMBAR di percakapan (pola Gift: tanpa modal, tersimpan log).
   - Otomatis: setelah balasan AI tampil (dipanggil submit() di index.html), AI penilai di server yang
     memutuskan apakah adegannya layak divisualisasikan. Maks SATU kali per giliran, plus jeda minimum
     10 menit antar ilustrasi per karakter supaya adegan yang mirip tidak digambar berulang.
   - Hanya karakter dengan gambar referensi (ch.scene, dari field refImg char/<id>.js via /api/chars)
     yang memakai fitur ini; refImg sendiri tidak pernah sampai ke browser (lihat lib/scene.js).
   Memakai global index.html: ch, chat, app, uname, store, post, toast, scroll, now, ensureDay,
   loadHist, loadLog, record, restoring, rpOn, placeGoon, inp, grow, refresh, draftT. */
(() => {
  'use strict'
  if (window.SCENE) return

  const COOLDOWN = 10 * 60 * 1000 // jeda minimum ilustrasi otomatis per karakter
  let pending = null              // { char } -> ada ilustrasi yang sedang dibuat
  let armed = null                // { char, ph } -> Scene Capture terpasang sebagai lampiran di kotak ketik

  const inChat = id => !!(ch && ch.id === id && app.classList.contains('open') && !(window.GX && GX.cur))
  const can = () => !!(ch && ch.scene && inChat(ch.id))

  /* lampiran valid selama masih di chat karakter yang sama (pola hasAtt di shop.js) */
  const has = () => !!(armed && ch && ch.scene && ch.id === armed.char && !(window.GX && GX.cur))

  /* ilustrasi terakhir milik karakter ini dari riwayat (untuk menghindari adegan yang hampir sama) */
  function lastScene(id) {
    try {
      const l = loadLog(id)
      for (let i = l.length - 1; i >= 0; i--) if (l[i] && l[i].r === 'scene' && l[i].u && l[i].p) return l[i]
    } catch {}
    return null
  }

  async function sceneApi(mode, replyText, userPrompt) {
    const id = ch.id
    const l = lastScene(id)
    const body = {
      char: id, mode, userName: uname, reply: String(replyText || '').slice(0, 1200),
      history: loadHist(id),
      lastScene: l ? { prompt: l.p, mins: Math.max(0, Math.round((Date.now() - (l.t || 0)) / 60000)) } : null
    }
    if (mode === 'manual' && userPrompt) body.prompt = String(userPrompt).slice(0, 600) /* ketikan user = prompt manual; kosong = server susun dari adegan */
    const tok = store.get('authtok') || ''
    const r = await post('/api/scene/capture', body, tok ? { Authorization: 'Bearer ' + tok } : {})
    return await r.json()
  }

  /* ---------- Tampilan ---------- */
  /* indikator loading: bubble kecil "menggambar adegan" (bukan overlay) */
  function loadBubble() {
    const row = document.createElement('div'); row.className = 'row them'
    row.innerHTML = '<div class="bub scene-load"><span class="think-t">Menggambar adegan\u2026</span><div class="typing-b"><i></i><i></i><i></i></div></div>'
    chat.appendChild(row); scroll()
    return row
  }

  /* lampiran gambar di percakapan (struktur data log: {t, r:'scene', u, p} — lihat record()/restoreChat()) */
  function addScene(e) {
    const t = e.t || Date.now(); ensureDay(t)
    const row = document.createElement('div'); row.className = 'row them' + (restoring ? ' rs' : '')
    row.dataset.t = t
    row.dataset.q = e.p || '' /* biar bisa dicari lewat kolom pencarian obrolan */
    const bub = document.createElement('div'); bub.className = 'bub scene-b'
    const im = new Image()
    im.alt = 'Ilustrasi adegan' + (ch ? ' \u2014 ' + ch.name : '')
    im.loading = 'lazy'; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer'
    im.src = e.u
    if (e.p) im.title = e.p
    im.onclick = () => { try { window.open(e.u, '_blank', 'noopener') } catch {} } /* lihat ukuran penuh */
    bub.append(im)
    const foot = document.createElement('div'); foot.className = 'scene-f'
    const cap = document.createElement('span'); cap.className = 'scene-cap'; cap.textContent = 'Scene Capture'
    const ts = document.createElement('div'); ts.className = 'ts'; ts.textContent = now(t)
    foot.append(cap, ts); bub.append(foot)
    row.append(bub); chat.appendChild(row); scroll()
  }

  /* hasil masuk riwayat + tampil (kalau masih di chat karakter itu) */
  function land(id, r) {
    const t = Date.now()
    record(id, { t, r: 'scene', u: r.url, p: r.prompt || '' })
    if (inChat(id)) { addScene({ t, u: r.url, p: r.prompt || '' }); if (typeof placeGoon === 'function' && !busy) placeGoon() }
  }

  /* ---------- Lampiran di kotak ketik (pola #attbar hadiah di shop.js) ---------- */
  const footer = document.querySelector('#chatview footer')
  let bar = null, subT = null
  const hint = () => (inp.value.trim() ? 'Prompt: dari ketikanmu' : 'Prompt: otomatis dari adegan')

  function paintBar() {
    if (!has()) { drop(); return } /* chat berpindah / keluar grup / keluar akun: lampiran dibuang, belum ada yang dibuat */
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'scnbar'; bar.setAttribute('aria-live', 'polite')
      footer.before(bar) /* di bawah #attbar hadiah, di atas footer (scene.css) */
    }
    bar.textContent = ''
    const chip = document.createElement('div'); chip.className = 'att-chip'
    chip.title = 'Ilustrasi dibuat saat pesan dikirim. Ketik promptnya di kotak ketik, atau kosongkan supaya disusun otomatis dari adegan.'
    const ics = document.createElement('span'); ics.className = 'att-ic'
    ics.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 16l4.5-4.5 3.5 3.5 3-3L21 17"/><circle cx="15.5" cy="9.5" r="1.6"/></svg>' /* ikon sama dengan menu + */
    const tx = document.createElement('span'); tx.className = 'att-tx'
    const t1 = document.createElement('b'), t2 = document.createElement('small')
    t1.textContent = 'Scene Capture'; t2.textContent = hint()
    subT = t2
    tx.append(t1, t2)
    const x = document.createElement('button'); x.type = 'button'; x.className = 'att-x'; x.title = 'Lepas ilustrasi'; x.setAttribute('aria-label', 'Lepas Scene Capture dari kotak ketik')
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    x.addEventListener('pointerdown', e => e.preventDefault()) /* tap tidak menutup keyboard */
    x.addEventListener('click', () => { disarm(); inp.focus({ preventScroll: true }) })
    chip.append(ics, tx, x); bar.append(chip)
  }
  function drop() { /* lepas lampiran: cabut bar + kembalikan placeholder asli */
    if (armed) { try { inp.placeholder = armed.ph } catch {}; armed = null }
    if (bar) { bar.remove(); bar = null; subT = null }
    if (typeof refresh === 'function') refresh()
  }
  function disarm() { drop() }

  /* ketikan berubah -> subjudul chip ikut ("dari ketikanmu" / "otomatis") */
  inp.addEventListener('input', () => { if (subT && has()) subT.textContent = hint() })
  /* pindah chat / masuk keluar grup / keluar akun: lampiran otomatis dilepas (pola renderAtt di shop.js) */
  new MutationObserver(() => { if (!has()) paintBar() }).observe(document.getElementById('hname'), { childList: true, characterData: true, subtree: true })
  window.addEventListener('acct', () => { if (!store.get('authtok')) paintBar() })

  /* ---------- Manual (menu "+"): pasang lampiran, belum membuat apa pun ---------- */
  function manual() {
    if (pending) { toast('Sabar, ilustrasi sebelumnya masih dibuat'); return }
    if (armed && armed.char === (ch && ch.id)) { inp.focus({ preventScroll: true }); return } /* sudah terpasang */
    if (!can()) { toast('Scene Capture belum tersedia di chat ini'); return }
    if (!store.get('authtok')) { toast('Masuk dulu untuk memakai Scene Capture'); return }
    armed = { char: ch.id, ph: inp.placeholder }
    inp.placeholder = 'Prompt ilustrasi (kosong = otomatis dari adegan)'
    paintBar(); refresh()
    inp.focus({ preventScroll: true })
  }

  /* ---------- Dikirim lewat submit() di index.html: ketikan (boleh kosong) = prompt ilustrasi ---------- */
  async function send(userPrompt) {
    const say = String(userPrompt || '').trim().slice(0, 600)
    if (pending) { toast('Sabar, ilustrasi sebelumnya masih dibuat'); return }
    if (!has() || !can()) { drop(); return } /* lampiran bukan milik chat ini (pindah chat/grup): dilepas diam-diam */
    if (!store.get('authtok')) { toast('Masuk dulu untuk memakai Scene Capture'); return }
    const id = ch.id
    drop() /* lepas lampiran + kembalikan placeholder */
    inp.value = ''; grow(); refresh(); clearTimeout(draftT); store.set('draft:' + id, null) /* prompt terpakai, kotak ketik dikosongkan */
    pending = { char: id }
    const load = loadBubble()
    try {
      const r = await sceneApi('manual', '', say)
      if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal membuat ilustrasi')
      load.remove()
      land(id, r) /* prompt = ketikan user (kalau diisi), kalau kosong server menyusun dari adegan */
    } catch (e) {
      load.remove()
      toast(e.message || 'Gagal membuat ilustrasi')
    }
    pending = null
  }

  /* ---------- Otomatis: dipanggil submit() setelah balasan AI tampil (maks satu per giliran) ---------- */
  async function auto(id, replyText) {
    try {
      if (pending || !ch || ch.id !== id || !ch.scene) return
      if (!(typeof rpOn === 'function' && rpOn())) return /* otomatis hanya saat Mode roleplay aktif */
      if (!inChat(id)) return
      const l = lastScene(id)
      if (l && Date.now() - (l.t || 0) < COOLDOWN) return /* jangan menggambar adegan yang nyaris sama berulang-ulang */
      if (!replyText || String(replyText).trim().length < 40) return /* balasan singkat: hampir pasti bukan adegan visual */
      const r = await sceneApi('auto', replyText)
      if (!r || !r.ok || r.skipped) return /* AI menilai tidak relevan -> diam saja */
      if (!r.url) return
      land(id, r)
    } catch { /* fitur otomatis gagal -> tidak mengganggu obrolan sama sekali */ }
  }

  /* ---------- Dipakai restoreChat() di index.html untuk menampilkan lagi ilustrasi lama ---------- */
  function render(e) { if (e && e.u) addScene(e) }

  window.SCENE = { manual, send, has, auto, render, can: () => can() }
})()

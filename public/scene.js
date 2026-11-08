/* ===== Scene Capture: AI mengilustrasikan adegan percakapan =====
   - Manual: dari menu "+" -> "Scene Capture" (public/shop.js). TIDAK memakai overlay: begitu dipilih,
     server langsung menyusun prompt dari konteks percakapan (tidak ada form prompt), dan hasilnya
     tampil sebagai LAMPIRAN GAMBAR di dalam percakapan — pola yang sama dengan lampiran Gift:
     tanpa modal, langsung di alur chat, tersimpan di riwayat (log:<id>).
   - Otomatis: setelah balasan AI tampil (dipanggil submit() di index.html), AI penilai di server yang
     memutuskan apakah adegannya layak divisualisasikan. Maks SATU kali per giliran, plus jeda minimum
     10 menit antar ilustrasi per karakter supaya adegan yang mirip tidak digambar berulang.
   - Hanya karakter dengan gambar referensi (ch.scene, dari field refImg char/<id>.js via /api/chars)
     yang memakai fitur ini; refImg sendiri tidak pernah sampai ke browser (lihat lib/scene.js).
   Memakai global index.html: ch, chat, app, uname, store, post, toast, scroll, now, ensureDay,
   loadHist, loadLog, record, restoring, rpOn, placeGoon. */
(() => {
  'use strict'
  if (window.SCENE) return

  const COOLDOWN = 10 * 60 * 1000 // jeda minimum ilustrasi otomatis per karakter
  let pending = null              // { char } -> ada permintaan manual yang sedang berjalan

  const inChat = id => !!(ch && ch.id === id && app.classList.contains('open') && !(window.GX && GX.cur))
  const can = () => !!(ch && ch.scene && inChat(ch.id))

  /* ilustrasi terakhir milik karakter ini dari riwayat (untuk menghindari adegan yang hampir sama) */
  function lastScene(id) {
    try {
      const l = loadLog(id)
      for (let i = l.length - 1; i >= 0; i--) if (l[i] && l[i].r === 'scene' && l[i].u && l[i].p) return l[i]
    } catch {}
    return null
  }

  async function sceneApi(mode, replyText) {
    const id = ch.id
    const l = lastScene(id)
    const body = {
      char: id, mode, userName: uname, reply: String(replyText || '').slice(0, 1200),
      history: loadHist(id),
      lastScene: l ? { prompt: l.p, mins: Math.max(0, Math.round((Date.now() - (l.t || 0)) / 60000)) } : null
    }
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

  /* ---------- Manual (menu "+"): tanpa overlay, langsung proses ---------- */
  async function manual() {
    if (pending) { toast('Sabar, ilustrasi sebelumnya masih dibuat'); return }
    if (!can()) { toast('Scene Capture belum tersedia di chat ini'); return }
    if (!store.get('authtok')) { toast('Masuk dulu untuk memakai Scene Capture'); return }
    const id = ch.id
    pending = { char: id }
    const load = loadBubble()
    try {
      const r = await sceneApi('manual', '')
      if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal membuat ilustrasi')
      load.remove()
      land(id, r) /* prompt tersusun dari konteks percakapan; user tidak perlu menulis apa pun */
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

  window.SCENE = { manual, auto, render, can: () => can() }
})()

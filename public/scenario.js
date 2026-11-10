/* ===== Skenario Skrip: mode roleplay dengan dua AI + skrip buatan sendiri =====
   - Scenario Director (AI 1) dan Character Actor (AI 2) hidup di server (lib/scenario.js);
     browser hanya membuka panel, menyimpan skrip (MongoDB via akun), dan menjalankan skenario.
   - Terintegrasi ke chat 1-lawan-1 yang sudah ada: tombol clapperboard di footer, panel modal,
     bar tipis "skenario aktif" di atas kolom ketik, dan kartu pembuka di area percakapan.
   - Bukan halaman/mode baru: semua muncul di dalam layar chat yang sama.
   Mengikuti aturan proyek: memakai global dari index.html (ch, chat, post, store, toast, dll),
   semua teks dari user/model ditulis lewat textContent, bukan innerHTML. */
(() => {
  if (window.SCN) return

  const CLAP = '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10.5" rx="1.6"/><path d="M4.8 10L4 6.3a1.6 1.6 0 011.2-1.9l12.3-2.9a1.6 1.6 0 011.9 1.2l.8 3.6"/><path d="M8.6 8.9L7.4 5.4M12.7 8l-1.2-3.5M16.8 7l-1.2-3.5"/></svg>'
  const SPIN = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9"/><path d="M21 3v6h-6"/></svg>'

  const S = { active: null, quota: null, scripts: null, edit: null, gen: false, busy: false, lastSync: 0, lastSyncChar: '' }
  const tok = () => store.get('authtok') || ''

  async function scnApi(path, body) {
    const r = await post('/api/scenario/' + path, body || {}, tok() ? { Authorization: 'Bearer ' + tok() } : undefined)
    const j = await r.json().catch(() => ({}))
    if (j && j.enabled === false) { const e = new Error('Fitur ini butuh MongoDB yang belum aktif di server.'); e.off = true; throw e }
    if (!j || j.ok !== true) throw new Error((j && j.error) || 'Gagal terhubung')
    return j
  }

  /* ---------- DOM: bar skenario aktif + modal panel ---------- */
  const app = $('app')
  const bar = document.createElement('div')
  bar.id = 'scnbar' /* disembunyikan lewat CSS (display:none), ditampilkan lewat class .show */
  bar.innerHTML = CLAP + '<span id="scnbar-t"></span><button id="scnend" type="button">End Script</button>'
  const footer = document.querySelector('#chatview footer')
  footer.parentElement.insertBefore(bar, footer)

  const modal = document.createElement('div')
  modal.id = 'scnmodal'
  modal.className = 'hide'
  modal.innerHTML = `
    <div class="scn-box" role="dialog" aria-modal="true" aria-labelledby="scntitle">
      <div class="scn-scroll">
        <div id="scn-list">
          <div class="scn-head"><h2 id="scntitle">Skenario Skrip</h2><button id="scnx" type="button" aria-label="Tutup panel"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
          <p class="scn-desc">Buat cerita unik anda sendiri dengan karakter dalam adegan bebas.</p>
          <div id="scn-lstat"></div>
          <div id="scn-cards"></div>
          <div class="scn-foot">
            <span class="scn-quota" id="scn-quota"></span>
            <button id="scn-add" type="button" class="scn-add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>+ Skrip Baru</button>
          </div>
        </div>
        <div id="scn-editor" class="hide">
          <div class="scn-head"><button id="scn-back" type="button" aria-label="Kembali ke daftar skrip"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><h2 id="scn-etitle">Skrip Baru</h2></div>
          <label class="scn-lab" for="scn-theme">Tema Skrip</label>
          <input id="scn-theme" class="scn-tin" maxlength="100" placeholder="Masukkan judul atau tema..." autocomplete="off" enterkeyhint="next">
          <label class="scn-lab" for="scn-content">Isi Skrip</label>
          <textarea id="scn-content" class="scn-ta" maxlength="1000" placeholder="Buat cerita baru dengan anda dan karakter anda..."></textarea>
          <div class="scn-crow"><span class="scn-count" id="scn-count">0/1000</span><button id="scn-gen" type="button" class="scn-gen">${SPIN}<span>AI Hasilkan</span></button></div>
          <p class="scn-msg" id="scn-emsg" role="status"></p>
          <div class="scn-acts">
            <button id="scn-run" type="button" class="scn-run">Jalankan Skrip</button>
            <button id="scn-save" type="button" class="scn-save">Simpan</button>
          </div>
        </div>
      </div>
    </div>`
  $('app').appendChild(modal)
  const panel = { modal, list: $('scn-list'), editor: $('scn-editor'), lstat: $('scn-lstat'), cards: $('scn-cards'), quota: $('scn-quota'), add: $('scn-add') }

  /* ---------- Tombol clapperboard di footer (index.html) ----------
     Skenario Skrip = fitur roleplay: hanya tampil saat Mode roleplay aktif di Pengaturan. */
  const btn = $('scnbtn')
  const rpReady = () => (typeof rpOn === 'function' ? rpOn() : true) /* guard kalau file ini ke-load sebelum index.html (tidak seharusnya) */
  function paintBtn() {
    const on = !!(app.classList.contains('open') && ch && !(window.GX && GX.cur) && rpReady())
    const act = !!(on && S.active && S.active.charId === ch.id)
    btn.classList.toggle('hide', !on)
    btn.classList.toggle('on', act)
    btn.title = act ? 'Skenario aktif: ' + S.active.title : 'Skenario Skrip'
  }
  btn.onclick = openPanel

  /* ---------- Bar tipis skenario aktif ---------- */
  function paintBar() {
    const on = !!(S.active && ch && S.active.charId === ch.id && app.classList.contains('open') && !(window.GX && GX.cur) && rpReady())
    bar.classList.toggle('show', on)
    if (on) $('scnbar-t').textContent = 'Skenario aktif: ' + S.active.title
    paintBtn()
  }
  $('scnend').onclick = () => endScenario()

  /* ---------- Panel: buka/tutup (selalu dalam konteks karakter yang sedang dibuka) ---------- */
  function openPanel() {
    if (!ch || (window.GX && GX.cur)) return
    $('scntitle').textContent = 'Skenario Skrip'
    $('scn-desc').textContent = 'Buat cerita unik anda sendiri bersama ' + (ch.name || 'karakter ini') + ' dalam adegan bebas.'
    modal.classList.remove('hide')
    showList()
    if (!tok()) { renderNeedLogin(); return }
    refreshList()
  }
  function closePanel() { modal.classList.add('hide') }
  modal.addEventListener('click', e => { if (e.target === modal) closePanel() })
  $('scnx').onclick = closePanel
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || modal.classList.contains('hide')) return
    e.stopPropagation()
    if (!panel.editor.classList.contains('hide')) showList() /* editor terbuka: balik ke daftar dulu */
    else closePanel()
  }, true)

  function showList() { panel.list.classList.remove('hide'); panel.editor.classList.add('hide') }
  function showEditor() { panel.list.classList.add('hide'); panel.editor.classList.remove('hide') }

  /* ---------- Daftar skrip + kuota ---------- */
  function paintQuota() {
    if (!S.quota) { panel.quota.textContent = ''; return }
    panel.quota.innerHTML = 'Skrip tersisa: <b></b>'
    panel.quota.querySelector('b').textContent = String(S.quota.left)
    panel.add.disabled = S.quota.left <= 0
    panel.add.title = S.quota.left <= 0 ? 'Kuota skrip penuh (maksimal ' + S.quota.max + '). Hapus salah satu untuk membuat baru.' : ''
  }

  function renderNeedLogin() {
    panel.cards.textContent = ''
    panel.quota.textContent = ''
    panel.add.disabled = true
    const box = document.createElement('div')
    box.className = 'scn-lstat'
    const h = document.createElement('h3'); h.textContent = 'Butuh akun'
    const p = document.createElement('p'); p.textContent = 'Skrip disimpan di akunmu supaya tidak tercampur dengan user lain. Masuk atau daftar dulu (butuh MongoDB aktif di server).'
    const b = document.createElement('button'); b.type = 'button'; b.className = 'scn-retry'; b.textContent = 'Masuk / Daftar'
    b.onclick = () => { closePanel(); openLogin() }
    box.append(h, p, b)
    panel.lstat.textContent = ''; panel.lstat.appendChild(box)
  }

  function renderStat(kind, msg) {
    panel.cards.textContent = ''
    const box = document.createElement('div'); box.className = 'scn-lstat'
    const h = document.createElement('h3'); h.textContent = kind === 'load' ? 'Memuat skrip\u2026' : kind === 'err' ? 'Gagal memuat' : 'Belum ada skrip'
    box.appendChild(h)
    if (msg) { const p = document.createElement('p'); p.textContent = msg; box.appendChild(p) }
    if (kind === 'err') {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'scn-retry'; b.textContent = 'Coba lagi'
      b.onclick = () => refreshList()
      box.appendChild(b)
    }
    if (kind === 'empty') {
      const p = document.createElement('p'); p.textContent = 'Ketuk "+ Skrip Baru" untuk mulai menulis ceritamu, atau pakai AI Hasilkan untuk membuat pembukaan cerita.'
      box.appendChild(p)
    }
    panel.lstat.textContent = ''; panel.lstat.appendChild(box)
  }

  async function refreshList() {
    if (!tok()) { renderNeedLogin(); return }
    renderStat('load')
    try {
      const r = await scnApi('list', ch ? { charId: ch.id } : {}) /* per karakter: hanya skrip milik karakter yang sedang dibuka */
      S.scripts = r.scripts
      S.quota = r.quota
      paintQuota()
      renderCards()
    } catch (e) {
      S.scripts = null
      renderStat('err', e.off ? e.message : 'Periksa koneksi lalu coba lagi.')
    }
  }

  function renderCards() {
    panel.lstat.textContent = ''
    panel.cards.textContent = ''
    if (!S.scripts || !S.scripts.length) { renderStat('empty'); return }
    S.scripts.forEach(s => panel.cards.appendChild(cardEl(s)))
  }

  /* card landscape: judul + cuplikan di kiri, avatar karakter di kanan dengan gradien transparan */
  function cardEl(s) {
    const c = s.charId ? charOf(s.charId) : null
    const card = document.createElement('div'); card.className = 'scn-card'

    const top = document.createElement('div'); top.className = 'scn-ctop'
    const info = document.createElement('div'); info.className = 'scn-cinfo'
    const t = document.createElement('div'); t.className = 'scn-ct'; t.textContent = s.title
    const x = document.createElement('div'); x.className = 'scn-cx'; x.textContent = s.content
    const d = document.createElement('div'); d.className = 'scn-cd'
    d.textContent = (c ? c.name : s.charId) + ' \u00b7 ' + new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
    info.append(t, x, d)

    const av = document.createElement('div'); av.className = 'scn-cav'
    av.appendChild(c ? img(c) : img({ name: s.charId || '?', avatar: '' }))
    top.append(info, av)

    const acts = document.createElement('div'); acts.className = 'scn-cacts'
    const bEdit = document.createElement('button'); bEdit.type = 'button'; bEdit.textContent = 'Edit'
    const bDel = document.createElement('button'); bDel.type = 'button'; bDel.className = 'scn-del'; bDel.textContent = 'Hapus'
    const bRun = document.createElement('button'); bRun.type = 'button'; bRun.className = 'scn-go'; bRun.textContent = 'Jalankan'
    bEdit.onclick = () => openEditor(s)
    bDel.onclick = () => {
      if (bDel.classList.contains('arm')) { bDel.classList.remove('arm'); bDel.textContent = 'Hapus'; deleteScript(s) }
      else { bDel.classList.add('arm'); bDel.textContent = 'Tap lagi'; setTimeout(() => { bDel.classList.remove('arm'); bDel.textContent = 'Hapus' }, 2600) }
    }
    bRun.onclick = () => runScript({ id: s.id })
    acts.append(bEdit, bDel, bRun)

    card.append(top, acts)
    return card
  }

  async function deleteScript(s) {
    try {
      const r = await scnApi('delete', { id: s.id, ...(ch ? { charId: ch.id } : {}) })
      S.quota = r.quota
      toast('Skrip dihapus, satu slot kembali')
      refreshList()
    } catch (e) { toast(e.message) }
  }

  /* ---------- Editor: buat/edit/AI hasilkan/jalankan/simpan ---------- */
  function openEditor(s) {
    S.edit = s ? s.id : 'new'
    $('scn-etitle').textContent = s ? 'Edit Skrip' : 'Skrip Baru'
    $('scn-theme').value = s ? s.title : ''
    $('scn-content').value = s ? s.content : ''
    $('scn-editor').dataset.charId = s ? s.charId : (ch ? ch.id : '')
    setMsg('')
    updateCount()
    showEditor()
    setTimeout(() => $(s ? 'scn-content' : 'scn-theme').focus(), 80)
  }
  panel.add.onclick = () => { if (!panel.add.disabled) openEditor(null) }
  $('scn-back').onclick = showList

  const setMsg = (m, kind) => { const el = $('scn-emsg'); el.textContent = m || ''; el.className = 'scn-msg' + (kind ? ' ' + kind : '') }
  function updateCount() {
    const n = $('scn-content').value.length, el = $('scn-count')
    el.textContent = n + '/1000'
    el.classList.toggle('max', n >= 1000)
  }
  $('scn-content').addEventListener('input', updateCount)

  /* AI Hasilkan: pembukaan cerita dari tema. Loading state + tombol dikunci sampai selesai. */
  $('scn-gen').onclick = async () => {
    if (S.gen) return
    const theme = $('scn-theme').value.trim()
    if (theme.length < 3) { setMsg('Tulis dulu tema skripnya (minimal 3 karakter) di kolom Tema Skrip.', 'err'); $('scn-theme').focus(); return }
    const charId = $('scn-editor').dataset.charId
    if (!charOf(charId)) { setMsg('Karakter tidak dikenal.', 'err'); return }
    S.gen = true
    const b = $('scn-gen')
    b.disabled = true; b.classList.add('busy'); b.querySelector('span').textContent = 'Membuat\u2026'
    setMsg('')
    try {
      const r = await scnApi('generate', { theme, charId, userName: uname })
      /* hasil AI sudah divalidasi backend: tepat satu paragraf, maks 900 karakter — tidak dipotong di sini */
      $('scn-content').value = r.content
      updateCount()
      setMsg('Hasil AI sudah masuk ke Isi Skrip. Bebas kamu edit sebelum disimpan atau dijalankan.', 'ok')
    } catch (e) { setMsg(e.message, 'err') }
    b.disabled = false; b.classList.remove('busy'); b.querySelector('span').textContent = 'AI Hasilkan'
    S.gen = false
  }

  const readEditor = () => ({
    title: $('scn-theme').value.trim(),
    content: $('scn-content').value.trim(),
    charId: $('scn-editor').dataset.charId
  })
  const validEditor = e => {
    if (!e.title) { setMsg('Tema skrip belum diisi.', 'err'); $('scn-theme').focus(); return false }
    if (!e.content) { setMsg('Isi skrip belum diisi.', 'err'); $('scn-content').focus(); return false }
    if (e.content.length > 1000) { setMsg('Isi skrip maksimal 1000 karakter.', 'err'); return false }
    return true
  }

  $('scn-save').onclick = async () => {
    if (S.busy) return
    const e = readEditor()
    if (!validEditor(e)) return
    S.busy = true; $('scn-save').disabled = true
    try {
      const r = await scnApi('save', { ...(S.edit !== 'new' ? { id: S.edit } : {}), title: e.title, content: e.content, charId: e.charId })
      S.quota = r.quota
      closePanel()
      toast(S.edit === 'new' ? 'Skrip tersimpan (sisa ' + r.quota.left + ')' : 'Perubahan skrip tersimpan')
    } catch (err) {
      setMsg(err.message, 'err')
      if (err.status === 409) { S.quota = { max: 3, left: 0 }; paintQuota() }
    }
    $('scn-save').disabled = false
    S.busy = false
  }

  /* Jalankan Skrip: tidak harus disimpan dulu; editor memakai isi yang sedang terlihat */
  $('scn-run').onclick = async () => {
    if (S.busy) return
    const e = readEditor()
    if (!validEditor(e)) return
    S.busy = true; $('scn-run').disabled = true
    try { await runScript(e) } catch (err) { setMsg(err.message, 'err') }
    $('scn-run').disabled = false
    S.busy = false
  }

  /* ---------- Menjalankan skenario ---------- */
  async function runScript(payload) {
    const r = await scnApi('start', payload)
    S.active = r.state
    closePanel()
    if (r.ended) toast('Skenario sebelumnya diakhiri: ' + (r.ended.length > 26 ? r.ended.slice(0, 26) + '\u2026' : r.ended))
    if (!ch || ch.id !== r.state.charId) {
      const c = charOf(r.state.charId)
      if (!c) throw new Error('Karakter skenario tidak dikenal.')
      openChat(c) /* skrip milik karakter lain: buka chat-nya dulu, panel menyusul setelah riwayat tampil */
    }
    await renderStartPanel(r.state)
    paintBar()
  }

  function removeStartPanel() { const el = $('scn-start'); if (el) el.remove() }

  /* tunggu riwayat chat selesai dirender supaya panel pembuka berada di paling bawah */
  function waitReady(charId) {
    return new Promise(res => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (ready || !ch || ch.id !== charId || Date.now() - t0 > 6000) { clearInterval(iv); res() }
      }, 120)
    })
  }

  /* Panel besar "skenario aktif" di area percakapan: judul, karakter, status, pilihan cara mulai, End Script */
  async function renderStartPanel(st) {
    if (!st || !ch || st.charId !== ch.id || !app.classList.contains('open')) return
    await waitReady(st.charId)
    if (!ch || ch.id !== st.charId) return
    removeStartPanel()
    const c = charOf(st.charId)
    const el = document.createElement('div'); el.className = 'scn-start'; el.id = 'scn-start'

    const top = document.createElement('div'); top.className = 'scn-sttop'; top.innerHTML = CLAP + '<span></span>'
    top.querySelector('span').textContent = 'Skenario aktif'
    const h = document.createElement('h3'); h.textContent = st.title
    const ch2 = document.createElement('div'); ch2.className = 'scn-stchar'
    ch2.appendChild(c ? img(c) : img({ name: st.charId, avatar: '' }))
    const nm = document.createElement('span'); nm.textContent = c ? c.name : st.charId
    ch2.appendChild(nm)
    const stat = document.createElement('p'); stat.className = 'scn-ststat'; stat.id = 'scn-ststat'
    const acts = document.createElement('div'); acts.className = 'scn-stacts'
    const bAi = document.createElement('button'); bAi.type = 'button'; bAi.className = 'scn-ai'; bAi.textContent = 'AI Mulai Duluan'
    const bMe = document.createElement('button'); bMe.type = 'button'; bMe.textContent = 'Saya Mulai Duluan'
    acts.append(bAi, bMe)
    const end = document.createElement('button'); end.type = 'button'; end.className = 'scn-stend'; end.textContent = 'End Script'

    if (st.phase === 'choosing') stat.textContent = 'Skrip sudah jadi fondasi cerita. Pilih siapa yang mulai adegan pembuka.'
    else if (st.first === 'user') stat.textContent = 'Skenario berjalan. ' + (c ? c.name : 'Karakter') + ' menunggu kamu memulai.'
    else stat.textContent = 'Skenario sedang berjalan.'

    bAi.onclick = () => beginScenario('ai')
    bMe.onclick = () => beginScenario('user')
    end.onclick = () => endScenario()

    el.append(top, h, ch2, stat, acts, end)
    chat.appendChild(el)
    scroll()
  }

  /* Pilih cara mulai: Director menyusun kondisi awal, lalu (AI duluan) Actor membuka adegan */
  async function beginScenario(mode) {
    if (S.busy || !S.active || !ch) return
    S.busy = true; busy = true; refresh() /* kunci ketik sebentar supaya adegan pembuka tidak tertabrak pesan lain */
    const panelEl = $('scn-start'), acts = panelEl && panelEl.querySelectorAll('.scn-stacts button')
    if (acts) acts.forEach(b => b.disabled = true)
    const stat = $('scn-ststat')
    if (stat) { stat.innerHTML = ''; stat.className = 'scn-ststat scn-think'; stat.textContent = mode === 'ai' ? 'Sutradara menyiapkan adegan, karakter membuka cerita\u2026' : 'Sutradara menyiapkan adegan\u2026' }
    try {
      const r = await scnApi('begin', {
        id: S.active.id, mode, clientId: cid, userName: uname,
        voice: { on: voiceOn && !!vcode, lang: voiceLang },
        rel: relPayload(ch.id), rp: rpOn()
      })
      S.active = r.state || S.active
      if (mode === 'ai' && r.reply) {
        removeStartPanel()
        await showReply(r.reply)
      } else if (mode === 'user') {
        removeStartPanel()
        toast((charOf(S.active.charId) ? charOf(S.active.charId).name : 'Karakter') + ' menunggu kamu memulai cerita')
      } else if (r.already) {
        removeStartPanel()
      }
      paintBar()
    } catch (e) {
      toast(e.message)
      if (stat) { stat.className = 'scn-ststat'; stat.textContent = 'Gagal memulai. Coba lagi atau ketuk End Script.' }
      if (acts) acts.forEach(b => b.disabled = false)
    }
    busy = false; refresh()
    S.busy = false
  }

  /* Balasan Actor ditampilkan lewat jalur yang sama dengan chat biasa: teks atau voice note */
  async function showReply(r) {
    if (!ch || !r || !r.id) return
    const chId = ch.id
    const relNote = relApply(chId, r.dExp != null ? r.dExp : (Math.round(Number(r.dRel)) || 0) * 3, r.dMood)
    saveHist(chId, [...loadHist(chId), ['char', r.id]])
    const useVoice = voiceOn && !!vcode, lang = voiceLang
    if (!useVoice) showThem(chId, r.id)
    else {
      const t = typingBubble(); setStatus('merekam suara', true)
      await speakReply(chId, r, lang, t)
    }
    setStatus('online', false)
    if (relNote) toast(relNote)
    maybeMemorize(chId)
  }

  /* ---------- End Script ---------- */
  async function endScenario(silent) {
    const st = S.active
    S.active = null
    removeStartPanel()
    paintBar()
    if (!st) return
    try { await scnApi('end', { id: st.id }) } catch { /* state sudah hilang di server pun tidak masalah */ }
    if (!silent) toast('Skenario "' + (st.title.length > 30 ? st.title.slice(0, 30) + '\u2026' : st.title) + '" telah diakhiri. Skrip tersimpan tidak terhapus.')
  }

  /* ---------- Sinkron state saat chat dibuka (lanjut setelah reload) ---------- */
  async function syncState() {
    if (!tok()) { S.active = null; paintBar(); return }
    try {
      const r = await scnApi('state', ch ? { charId: ch.id } : {}) /* skenario aktif PER KARAKTER (lib/scenario.js) */
      S.active = r.active || null
    } catch { return } /* gagal cek state: diam saja, jangan ganggu obrolan */
    if (S.active && ch && S.active.charId === ch.id && app.classList.contains('open') && !(window.GX && GX.cur)) {
      if (S.active.phase === 'choosing') renderStartPanel(S.active) /* belum pilih cara mulai (mis. habis reload): panel pembuka muncul lagi */
    }
    paintBar()
  }
  function maybeSyncState(c) {
    if (!c) { paintBar(); return }
    const k = c.id
    if (k === S.lastSyncChar && Date.now() - S.lastSync < 15000) { paintBar(); return }
    S.lastSync = Date.now(); S.lastSyncChar = k
    syncState()
  }

  /* ---------- Hook ke siklus buka/tutup chat (Shell dimuat sebelum file ini) ---------- */
  if (window.Shell) {
    const _open = Shell.afterOpen, _close = Shell.afterClose
    Shell.afterOpen = function (c) { if (_open) _open(c); paintBtn(); maybeSyncState(c) }
    Shell.afterClose = function () { if (_close) _close(); S.active = null; S.lastSyncChar = ''; bar.classList.remove('show'); paintBtn() }
  }
  /* status akun berubah (masuk/keluar dari Pengaturan saat chat terbuka) -> cek ulang skenario aktif */
  window.addEventListener('acct', () => { S.lastSyncChar = ''; S.lastSync = 0; syncState() })

  /* ---------- Jembatan ke submit() di index.html ---------- */
  window.SCN = {
    /* skenario hanya aktif saat Mode roleplay menyala — mati roleplay = balik ke chat biasa (state tetap tersimpan di server) */
    body(id) { return rpReady() && S.active && S.active.charId === id ? { scenario: S.active.id } : {} },
    headers() { return tok() ? { Authorization: 'Bearer ' + tok() } : {} },
    activeFor(id) { return !!(rpReady() && S.active && S.active.charId === id) },
    /* dipanggil submit() saat request chat gagal: error skenario -> bersihkan state lokal */
    onErr(e) {
      if (!e || !e.scn) return
      S.active = null
      removeStartPanel()
      paintBar()
    },
    refresh: syncState
  }

  /* Mode roleplay (Pengaturan) dinyalakan/dimatikan saat chat terbuka -> tampilkan/sembunyikan semua UI skenario */
  const srp = $('srp')
  if (srp) srp.addEventListener('change', () => { paintBar() })

  paintBtn()
})()

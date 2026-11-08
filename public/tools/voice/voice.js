/* ===== Tool: AI Voice =====
   Ketik teks -> pilih karakter (diambil dari daftar karakter yang sudah dimuat aplikasi) -> pilih suara (kalau karakternya punya lebih dari satu)
   -> "Buat suara". Memakai endpoint yang sama dengan voice note di chat: POST /api/tts (lib/app.js), jadi aturan servernya ikut:
   kode voice (header x-voice-code, sama dengan yang di Pengaturan), teks maks 800 karakter, pelafalan nama karakter diperbaiki otomatis kalau teksnya Jepang.
   Tidak ada kode server baru. Hasil cuma disimpan di memori halaman (8 terakhir), tidak masuk localStorage/IndexedDB.
   Global index.html yang dipakai: vcode (kode yang terbukti benar), voiceOn, paintVoice, store. */
Tools.register('voice', (() => {
'use strict';
const MAX = 800, KEEP = 8, KEY = 'tool:voice'
const TAGS = ['laughing', 'chuckling', 'whisper', 'soft', 'sad', 'excited', 'angry', 'surprised', 'sigh', 'gasp', 'pause', 'emphasis', 'shouting'] // sama dengan TAGS di lib/sessions.js
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const DL = '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>'

let c, host, el = {}, st = { text: '', char: '', voice: {}, q: '' }, results = [], busy = false, poll = 0, ctl = null

const save = () => { try { c.store.set(KEY, JSON.stringify({ char: st.char, voice: st.voice })) } catch {} }
const restore = () => { try { const j = JSON.parse(c.store.get(KEY) || '{}'); if (typeof j.char === 'string') st.char = j.char; if (j.voice && typeof j.voice === 'object') st.voice = j.voice } catch {} }
const chars = () => c.chars()
const cur = () => chars().find(x => x.id === st.char) || null
const vkey = ch => { const v = ch && ch.voices; if (!v) return ''; return v.some(x => x.key === st.voice[ch.id]) ? st.voice[ch.id] : v[0].key }
const vlabel = (ch, k) => (ch.voices && (ch.voices.find(x => x.key === k) || {}).label) || ''
const hasCode = () => typeof vcode !== 'undefined' && !!vcode

function shell() {
  host.innerHTML = `<div class="vx">
    <p class="tl-sub">Ubah teks jadi suara karakter. Pakai kode voice yang sama dengan voice note di chat.</p>
    <div class="tl-block">
      <div class="tl-label"><span>Teks</span><small class="vx-count" id="vxn">0/${MAX}</small></div>
      <textarea class="tl-field" id="vxt" maxlength="${MAX}" placeholder="Ketik kata yang mau diucapkan…" enterkeyhint="done"></textarea>
      <div class="vx-tags" id="vxtags" aria-label="Tag ekspresi (klik untuk menyisipkan)">${TAGS.map(t => `<button type="button" class="tl-chip" data-tag="${t}">[${t}]</button>`).join('')}</div>
    </div>
    <div class="tl-block">
      <div class="tl-label"><span>Karakter</span><small id="vxcn"></small></div>
      <div class="vx-dd" id="vxdd">
        <div class="tl-field vx-dt" id="vxdt">
          <span class="vx-pic" id="vxpic" aria-hidden="true"></span>
          <input id="vxq" type="text" role="combobox" aria-expanded="false" aria-controls="vxchars" aria-autocomplete="list" aria-label="Karakter" placeholder="Pilih atau cari karakter…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
          <svg class="vx-cv" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="vx-dm" id="vxdm" hidden><div class="vx-dl" id="vxchars" role="listbox" aria-label="Karakter"></div></div>
      </div>
    </div>
      </div>
    </div>
    <div class="tl-block" id="vxvb" hidden>
      <div class="tl-label"><span>Suara</span><small id="vxvn"></small></div>
      <div class="vx-voices" id="vxvoices" role="radiogroup" aria-label="Suara"></div>
    </div>
    <div class="vx-code" id="vxcode" hidden>
      <div class="tl-label" style="margin:0"><span>Kode voice dibutuhkan</span></div>
      <p class="tl-note" style="margin-top:4px">Masukkan kode yang sama dengan di Pengaturan → Fitur → Voice. Tanya owner kalau belum punya.</p>
      <div class="row"><input class="tl-field" id="vxci" placeholder="Kode voice" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="tl-btn" id="vxcb" type="button">Aktifkan</button></div>
      <p class="tl-note" id="vxce" hidden></p>
    </div>
    <button class="tl-btn pri full vx-go" id="vxgo" type="button">Buat suara</button>
    <div class="vx-res" id="vxres" aria-live="polite"></div>
  </div>`
  for (const k of ['vxdd', 'vxdt', 'vxpic', 'vxdm', 'vxt', 'vxn', 'vxtags', 'vxq', 'vxchars', 'vxcn', 'vxvb', 'vxvoices', 'vxvn', 'vxcode', 'vxci', 'vxcb', 'vxce', 'vxgo', 'vxres']) el[k] = host.querySelector('#' + k)
}

const av = x => `<img src="${esc(x.avatar || '')}" alt="" draggable="false" onerror="this.style.visibility='hidden'">`
let typing = false, act = -1 // typing = isi kolom adalah ketikan pencarian (bukan nama karakter terpilih); act = baris yang disorot panah
function paintTrigger() {
  const all = chars(), ch = cur()
  el.vxcn.textContent = all.length ? all.length + ' karakter' : ''
  el.vxpic.innerHTML = ch ? av(ch) : ''
  if (!typing) el.vxq.value = ch ? ch.name : ''
  el.vxq.placeholder = all.length ? 'Pilih atau cari karakter…' : 'Memuat karakter…'
}
function paintList() {
  const all = chars(), q = typing ? st.q.trim().toLowerCase() : ''
  if (!all.length) { el.vxchars.innerHTML = '<p class="vx-empty">Memuat karakter…</p>'; return }
  const list = q ? all.filter(x => (x.name + ' ' + x.id).toLowerCase().includes(q)) : all
  act = list.length && q ? 0 : -1
  el.vxchars.innerHTML = list.length ? list.map((x, i) => `<button type="button" role="option" tabindex="-1" class="vx-op${x.id === st.char ? ' on' : ''}${i === act ? ' act' : ''}" data-id="${esc(x.id)}" aria-selected="${x.id === st.char}">
      ${av(x)}<span>${esc(x.name)}</span>${x.voices ? `<em>${x.voices.length} suara</em>` : ''}</button>`).join('')
    : '<p class="vx-empty">Tidak ada karakter yang cocok.</p>'
}
function paintChars() { paintTrigger(); paintList() }
const isOpen = () => !el.vxdm.hidden
function setOpen(on) {
  if (!host || on === isOpen()) return
  el.vxdm.hidden = !on; el.vxq.setAttribute('aria-expanded', String(on)); el.vxdt.classList.toggle('open', on)
  if (on) { typing = false; st.q = ''; paintList(); const sel = el.vxchars.querySelector('.on'); if (sel) sel.scrollIntoView({ block: 'nearest' }) }
  else { typing = false; st.q = ''; paintTrigger() } // tutup tanpa memilih: kolom kembali menampilkan nama karakter terpilih
}
function pick(id) { st.char = id; save(); typing = false; st.q = ''; setOpen(false); paintAll(); el.vxq.blur() }
function moveAct(d) {
  const ops = [...el.vxchars.querySelectorAll('.vx-op')]; if (!ops.length) return
  act = Math.max(0, Math.min(ops.length - 1, (act < 0 ? (d > 0 ? -1 : ops.length) : act) + d))
  ops.forEach((o, i) => o.classList.toggle('act', i === act)); ops[act].scrollIntoView({ block: 'nearest' })
}
const onDoc = e => { if (host && isOpen() && !el.vxdd.contains(e.target)) setOpen(false) }
const onKey = e => { if (e.key === 'Escape' && host && isOpen()) { setOpen(false); el.vxq.blur() } }

function paintVoices() {
  const ch = cur(), multi = !!(ch && ch.voices)
  el.vxvb.hidden = !multi
  if (!multi) return
  const k = vkey(ch)
  el.vxvn.textContent = ch.name + ' punya ' + ch.voices.length + ' suara'
  el.vxvoices.innerHTML = ch.voices.map(v => `<button type="button" role="radio" class="tl-chip${v.key === k ? ' on' : ''}" data-k="${esc(v.key)}" aria-checked="${v.key === k}">${esc(v.label)}</button>`).join('')
}
function paintCode() { if (host) el.vxcode.hidden = hasCode() }
function paintGo() {
  if (!host) return // tool sudah ditutup selagi permintaan berjalan
  const n = [...st.text].length
  el.vxn.textContent = n + '/' + MAX; el.vxn.classList.toggle('over', n >= MAX)
  el.vxgo.disabled = busy || !st.text.trim() || !cur() || !hasCode()
  el.vxgo.innerHTML = busy ? '<span class="tl-spin"></span> Membuat suara…' : 'Buat suara'
}
function paintAll() { paintChars(); paintVoices(); paintCode(); paintGo() }

function addResult(r) {
  results.unshift(r)
  while (results.length > KEEP) URL.revokeObjectURL(results.pop().url)
  paintResults(true)
}
function paintResults(play) {
  if (!host) return
  el.vxres.innerHTML = results.map((r, i) => `<article class="vx-item">
    <div class="vx-hd"><img src="${esc(r.avatar)}" alt="" draggable="false" onerror="this.style.visibility='hidden'"><div><b>${esc(r.name)}</b><small>${esc(r.label ? r.label + ' · ' : '')}${r.time}</small></div><span class="sp"></span>
      <a href="${r.url}" download="${esc(r.file)}" aria-label="Unduh mp3" title="Unduh mp3">${DL}</a></div>
    <p>${esc(r.text)}</p><audio controls preload="auto" src="${r.url}"></audio></article>`).join('')
  if (play) { const a = el.vxres.querySelector('audio'); if (a) a.play().catch(() => {}) } // dipicu klik user, jadi diizinkan browser
}

async function generate() {
  const ch = cur(), text = st.text.trim()
  if (busy || !ch || !text) return
  if (!hasCode()) { paintCode(); return }
  busy = true; paintGo()
  const key = vkey(ch)
  try {
    ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 70000)
    const r = await fetch('/api/tts', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-voice-code': vcode }, body: JSON.stringify({ char: ch.id, text, voice: key }) })
    clearTimeout(t)
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'Gagal membuat suara'); e.status = r.status; throw e }
    const blob = new Blob([await r.arrayBuffer()], { type: 'audio/mpeg' })
    const d = new Date()
    addResult({ url: URL.createObjectURL(blob), name: ch.name, avatar: ch.avatar || '', label: vlabel(ch, key), text, time: d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      file: 'neyhra-' + ch.id + (key && ch.voices ? '-' + (ch.voices.findIndex(v => v.key === key) + 1) : '') + '-' + Date.now().toString(36) + '.mp3' })
  } catch (e) {
    if (e.status === 403) { // kode voice ditolak -> sama seperti di chat: kode dihapus, voice dimatikan
      try { vcode = ''; store.set('vcode', null); voiceOn = false; store.set('von', '0'); paintVoice() } catch {}
      c.toast('Kode voice tidak valid'); paintCode()
    } else c.toast(e.name === 'AbortError' ? 'Terlalu lama, coba lagi' : (e.message || 'Gagal membuat suara'))
  }
  busy = false; ctl = null; paintGo()
}

async function unlock() {
  const code = el.vxci.value.replace(/[^\x20-\x7e]/g, '').trim()
  if (!code || el.vxcb.disabled) return
  el.vxcb.disabled = true; el.vxce.hidden = true
  try {
    await c.post('/api/unlock', { code })
    vcode = code; store.set('vcode', code); el.vxci.value = ''
    paintCode(); paintGo(); c.toast('Kode voice aktif')
  } catch (e) {
    el.vxcode.classList.remove('shake'); void el.vxcode.offsetWidth; el.vxcode.classList.add('shake')
    el.vxce.hidden = false; el.vxce.textContent = e.status === 403 ? 'Kode salah. Tanya owner untuk petunjuknya.' : 'Gagal memeriksa kode, coba lagi.'
  }
  el.vxcb.disabled = false
}

function insertTag(tag) {
  const t = el.vxt, ins = '[' + tag + '] ', a = t.selectionStart ?? t.value.length, b = t.selectionEnd ?? a
  if ([...t.value].length + ins.length > MAX) return c.toast('Teks sudah mentok ' + MAX + ' karakter')
  t.setRangeText(ins, a, b, 'end'); t.focus(); st.text = t.value; paintGo()
}

function wire() {
  el.vxt.addEventListener('input', () => { st.text = el.vxt.value; paintGo() })
  el.vxtags.addEventListener('click', e => { const b = e.target.closest('[data-tag]'); if (b) insertTag(b.dataset.tag) })
  el.vxdt.addEventListener('click', () => { // klik di mana pun pada kolom (termasuk avatar/panah) = buka + fokus untuk mengetik
    if (!chars().length) return
    if (document.activeElement !== el.vxq) el.vxq.focus()
    setOpen(true); el.vxq.select() // teks nama terpilih ikut terblok, jadi langsung bisa ditimpa dengan ketikan
  })
  el.vxq.addEventListener('focus', () => { if (chars().length) { setOpen(true); el.vxq.select() } })
  el.vxq.addEventListener('input', () => { typing = true; st.q = el.vxq.value; if (!isOpen()) setOpen(true); paintList() })
  el.vxq.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!isOpen()) setOpen(true); else moveAct(e.key === 'ArrowDown' ? 1 : -1) }
    else if (e.key === 'Enter') { e.preventDefault(); const b = el.vxchars.querySelector('.vx-op.act') || (typing ? el.vxchars.querySelector('.vx-op') : null); if (b) pick(b.dataset.id) }
  })
  el.vxdd.addEventListener('focusout', e => { if (!el.vxdd.contains(e.relatedTarget)) setOpen(false) }) // Tab ke luar = tutup
  el.vxchars.addEventListener('pointerdown', e => e.preventDefault()) // jangan curi fokus dari kolom sebelum klik terdaftar
  el.vxchars.addEventListener('click', e => { const b = e.target.closest('.vx-op'); if (b) pick(b.dataset.id) })
  el.vxvoices.addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b || !st.char) return
    st.voice[st.char] = b.dataset.k; save(); paintVoices()
  })
  el.vxcb.addEventListener('click', unlock)
  el.vxci.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); unlock() } })
  el.vxgo.addEventListener('click', generate)
}

return {
  mount(h, ctx) {
    host = h; c = ctx; el = {}; restore()
    if (!chars().some(x => x.id === st.char)) st.char = '' // karakter tersimpan sudah tidak ada
    shell(); wire(); paintAll(); if (results.length) paintResults(false)
    el.vxt.value = st.text; paintGo()
    clearInterval(poll); document.addEventListener('pointerdown', onDoc); document.addEventListener('keydown', onKey)
    if (!chars().length) poll = setInterval(() => { if (chars().length) { clearInterval(poll); paintAll() } }, 300) // daftar karakter belum selesai dimuat
  },
  unmount() { clearInterval(poll); document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); if (ctl) ctl.abort(); host = null; el = {} } // hasil & teks tetap di memori; audio yang masih berjalan berhenti karena elemennya dilepas
}
})())

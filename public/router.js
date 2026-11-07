/* Router URL: tiap layar punya alamat sendiri, tetap satu aplikasi (tanpa muat ulang halaman).
     /               Beranda
     /chat           Obrolan Terakhir (termasuk chat grup yang lagi terbuka)
     /chat/<id>      Obrolan Terakhir dengan chat karakter terbuka (mis. /chat/reze)
     /global         Chat Global
     /bonus          Bonus (klaim harian, kode referal)
     /settings       Pengaturan
   Cara kerja: URL mengikuti layar yang tampil (diamati dari kelas DOM), dan tombol back/forward browser
   membuka/menutup layar lewat fungsi yang sudah ada. Tidak ada kode layar yang diubah.
   Server harus menjawab semua alamat di atas dengan index.html (vercel.json `rewrites` + lib/app.js untuk lokal). */
(() => {
  const $ = id => document.getElementById(id);
  const appEl = $('app'), setEl = $('smodal'), gcEl = $('gc');
  const ID_RE = /^[\w-]{1,64}$/
  let applying = 0, idx = 0, paths = [location.pathname] // paths[i] = alamat pada entri riwayat ke-i (hanya yang kita buat)

  const norm = p => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/'

  // alamat yang sesuai dengan layar yang sedang tampil (urutan = layar paling atas dulu)
  function curPath() {
    if (!setEl.classList.contains('hide')) return '/settings'
    if (gcEl.classList.contains('show')) return '/global'
    if (appEl.dataset.tab === 'bonus') return '/bonus'
    if (appEl.dataset.tab === 'recent') {
      if (appEl.classList.contains('open') && !(window.GX && GX.cur) && typeof ch !== 'undefined' && ch) return '/chat/' + ch.id
      return '/chat'
    }
    return '/'
  }

  const centerEl = () => ({ getBoundingClientRect: () => { const r = appEl.getBoundingClientRect(); return { left: r.left + r.width / 2, top: r.top + r.height / 2, width: 0, height: 0 } } })
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const chars = () => (typeof allChars !== 'undefined' ? allChars : []) // `allChars` itu let global (bukan properti window)

  // buat layar sesuai alamat (dipakai saat halaman dimuat, dan saat back/forward)
  async function apply(path) {
    path = norm(path)
    if (path === curPath()) return true
    applying++
    try {
      const m = /^\/chat\/([\w-]+)$/.exec(path)
      // 1) tutup yang menutupi: pengaturan, chat global
      if (path !== '/settings' && !setEl.classList.contains('hide')) $('sx').click()
      if (path !== '/global' && gcEl.classList.contains('show')) $('gc-back').click()
      // 2) layar tujuan
      if (path === '/settings') { if (setEl.classList.contains('hide')) $('setbtn').click() }
      else if (path === '/global') { if (!gcEl.classList.contains('show')) $('gcbtn').click() }
      else if (m) {
        for (let i = 0; i < 50 && !chars().length; i++) await wait(100) // tunggu daftar karakter dimuat
        const c = chars().find(x => x.id === m[1])
        if (!c) return false
        Shell.setTab('recent', { auto: false })
        openChat(c, centerEl()) // sudah terbuka/ganti chat lain ditangani openChat sendiri (ganti instan)
      } else if (path === '/bonus') {
        Shell.setTab('bonus', { auto: false })
      } else if (path === '/chat') {
        Shell.setTab('recent', { auto: false })
        if (appEl.classList.contains('open')) closeChat() // mobile: tampil daftar, desktop: placeholder
      } else {
        Shell.setTab('home', { auto: false }) // sekaligus menutup chat kalau terbuka
      }
      return true
    } finally { setTimeout(() => { applying-- ; sync() }, DUR + 250) } // animasi chat butuh DUR ms; setelah itu rapikan URL kalau layar akhirnya beda
  }

  // layar berubah (oleh user) -> perbarui URL
  function sync() {
    if (applying) return
    const p = curPath(), here = norm(location.pathname)
    if (p === here) return
    const target = p
    if (idx > 0 && paths[idx - 1] === target) { history.back(); return } // balik ke layar sebelumnya = mundur satu langkah, bukan menumpuk riwayat
    if (idx === 0 && here !== '/' && target === '/') { history.replaceState({ i: 0 }, '', target); paths[0] = target; return } // masuk lewat tautan langsung
    idx++; paths.length = idx; paths[idx] = target
    history.pushState({ i: idx }, '', target)
  }

  addEventListener('popstate', e => {
    idx = e.state && Number.isInteger(e.state.i) ? e.state.i : 0
    paths[idx] = norm(location.pathname)
    apply(location.pathname).then(ok => { if (ok === false) history.replaceState({ i: idx }, '', '/') })
  })

  const mo = new MutationObserver(() => { Promise.resolve().then(sync) })
  for (const [el, a] of [[appEl, 'class'], [appEl, 'data-tab'], [setEl, 'class'], [gcEl, 'class']]) mo.observe(el, { attributes: true, attributeFilter: [a] })

  // saat dimuat: alamat awal -> layar yang sesuai
  const start = norm(location.pathname)
  history.replaceState({ i: 0 }, '', location.pathname + location.search)
  if (start !== '/') apply(start).then(ok => { if (ok === false) history.replaceState({ i: 0 }, '', '/') })
})()

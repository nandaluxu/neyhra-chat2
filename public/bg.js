/* Latar belakang global: pilihan di Pengaturan + sorot kursor Latar 1. Gaya ada di bg.css. */
(() => {
  const root = document.documentElement, app = document.getElementById('app'), fx = document.getElementById('bgfx'), seg = document.getElementById('seg-bg')
  if (!app || !fx) return
  const get = () => { try { return localStorage.getItem('bg') } catch { return null } }
  const put = v => { try { v === '1' ? localStorage.removeItem('bg') : localStorage.setItem('bg', v) } catch {} }
  let cur = get() === '2' ? '2' : '1'

  function apply() {
    if (cur === '2') root.dataset.bg = '2'; else root.removeAttribute('data-bg')
    if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === cur))
  }
  if (seg) seg.onclick = e => { const b = e.target.closest('button'); if (!b || b.dataset.v === cur) return; cur = b.dataset.v; put(cur); apply() }
  apply()

  // Latar 1: sorot kisi titik mengikuti kursor (hanya mouse; HP/touch menyapu sendiri lewat CSS)
  if (!matchMedia('(hover:hover) and (pointer:fine)').matches || matchMedia('(prefers-reduced-motion:reduce)').matches) return
  let raf = 0, x = 0, y = 0
  const paint = () => { raf = 0; fx.style.setProperty('--px', x + 'px'); fx.style.setProperty('--py', y + 'px') }
  app.addEventListener('pointermove', e => {
    if (cur !== '1') return
    const r = app.getBoundingClientRect(); x = e.clientX - r.left; y = e.clientY - r.top
    if (!fx.classList.contains('hv')) fx.classList.add('hv')
    if (!raf) raf = requestAnimationFrame(paint)
  }, { passive: true })
  app.addEventListener('pointerleave', () => fx.classList.remove('hv'))
})()

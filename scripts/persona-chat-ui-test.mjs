// Uji UI kartu persona per-karakter di HALAMAN CHAT (public/index.html) dengan Playwright:
// /chat/<id> -> ketuk avatar karakter (panel Detail karakter) -> kartu persona -> pemilih persona ->
// pilih satu persona khusus untuk karakter itu -> persisten setelah reload -> karakter lain tidak
// terpengaruh -> mode profil akun / ikut default -> Escape -> "Kelola persona di Profil" -> tamu -> desktop.
// Jalankan: node scripts/persona-chat-ui-test.mjs   (server dari scripts/persona-ui-server.mjs harus jalan di 4573)
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:4573'
const shot = async (page, name) => page.screenshot({ path: '/tmp/persona-chat-ui/' + name + '.png' }).catch(() => { })

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok -', name) } else { fail++; console.error('  GAGAL -', name, extra ?? '') } }
const cardReady = page => page.waitForFunction(() => { const c = document.querySelector('#pecard'); return c && c.textContent && !/Memuat/.test(c.textContent) }, null, { timeout: 10000 }).then(() => true).catch(() => false)

// ---------- siapkan akun + 2 persona lewat API (endpoint sudah diuji persona-test.mjs / persona-e2e.mjs) ----------
const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ujichat', password: 'rahasia123' }) })).json()
ok('dapatkan token akun ujichat', !!reg.token)
const hdr = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token }
await fetch(BASE + '/api/auth/persona/save', { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Ayu Kartika', gender: 'f', bio: 'Penyuka kucing dan hujan.', def: true }) })
await fetch(BASE + '/api/auth/persona/save', { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Bima Saputra', gender: 'm', bio: 'Barista keliling.' }) })
const chars = await (await fetch(BASE + '/api/chars')).json()
const chA = chars.find(c => c.id === 'reze') || chars[0]
const chB = chars.find(c => c.id === 'aki') || chars[1]

const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }) // viewport ponsel: uji responsif
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && !/favicon|speed-insights|401|404|Failed to load resource|net::/i.test(m.text())) errs.push(m.text()) })
  await page.addInitScript(t => { try { localStorage.setItem('authtok', t) } catch { } }, reg.token)

  console.log('\n[1] Buka /chat/' + chA.id + ' (router membuka chat karakter)')
  await page.goto(BASE + '/chat/' + chA.id, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  ok('chat terbuka', await page.locator('#app.open').count() === 1)
  ok('header memuat nama karakter', (await page.locator('#hname').textContent()) === chA.name)

  console.log('\n[2] Panel Detail karakter + kartu persona')
  await page.locator('#hpfp').click() // ketuk avatar karakter di header -> openRel()
  await page.waitForTimeout(900)
  ok('panel detail terbuka (dp-on)', await page.locator('#app.dp-on').count() === 1)
  ok('bagian Persona tampil', await page.locator('#dpers:not(.hide)').count() === 1)
  ok('kartu persona selesai dimuat', await cardReady(page))
  let ct = await page.locator('#pecard').textContent()
  ok('kartu menampilkan persona default', ct.includes('Ayu Kartika'), JSON.stringify(ct))
  ok('kartu menyebut sumber (default)', ct.includes('default'))
  await shot(page, '01-detail-kartu')

  console.log('\n[3] Ketuk kartu -> pemilih persona (layout daftar seluruh persona)')
  await page.locator('#pecard').click()
  await page.waitForTimeout(400)
  ok('pemilih persona terbuka', await page.locator('#pemodal:not(.hide)').count() === 1)
  ok('jumlah opsi benar (ikut default + 2 persona + profil akun)', await page.locator('#pelist .pe-opt').count() === 4)
  ok('opsi terpilih = Ikut persona default', (await page.locator('#pelist .pe-opt[aria-checked="true"] b').textContent()) === 'Ikut persona default')
  ok('subtitle menyebut nama karakter', (await page.locator('#pesub').textContent()).includes(chA.name.split(' ')[0]))
  ok('persona kedua ikut tampil', (await page.locator('#pelist').textContent()).includes('Bima Saputra'))
  await shot(page, '02-pemilih')

  console.log('\n[4] Pilih Bima Saputra khusus untuk karakter ini')
  await page.locator('#pelist .pe-opt', { hasText: 'Bima Saputra' }).click()
  await page.waitForTimeout(900)
  ok('pemilih tertutup setelah memilih', await page.locator('#pemodal:not(.hide)').count() === 0)
  ok('toast konfirmasi muncul', (await page.locator('#toast').textContent()).includes('Bima Saputra'))
  ct = await page.locator('#pecard').textContent()
  ok('kartu memuat Bima Saputra', ct.includes('Bima Saputra'), JSON.stringify(ct))
  ok('kartu menyebut "khusus" untuk karakter ini', ct.includes('khusus'))
  await shot(page, '03-setelah-pilih')

  console.log('\n[5] Pilihan persisten setelah reload (tersimpan di akun, bukan di halaman)')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.locator('#hpfp').click()
  await page.waitForTimeout(600)
  ok('kartu termuat ulang', await cardReady(page))
  ct = await page.locator('#pecard').textContent()
  ok('pilihan Bima Saputra bertahan setelah reload', ct.includes('Bima Saputra'), JSON.stringify(ct))

  console.log('\n[6] Karakter lain tidak terpengaruh (masih persona default)')
  await page.goto(BASE + '/chat/' + chB.id, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.locator('#hpfp').click()
  await page.waitForTimeout(600)
  ok('kartu karakter kedua termuat', await cardReady(page))
  ct = await page.locator('#pecard').textContent()
  ok('karakter kedua tetap memakai persona default', ct.includes('Ayu Kartika') && ct.includes('default'), JSON.stringify(ct))

  console.log('\n[7] Mode "Profil akun" (tanpa persona untuk karakter ini)')
  await page.locator('#pecard').click()
  await page.waitForTimeout(300)
  await page.locator('#pelist .pe-opt', { hasText: 'Profil akun' }).click()
  await page.waitForTimeout(900)
  ct = await page.locator('#pecard').textContent()
  ok('kartu mode profil akun', ct.includes('Profil akun'), JSON.stringify(ct))

  console.log('\n[8] Kembali "Ikut persona default"')
  await page.locator('#pecard').click()
  await page.waitForTimeout(300)
  await page.locator('#pelist .pe-opt', { hasText: 'Ikut persona default' }).click()
  await page.waitForTimeout(900)
  ct = await page.locator('#pecard').textContent()
  ok('kartu kembali ke persona default', ct.includes('Ayu Kartika'), JSON.stringify(ct))

  console.log('\n[9] Escape menutup pemilih')
  await page.locator('#pecard').click()
  await page.waitForTimeout(300)
  ok('pemilih terbuka lagi', await page.locator('#pemodal:not(.hide)').count() === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  ok('Escape menutup pemilih', await page.locator('#pemodal:not(.hide)').count() === 0)

  console.log('\n[10] Tombol "Kelola persona di Profil"')
  await page.locator('#pecard').click()
  await page.waitForTimeout(300)
  await page.locator('#pemanage').click()
  await page.waitForTimeout(1400)
  ok('beralih ke halaman Profil', page.url().endsWith('/profile'), page.url())
  ok('tab Persona langsung aktif', (await page.locator('.pf-tab[aria-selected="true"]').textContent()) === 'Persona')
  ok('daftar persona tampil di Profil', await page.locator('.pf-pcard:not(.add)').count() === 2)
  await shot(page, '04-kelola-di-profil')

  console.log('\n[11] Tamu (belum masuk): kartu mengarah ke login')
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const pg2 = await ctx2.newPage()
  const errs2 = []
  pg2.on('pageerror', e => errs2.push(e.message))
  await pg2.goto(BASE + '/chat/' + chA.id, { waitUntil: 'networkidle' })
  await pg2.waitForTimeout(1500)
  await pg2.locator('#hpfp').click()
  await pg2.waitForTimeout(600)
  const ct2 = await pg2.locator('#pecard').textContent()
  ok('tamu: kartu menyuruh masuk akun', ct2.includes('Masuk akun'), JSON.stringify(ct2))
  await pg2.locator('#pecard').click()
  await pg2.waitForTimeout(400)
  ok('tamu: ketuk kartu membuka overlay login', await pg2.locator('#lmodal:not(.hide)').count() === 1)
  ok('tamu: tidak ada error JS', errs2.length === 0, errs2.join(' | '))
  await ctx2.close()

  console.log('\n[12] Desktop: panel detail otomatis tampil di samping chat')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(BASE + '/chat/' + chA.id, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  ok('desktop: panel detail otomatis terbuka', await page.locator('#app.dp-on').count() === 1)
  ok('desktop: kartu persona termuat', await cardReady(page))
  ct = await page.locator('#pecard').textContent()
  ok('desktop: kartu persona tampil benar', ct.includes('Persona'), JSON.stringify(ct))
  await page.locator('#pecard').click()
  await page.waitForTimeout(300)
  ok('desktop: pemilih bisa dibuka', await page.locator('#pemodal:not(.hide)').count() === 1)
  await shot(page, '05-desktop')
  ok('tidak ada error JS sepanjang sesi', errs.length === 0, errs.join(' | '))
  await ctx.close()
} finally {
  await browser.close()
}

console.log(`\nSelesai UI chat: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)

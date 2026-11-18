// Uji UI tab Persona (public/profile.js) headless dengan Playwright:
// login -> Profil -> tab Persona -> buat persona (nama/gender/profil/default) -> kartu tampil ->
// toggle default di kartu -> edit nama -> hapus -> chat mengirim prompt dengan nama persona.
// Jalankan: node scripts/persona-ui-test.mjs   (server dari scripts/persona-ui-server.mjs harus jalan di 4573)
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:4573'
const shot = async (page, name) => page.screenshot({ path: '/tmp/persona-ui/' + name + '.png' }).catch(() => { })

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok -', name) } else { fail++; console.error('  GAGAL -', name, extra ?? '') } }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }) // viewport ponsel: uji responsif
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(e.message))
page.on('console', m => { if (m.type() === 'error' && !/favicon|speed-insights|401|404| Failed to load resource/i.test(m.text())) errs.push(m.text()) })

try {
  console.log('\n[1] Login + buka Profil')
  const token = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ujiui', password: 'rahasia123' }) })).json()).token
  ok('dapat token sesi', !!token)
  await page.addInitScript(t => { try { localStorage.setItem('authtok', t) } catch { } }, token)
  await page.goto(BASE + '/profile', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  ok('profil terbuka (kartu nama tampil)', await page.locator('.pf-card').count() === 1)
  ok('tidak ada error JS saat muat', errs.length === 0, errs.join(' | '))
  await shot(page, '01-profil')

  console.log('\n[2] Tab Persona muncul + empty state')
  await page.locator('.pf-tab', { hasText: 'Persona' }).click()
  await page.waitForTimeout(600)
  ok('tab Persona aktif', await page.locator('.pf-tab[aria-selected="true"]').textContent() === 'Persona')
  ok('empty state tampil', (await page.locator('.pf-empty').textContent() || '').includes('Belum ada persona'))
  await shot(page, '02-tab-persona-kosong')

  console.log('\n[3] Buat persona lewat form')
  await page.locator('[data-act="psadd"]').first().click()
  await page.waitForTimeout(400)
  ok('modal form terbuka', await page.locator('#pfmodal').count() === 1)
  await page.fill('#psname', 'Ayu Pratiwi')
  await page.locator('[data-act="psgen-f"]').click()
  await page.fill('#psbio', 'Mahasiswa psikologi yang suka kucing dan novel misteri.')
  await page.locator('#psdef').click() // aktifkan default
  ok('switch default menyala', await page.locator('#psdef').getAttribute('aria-checked') === 'true')
  await page.locator('#pssave').click()
  await page.waitForTimeout(800)
  ok('modal tertutup setelah simpan', await page.locator('#pfmodal').count() === 0)
  ok('kartu persona tampil', await page.locator('.pf-pcard:not(.add)').count() === 1)
  ok('nama persona di kartu', (await page.locator('.pf-pcard b').first().textContent()) === 'Ayu Pratiwi')
  ok('chip gender Perempuan', (await page.locator('.pf-pgen').first().textContent()) === 'Perempuan')
  ok('kartu ditandai default', await page.locator('.pf-pcard.def').count() === 1)
  await shot(page, '03-kartu-persona')

  console.log('\n[4] Tambah persona kedua + default pindah')
  await page.locator('.pf-pcard.add').click()
  await page.fill('#psname', 'Raka')
  await page.locator('[data-act="psgen-m"]').click()
  await page.locator('#pssave').click()
  await page.waitForTimeout(800)
  ok('dua kartu persona', await page.locator('.pf-pcard:not(.add)').count() === 2)
  ok('tetap satu default (Ayu)', await page.locator('.pf-pcard.def').count() === 1)
  const rakaCard = page.locator('.pf-pcard:not(.add)', { hasText: 'Raka' })
  await rakaCard.locator('[data-act="pdef"]').click()
  await page.waitForTimeout(800)
  ok('default pindah ke Raka (satu-satunya)', await page.locator('.pf-pcard.def').count() === 1 && (await page.locator('.pf-pcard.def b').textContent()) === 'Raka')
  await shot(page, '04-default-pindah')

  console.log('\n[5] Edit persona')
  await page.locator('.pf-pcard.def').click() // klik kartu = edit
  await page.waitForTimeout(400)
  ok('form edit terbuka berisi nama lama', (await page.inputValue('#psname')) === 'Raka')
  await page.fill('#psname', 'Raka Aditya')
  await page.locator('#pssave').click()
  await page.waitForTimeout(800)
  ok('nama berubah di kartu', (await page.locator('.pf-pcard.def b').textContent()) === 'Raka Aditya')

  console.log('\n[6] Hapus persona (konfirmasi)')
  await page.locator('.pf-pcard:not(.add)', { hasText: 'Ayu' }).locator('[data-act="pdel"]').click()
  await page.waitForTimeout(400)
  ok('modal konfirmasi muncul', (await page.locator('#pfmodal .pf-dtxt').textContent() || '').includes('Ayu'))
  await page.locator('[data-act="psdelok"]').click()
  await page.waitForTimeout(800)
  ok('persona Ayu terhapus', await page.locator('.pf-pcard:not(.add)').count() === 1)

  console.log('\n[7] Lepas default')
  await page.locator('.pf-pcard.def [data-act="pdef"]').click()
  await page.waitForTimeout(800)
  ok('tidak ada kartu default', await page.locator('.pf-pcard.def').count() === 0)
  await shot(page, '05-tanpa-default')

  console.log('\n[8] Chat memakai nama persona default (integrasi)')
  // jadikan Raka default lagi lewat API, lalu kirim chat dan lihat balasan + cek prompt lewat balasan AI tiruan tidak terlihat.
  // Cukup pastikan /api/chat 200 dan tidak ada error — prompt sudah diverifikasi scripts/persona-e2e.mjs.
  const tok = await page.evaluate(() => localStorage.getItem('authtok'))
  const list = await (await fetch(BASE + '/api/auth/persona/list', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' })).json()
  await fetch(BASE + '/api/auth/persona/default', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ id: list.personas[0].id }) })
  const chars = await (await fetch(BASE + '/api/chars')).json()
  const chat = await (await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ clientId: 'ui-test-cid', char: chars[0].id, message: 'halo', userName: 'ujiui' }) })).json()
  ok('chat 1-lawan-1 tetap jalan dengan persona default', !!chat.id)

  console.log('\n[9] Pengaturan & tab lain tidak rusak')
  await page.locator('.pf-tab', { hasText: 'Ringkasan' }).click()
  await page.waitForTimeout(400)
  ok('tab Ringkasan tetap jalan', await page.locator('.pf-tiles').count() === 1)
  await page.locator('.pf-tab', { hasText: 'Karakter' }).click()
  await page.waitForTimeout(400)
  ok('tab Karakter tetap jalan', await page.locator('.pf-list, .pf-empty').count() >= 1)
  ok('tidak ada error JS sepanjang sesi', errs.length === 0, errs.join(' | '))
  await shot(page, '06-tab-lain')

  console.log('\n[10] Desktop (responsif)')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('.pf-tab', { hasText: 'Persona' }).click()
  await page.waitForTimeout(400)
  ok('grid persona di desktop', await page.locator('.pf-pgrid').count() === 1)
  await shot(page, '07-desktop')
} finally {
  await browser.close()
}

console.log(`\nSelesai UI: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)

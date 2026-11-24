// Uji UI fitur import link YouTube + seksi "Lagu tersimpan di server" (public/music.js ASLI).
// Headless Playwright; server tiruan dari scripts/music-ui-server.mjs harus jalan di 4581
// (biasanya dinyalakan otomatis oleh pemanggil). Jalankan: node scripts/music-ui-test.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const BASE = 'http://127.0.0.1:4581'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok -', name) } else { fail++; console.error('  GAGAL -', name, extra) } }
const state = async () => await (await fetch(BASE + '/__state')).json()

/* pastikan server tiruan jalan */
let srvProc = null
try { await fetch(BASE + '/__state') } catch {
  srvProc = spawn(process.execPath, ['scripts/music-ui-server.mjs'], { stdio: 'ignore' })
  for (let i = 0; i < 30; i++) { try { await fetch(BASE + '/__state'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
const errs = []
page.on('pageerror', e => errs.push(e.message))
page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errs.push(m.text()) })
const shot = (n) => page.screenshot({ path: '/tmp/music-ui/' + n + '.png' }).catch(() => { })

try {
  console.log('[1] Muat tab Musik')
  await page.goto(BASE + '/music', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  ok('halaman musik tampil tanpa error JS', errs.length === 0, errs.join(' | '))
  ok('kolom cari ada (placeholder link YouTube)', (await page.locator('#muq').getAttribute('placeholder')).includes('link YouTube'))
  await page.waitForTimeout(600)
  ok('seksi "Lagu tersimpan di server" tampil', await page.locator('section[data-sec="srv"]').count() === 1)
  ok('2 kartu lagu server', await page.locator('section[data-sec="srv"] .mu-card').count() === 2)
  ok('badge PERMANEN di kartu', await page.locator('section[data-sec="srv"] .pin').count() === 2)
  await shot('01-beranda')

  console.log('[2] Tempel link YouTube -> import')
  await page.fill('#muq', 'https://youtu.be/IMPORTTEST1')
  await page.press('#muq', 'Enter')
  await page.waitForTimeout(500)
  ok('kartu import muncul', await page.locator('.mu-impc').count() === 1)
  ok('judul lagu import tampil', (await page.locator('.mu-impc .si b').textContent()) === 'Lagu Import Uji')
  ok('status awal = mengunduh', (await page.locator('.mu-impc .st').textContent()).includes('Mengunduh'))
  await shot('02-import-mengunduh')
  const st1 = await state()
  ok('/api/music/import dipanggil dengan id benar', st1.imported.includes('IMPORTTEST1'))
  /* poll tiap 4 dtk: poll pertama 'downloading', kedua 'ok' -> tunggu ±9 dtk */
  await page.waitForTimeout(9500)
  ok('status jadi Tersimpan permanen', (await page.locator('.mu-impc .st').textContent()).includes('Tersimpan permanen'))
  ok('kartu tombol Putar ada', await page.locator('.mu-impc [data-imp="play"]').count() === 1)
  await shot('03-import-siap')

  console.log('[3] Kartu import: klik Putar')
  await page.click('.mu-impc [data-imp="play"]')
  await page.waitForTimeout(1200)
  const src = await page.evaluate(() => document.querySelector('audio').src)
  ok('audio memutar dari stub (/api/music/audio)', src.includes('/api/music/audio?id=IMPORTTEST1'))
  ok('mini player aktif', await page.locator('#mupl.on').count() === 1)
  ok('tanpa error JS sampai sini', errs.length === 0, errs.join(' | '))

  console.log('[4] Pencarian biasa tetap jalan (bukan import)')
  await page.fill('#muq', 'monokrom tulus')
  await page.press('#muq', 'Enter')
  await page.waitForTimeout(500)
  ok('hasil pencarian tampil (2 lagu)', await page.locator('.mu-song').count() === 2)
  ok('kartu import hilang saat cari judul', await page.locator('.mu-impc').count() === 0)

  console.log('[5] Halaman "Lihat semua" lagu server')
  await page.fill('#muq', '')
  await page.waitForTimeout(300)
  await page.click('section[data-sec="srv"] [data-more="srv"]')
  await page.waitForTimeout(400)
  ok('halaman server terbuka', (await page.locator('.mu-plm h1').textContent()) === 'Lagu tersimpan di server')
  ok('3 baris lagu (2 lama + import)', await page.locator('#msrvtrs .mu-tr').count() === 3)
  ok('tombol hapus ada di tiap baris', await page.locator('#msrvtrs [data-del]').count() === 3)
  await shot('04-halaman-server')

  console.log('[6] Hapus lagu server (ketuk 2x)')
  const delTarget = await page.locator('#msrvtrs [data-del="SRVSONG00001"]')
  await delTarget.click()
  await page.waitForTimeout(200)
  ok('ketukan pertama hanya mengokang (baris masih ada)', await page.locator('#msrvtrs [data-del="SRVSONG00001"]').count() === 1)
  await delTarget.click()
  await page.waitForTimeout(700)
  ok('baris hilang setelah ketukan kedua', await page.locator('#msrvtrs [data-del="SRVSONG00001"]').count() === 0)
  ok('2 baris tersisa', await page.locator('#msrvtrs .mu-tr').count() === 2)
  const st2 = await state()
  ok('/api/music/library/remove dipanggil', st2.removed.includes('SRVSONG00001'))
  await shot('05-setelah-hapus')

  console.log('[7] Klik baris lagu server -> putar')
  await page.click('#msrvtrs .mu-tr')
  await page.waitForTimeout(1000)
  const src2 = await page.evaluate(() => document.querySelector('audio').src)
  ok('audio memutar lagu server', src2.includes('/api/music/audio?id='))
  ok('tanpa error JS di akhir', errs.length === 0, errs.join(' | '))
  await shot('06-putar-lagu-server')
} catch (e) {
  fail++
  console.error('  GAGAL - tes melempar: ' + e.message)
  await shot('99-error')
} finally {
  await browser.close()
  if (srvProc) srvProc.kill('SIGKILL')
}

console.log('')
console.log(`Hasil UI: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)

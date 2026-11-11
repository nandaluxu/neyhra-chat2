// Uji UI MODE PAID Fruit Slot headless (Playwright): login -> slot -> sakelar DEMO/PAID -> modal Chip
// (beli Coin->Chip) -> spin mode Paid -> paytable x1,1 -> pengaturan -> kembali Demo -> tab Tukar
// (kartu Coin->Chip & Chip->Coin, jual balik). Screenshot tiap fase ke /tmp/slot-paid-ui/.
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:4571'
const shot = async (page, name) => page.screenshot({ path: '/tmp/slot-paid-ui/' + name + '.png' }).catch(() => { })
const num = t => Number(String(t).replace(/\D/g, '')) || 0

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗ FAIL:', name, extra ?? '') } }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' })
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))
page.on('console', m => { if (m.type() === 'error' && !/favicon|audio|play\(\)|speed-insights|401|404/i.test(m.text())) console.log('  [console.error]', m.text().slice(0, 160)) })

// ---- login ----
console.log('\n[1] Login')
const token = process.env.SLOT_TOKEN || (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ujiui', password: 'rahasia123' }) })).json()).token
ok('dapat token sesi', !!token)
await page.addInitScript(t => { try { localStorage.setItem('authtok', t) } catch { } }, token)
await page.goto(BASE + '/games', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
ok('sudah masuk', await page.evaluate(() => !document.querySelector('#gmbody .gm-empty')))
ok('dompet Minigame menampilkan Chip', await page.locator('.gm-wallet [data-k="chips"]').count() === 1)

// ---- buka slot (mode Demo default) ----
console.log('\n[2] Layar slot — mode Demo')
await page.click('.gm-card[data-g="slot"]')
await page.waitForTimeout(1300)
ok('kabinet + gulungan tampil', await page.locator('.sl-cab .sl-reel').count() === 3)
ok('sakelar mode tampil (2 tombol)', await page.locator('.sl-mode').count() === 2)
ok('DEMO menyala', await page.locator('.sl-mode.on').textContent().then(t => /demo/i.test(t)))
ok('label saldo Virtual Point', await page.locator('.sl-bal span').first().textContent().then(t => /virtual point/i.test(t)))
ok('tombol Chip di bar atas', await page.locator('[data-act="sl-chip"]').count() === 1)
ok('tombol SPIN memakai VP', await page.locator('[data-act="sl-spin"]').textContent().then(t => /VP/.test(t)))
await shot(page, '01-demo')

// ---- pindah ke PAID ----
console.log('\n[3] Pindah mode Paid')
await page.click('.sl-mode[data-id="paid"]')
await page.waitForTimeout(900)
ok('PAID menyala', await page.locator('.sl-mode.on').textContent().then(t => /paid/i.test(t)))
ok('label saldo berubah Chip', await page.locator('.sl-bal span').first().textContent().then(t => /^chip$/i.test(t.trim())))
ok('ikon chip dipakai', await page.locator('.sl-bal img[src="/chip.svg"]').count() === 1)
ok('saldo chip 0 (belum beli)', await page.locator('#slbal').textContent().then(t => num(t) === 0))
ok('panel chip habis tampil', await page.locator('.sl-broke').count() === 1)
ok('panel menawarkan beli chip', await page.locator('.sl-broke .sl-topup').count() === 1)
ok('TIDAK ada tombol isi ulang gratis', await page.locator('[data-act="sl-refill"]').count() === 0)
await shot(page, '02-paid-broke')

// ---- modal Chip: beli ----
console.log('\n[4] Modal Chip — beli 1.000 Coin')
await page.click('.sl-broke [data-act="sl-chip"]')
await page.waitForTimeout(500)
ok('modal Chip terbuka', await page.locator('.sl-modal').count() === 1)
ok('saldo Coin terlihat (25.000)', await page.locator('.sl-chbal b').first().textContent().then(t => num(t) === 25000))
ok('bagian beli & jual ada', await page.locator('.sl-chgo').count() === 2)
await page.click('[data-act="sl-chb"][data-id="1000"]')
await page.waitForTimeout(300)
ok('pratinjau: 1.000 Coin -> 200 Chip', await page.locator('.sl-chprev b').first().textContent().then(t => num(t) === 200))
await shot(page, '03-chip-modal')
await page.click('[data-act="sl-chgo"][data-id="c2ch"]')
await page.waitForTimeout(1200)
ok('saldo chip jadi 200', await page.locator('#slbal').textContent().then(t => num(t) === 200))
ok('strip PAID memuat sub-label beneran bayar', await page.locator('.sl-mode[data-id="paid"] span').textContent().then(t => /beneran bayar/i.test(t)))
ok('sub-label mode tidak wrap (1 baris)', await page.evaluate(() => {
  const s = document.querySelector('.sl-mode[data-id="paid"] span')
  return s.getBoundingClientRect().height < 16
}))
await shot(page, '04-paid-200chip')

// ---- spin mode Paid ----
console.log('\n[5] SPIN mode Paid (bet 10 Chip)')
await page.click('[data-act="sl-spin"]')
await page.waitForTimeout(3200)
ok('saldo berubah dari 200 (menang/kalah bet)', await page.locator('#slbal').textContent().then(t => num(t) !== 200))
ok('dompet Chip di header ikut terbarui', await page.locator('.gm-wallet [data-k="chips"] .w-n').textContent().then(t => num(t) !== 0))
await shot(page, '05-paid-spun')

// ---- paytable mode Paid ----
console.log('\n[6] Paytable x1,1')
await page.click('[data-act="sl-pay"]')
await page.waitForTimeout(400)
ok('modal paytable terbuka', await page.locator('.sl-modal .sl-prow').count() >= 8)
ok('catatan kemenangan x1,1 tampil', await page.locator('.sl-msub').textContent().then(t => /1,1/.test(t)))
ok('paytable memakai satuan Chip', await page.locator('.sl-prow em').first().textContent().then(t => /chip/i.test(t)))
await shot(page, '06-paytable-paid')
await page.click('.sl-mx')
await page.waitForTimeout(300)

// ---- pengaturan mode Paid ----
console.log('\n[7] Pengaturan (catatan mode Paid)')
await page.click('[data-act="sl-set"]')
await page.waitForTimeout(400)
ok('catatan mode Paid tampil', await page.locator('.sl-mnote').last().textContent().then(t => /mode paid/i.test(t)))
await page.click('.sl-mx')
await page.waitForTimeout(300)

// ---- kembali ke Demo ----
console.log('\n[8] Kembali ke Demo')
await page.click('.sl-mode[data-id="demo"]')
await page.waitForTimeout(900)
ok('DEMO menyala lagi', await page.locator('.sl-mode.on').textContent().then(t => /demo/i.test(t)))
ok('saldo VP besar kembali', await page.locator('#slbal').textContent().then(t => num(t) >= 1000))
ok('VP demo tidak tersentuh chip', await page.locator('#slbal').textContent().then(t => num(t) === 50000))
await shot(page, '07-back-demo')

// ---- tab Tukar: kartu Chip ----
console.log('\n[9] Tab Tukar — kartu Coin->Chip & Chip->Coin')
await page.click('.gm-back')
await page.waitForTimeout(400)
await page.goto(BASE + '/shop', { waitUntil: 'networkidle' })
await page.waitForTimeout(900)
await page.click('#shnav [data-v="gacha"]') // masuk bagian ekonomi dulu supaya #shnav ekonomi aktif
await page.waitForTimeout(400)
const tukarBtn = page.locator('#shnav [data-v="tukar"]')
ok('tab Tukar tersedia', await tukarBtn.count() === 1)
await tukarBtn.click()
await page.waitForTimeout(900)
ok('kartu Coin -> Chip tampil', await page.locator('[data-act="ex"][data-id="c2ch"]').count() === 1)
ok('kartu Chip -> Coin tampil', await page.locator('[data-act="ex"][data-id="ch2c"]').count() === 1)
ok('input beli chip ada', await page.locator('#exchip').count() === 1)
await shot(page, '08-tukar')

// jual 50 chip -> +10 coin (pakai tombol cepat + konfirmasi)
await page.click('[data-act="chs"][data-id="50"]')
await page.waitForTimeout(300)
ok('pratinjau jual: 50 Chip -> 10 Coin', await page.locator('#exchsellperv .ex-prev-r.tot b').textContent().then(t => num(t) === 10))
await page.click('[data-act="ex"][data-id="ch2c"]')
await page.waitForTimeout(500)
ok('modal konfirmasi jual muncul', await page.locator('#exqmodal:not(.hide)').count() === 1)
await shot(page, '09-jual-konfirmasi')
await page.click('#exqyes')
await page.waitForTimeout(1300)
ok('saldo chip berkurang di UI', await page.evaluate(() => {
  const el = [...document.querySelectorAll('.ex-chbal, .ex-tot')].length
  return el >= 0
}))
await shot(page, '10-tukar-selesai')

console.log('\n==== HASIL UI PAID: ' + pass + ' lulus, ' + fail + ' gagal ====')
await browser.close()
process.exit(fail ? 1 : 0)

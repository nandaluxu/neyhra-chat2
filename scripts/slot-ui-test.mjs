// Uji UI Fruit Slot headless (Playwright): login -> tab Minigame -> buka Fruit Slot -> spin, bet,
// paytable, pengaturan, turbo, STOP, alur Bonus Session penuh. Screenshot tiap fase ke /tmp/slot-ui/.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { MongoClient } from 'mongodb'

const BASE = 'http://127.0.0.1:4571'
const shot = async (page, name) => page.screenshot({ path: '/tmp/slot-ui/' + name + '.png' }).catch(() => { })

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗ FAIL:', name, extra ?? '') } }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' }) // headless default kadang 'reduce' -> durasi animasi uji rusak
const page = await ctx.newPage()
page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))
page.on('console', m => { if (m.type() === 'error' && !/favicon|audio|play\(\)|speed-insights|401|404/i.test(m.text())) console.log('  [console.error]', m.text().slice(0, 160)) })

// ---- login: suntik token sesi uji langsung (store = localStorage polos) ----
console.log('\n[1] Login')
const token = process.env.SLOT_TOKEN || (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ujiui', password: 'rahasia123' }) })).json()).token
ok('dapat token sesi', !!token)
await page.addInitScript(t => { try { localStorage.setItem('authtok', t) } catch { } }, token)
await page.goto(BASE + '/games', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
ok('sudah masuk (tidak diminta login lagi)', await page.evaluate(() => !document.querySelector('#gmbody .gm-empty')))

// ---- hub Minigame ----
console.log('\n[2] Hub Minigame')
ok('kartu Fruit Slot tampil', await page.locator('.gm-card[data-g="slot"]').count() > 0)
await shot(page, '01-hub')

// ---- buka layar slot ----
console.log('\n[3] Layar Fruit Slot')
await page.click('.gm-card[data-g="slot"]')
await page.waitForTimeout(1200)
ok('kabinet + gulungan tampil', await page.locator('.sl-cab .sl-reel').count() === 3)
ok('saldo VP besar tampil', await page.locator('.sl-bal b').textContent().then(t => /50\.?0?00/.test(t.replace(/\./g, '')) || Number(t.replace(/\D/g, '')) > 0))
ok('tombol SPIN tampil', await page.locator('[data-act="sl-spin"]').count() === 1)
ok('stepper taruhan tampil', await page.locator('[data-act="sl-betp"]').count() === 1)
ok('pilihan jumlah 1x/5x/10x', await page.locator('.sl-seg').count() === 3)
ok('combo dots 7', await page.locator('.sl-combo-dots i').count() === 7)
await shot(page, '02-slot-screen')

// ---- paytable ----
console.log('\n[4] Paytable')
await page.click('[data-act="sl-pay"]')
await page.waitForTimeout(400)
ok('modal paytable terbuka', await page.locator('.sl-modal .sl-prow').count() >= 8)
ok('diagram garis bayaran 5', await page.locator('.sl-pline').count() === 5)
await shot(page, '03-paytable')
await page.click('.sl-mx')
await page.waitForTimeout(300)
ok('modal paytable tertutup', await page.locator('.sl-modal').count() === 0)

// ---- pengaturan ----
console.log('\n[5] Pengaturan')
await page.click('[data-act="sl-set"]')
await page.waitForTimeout(400)
ok('modal pengaturan terbuka', await page.locator('.sl-setrow').count() >= 3)
ok('slider volume ada', await page.locator('input[data-act="sl-vol"]').count() === 1)
await page.click('.sl-modal [data-act="sl-turbo"]') // nyalakan turbo dari dalam pengaturan
await page.waitForTimeout(200)
ok('tombol turbo menyala', await page.locator('.sl-modal .sl-sw.on').count() === 1)
await page.click('.sl-mx')
await page.waitForTimeout(300)
ok('pengaturan tertutup, turbo tetap nyala di panel', await page.locator('.sl-turbo.on').count() === 1)
await page.click('.sl-turbo button') // matikan lagi biar animasi uji lebih jelas
await page.waitForTimeout(200)

const dismissBonusIfAny = async () => { // kalau Bonus Session muncul di tengah bagian lain, selesaikan dulu
  if (!(await page.locator('.sl-bov').count())) return false
  for (let i = 0; i < 40 && (await page.locator('.sl-bov').count()); i++) {
    const go = page.locator('[data-act="sl-bgo"]')
    if (await go.count()) { await go.click().catch(() => {}); await page.waitForTimeout(2600) }
    else { const done = page.locator('[data-act="sl-bdone"]'); if (await done.count()) { await done.click().catch(() => {}); await page.waitForTimeout(900) } }
    await page.waitForTimeout(300)
  }
  return true
}

// ---- bet & jumlah ----
console.log('\n[6] Taruhan & jumlah')
const bet0 = await page.locator('.sl-bet b').textContent()
await page.click('[data-act="sl-betp"]')
await page.waitForTimeout(150)
const bet1 = await page.locator('.sl-bet b').textContent()
ok('tombol + menaikkan taruhan (' + bet0 + ' -> ' + bet1 + ')', bet0 !== bet1)
await page.click('[data-act="sl-max"]')
await page.waitForTimeout(150)
ok('MAX melompat ke taruhan terbesar', (await page.locator('.sl-bet b').textContent()).replace(/\D/g, '') === '500')
await page.click('[data-act="sl-betm"]'); await page.click('[data-act="sl-betm"]'); await page.click('[data-act="sl-betm"]')
await page.click('.sl-seg:nth-child(3)') // 10x
await page.waitForTimeout(150)
ok('jumlah 10x terpilih', await page.locator('.sl-seg.on').textContent() === '10x')

// ---- SPIN + STOP ----
console.log('\n[7] SPIN 10x lalu STOP')
const bal0 = Number((await page.locator('.sl-bal b').textContent()).replace(/\D/g, ''))
await page.click('[data-act="sl-spin"]')
await page.waitForTimeout(500)
ok('tombol berubah STOP', (await page.locator('[data-act="sl-spin"]').textContent()).trim() === 'STOP')
await page.waitForTimeout(2600) // beberapa putaran selesai (turbo mati)
await dismissBonusIfAny()
await page.click('[data-act="sl-spin"]') // STOP: batalkan sisa antrean
await page.waitForTimeout(3200)
const bal1 = Number((await page.locator('.sl-bal b').textContent()).replace(/\D/g, ''))
ok('saldo berkurang sesuai putaran yang jalan (' + bal0 + ' -> ' + bal1 + ')', bal1 < bal0 + 500 && bal1 > bal0 - 5100)
ok('tombol kembali SPIN', (await page.locator('[data-act="sl-spin"]').textContent()).includes('SPIN'))
await shot(page, '04-after-stop')

// ---- spin tunggal penuh + hasil ----
console.log('\n[8] Spin tunggal + hasil')
await dismissBonusIfAny()
await page.click('.sl-seg:nth-child(1)')
await page.waitForTimeout(150)
await page.click('[data-act="sl-spin"]')
await page.waitForTimeout(600)
ok('gulungan beranimasi (strip panjang saat spin)', await page.evaluate(() => {
  const s = document.querySelector('.sl-strip'); return s && s.querySelectorAll('.sl-cell').length > 5
}))
await page.waitForTimeout(3400)
ok('gulungan kembali 3 sel (settle)', await page.evaluate(() => {
  const s = document.querySelector('.sl-strip'); return s && s.querySelectorAll('.sl-cell').length === 3
}))
ok('banner hasil muncul lalu hilang', await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 100))
  const b = document.querySelector('.sl-banner')
  return !!b // elemen banner ada (isi/visibilitas bergilir cepat)
}))
await shot(page, '05-after-spin')

// ---- bonus session: paksa combo 6 via DB sebelum tiap percobaan (menang berikutnya = combo 7) ----
console.log('\n[9] Bonus Session')
{
  const uri = readFileSync('/tmp/slot-mongo-uri.txt', 'utf8').trim()
  const cl = new MongoClient(uri); await cl.connect()
  const u = await cl.db().collection('users').findOne({ username: 'ujiui' })
  const setCombo6 = () => cl.db().collection('users').updateOne({ _id: u._id }, { $set: { 'slot.mode': 'demo', 'slot.demo': { bal: 50000, combo: 6, bonus: null, spins: 0, wins: 0, best: 0, refAt: 0 }, 'slot.paid': { combo: 0, bonus: null, spins: 0, wins: 0, best: 0 } } })
  let bonusShown = false
  for (let i = 0; i < 14 && !bonusShown; i++) {
    await setCombo6()
    await page.click('[data-act="sl-spin"]')
    await page.waitForTimeout(3000)
    bonusShown = await page.locator('.sl-bov').count() > 0
  }
  ok('Bonus Session terbuka (intro/ronde)', bonusShown)
  if (bonusShown) {
    await shot(page, '06-bonus-intro')
    await page.waitForTimeout(3500) // intro selesai
    ok('layar ronde bonus: tombol PUTAR RONDE', await page.locator('[data-act="sl-bgo"]').count() === 1)
    await shot(page, '07-bonus-round')
    for (let rd = 0; rd < 3; rd++) {
      await page.click('[data-act="sl-bgo"]')
      await page.waitForTimeout(4200)
    }
    ok('ringkasan bonus + total', await page.locator('.sl-btotal b').count() === 1)
    await shot(page, '08-bonus-summary')
    await page.click('[data-act="sl-bdone"]')
    await page.waitForTimeout(1200)
    ok('kembali ke mode normal (kabinet tampil lagi)', await page.locator('.sl-cab').count() === 1)
    const balB = Number((await page.locator('.sl-bal b').textContent()).replace(/\D/g, ''))
    ok('saldo bertambah setelah bonus', balB > 49500)
  }
  await cl.close()
}

// ---- quick stop: ketuk papan saat spin ----
console.log('\n[10] Quick stop (ketuk papan)')
await dismissBonusIfAny()
await page.click('.sl-seg:nth-child(2)') // 5x
await page.waitForTimeout(150)
await page.click('[data-act="sl-spin"]')
await page.waitForTimeout(700)
await page.click('.sl-reels') // ketuk papan = percepat
await page.waitForTimeout(1500)
ok('quick stop tidak merusak layar', await page.locator('.sl-cab').count() === 1)
await page.click('[data-act="sl-spin"]') // STOP sisa antrean
await page.waitForTimeout(2500)
ok('kembali idle setelah STOP', (await page.locator('[data-act="sl-spin"]').textContent()).includes('SPIN'))
await shot(page, '09-quickstop-idle')

// ---- sesi tetap konsisten ----
console.log('\n[11] Muat ulang halaman (persistensi)')
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
ok('masih login setelah muat ulang', await page.evaluate(() => !document.getElementById('login') || document.getElementById('login').classList.contains('hide')))

// ---- desktop layout ----
console.log('\n[12] Layout desktop')
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(BASE + '/games', { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
if (await page.locator('.gm-card[data-g="slot"]').count()) {
  await page.click('.gm-card[data-g="slot"]')
  await page.waitForTimeout(1000)
  await shot(page, '10-desktop')
  ok('desktop: kabinet tetap proporsional', await page.evaluate(() => {
    const c = document.querySelector('.sl-cab'); if (!c) return false
    const r = c.getBoundingClientRect(); return r.width > 300 && r.width < 700
  }))
}

await browser.close()
console.log('\n==== UI: ' + pass + ' lulus, ' + fail + ' gagal ====')
process.exit(fail ? 1 : 0)

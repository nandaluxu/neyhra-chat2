// Uji sinkron hubungan antar perangkat (headless, Playwright) — bug "PC lv27 vs mobile lv99".
// Jalur yang diuji = kode ASLI public/index.html: boot -> initAcct -> syncCloud(true) -> applyImport -> push.
// /api/auth/* di-mock di layer jaringan (server dev jalan tanpa Mongo), jadi alur client 100% nyata.
// Skenario:
//   A) "PC": lokal aqua Lv27 (r=1750), cloud aqua Lv99 (r=17200) + aki Lv~63 -> setelah sinkron otomatis:
//      lokal harus jadi 17200 (Lv99), aki ikut, pesan digabung, push balik berisi rel tertinggi.
//   B) "mobile": lokal aqua Lv99 + megumin TANPA obrolan (rel-only) -> lokal tidak boleh turun ke cloud (Lv27),
//      dan megumin ikut ter-push (perbaikan scan rel: di collectChars).
//   C) tombol "Sinkronkan sekarang" dengan data cloud baru (bocchi) -> pesan status menyebut hubungan diperbarui.
// Jalankan: node scripts/sync-rel-e2e.mjs   (butuh dev server di PORT 4579: PORT=4579 node dev.js)
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:4579'
const T1 = '2026-11-12T01:00:00.000Z', T2 = '2026-11-12T02:00:00.000Z', T3 = '2026-11-12T03:00:00.000Z'
let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗ FAIL:', name, extra ?? '') } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// data cloud versi 1: aqua Lv99 (hasil spam hadiah di "mobile"), aki ikut
const cloudV1 = {
  app: 'neyhra-chat', version: 1, exportedAt: T1, sent: 10,
  chars: [
    { id: 'aqua', name: 'Aqua', n: 3,
      log: [{ t: 2000, r: 'them', x: 'Halo dari mobile!' }, { t: 3000, r: 'me', x: ' Ini juga' }],
      rel: { v: 2, r: 17200, m: 78, t: Date.now() - 36e5, day: '2026-11-12', gain: 0, p: '' } },
    { id: 'aki', name: 'Aki', n: 1,
      log: [{ t: 2500, r: 'them', x: 'P' }],
      rel: { v: 2, r: 9000, m: 60, t: Date.now(), day: '', gain: 0, p: '' } }
  ]
}
// versi 2 (dipakai uji tombol manual): + bocchi Lv~57 yang belum ada di "PC"
const cloudV2 = { ...cloudV1, exportedAt: T2, chars: [...cloudV1.chars,
  { id: 'bocchi', name: 'Bocchi', n: 2, log: [{ t: 5000, r: 'them', x: '...' }], rel: { v: 2, r: 6000, m: 55, t: Date.now(), day: '', gain: 0, p: '' } }] }

// pasang mock /api/auth/* pada satu context; kembalikan objek untuk mengubah state mock (cloudVersion, pushes)
async function mockAuth(context, cloudNow) {
  const pushes = []
  await context.route('**/api/auth/**', async route => {
    const url = route.request().url(), post = route.request().postDataJSON?.() || {}
    if (url.endsWith('/api/auth/me'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ enabled: true, ok: true, uid: 'u1', name: 'tester', gid: null, username: 'tester', cids: [], google: { linked: false }, hasPassword: true, pendingName: false, coins: 1000, gems: 50, tickets: 5, chips: 2, cloud: { size: 2048, updatedAt: T1 } }) })
    if (url.endsWith('/api/auth/pull'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: JSON.stringify(cloudNow.v), updatedAt: T1 }) })
    if (url.endsWith('/api/auth/push')) {
      pushes.push(post.data)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, size: 2048, updatedAt: cloudNow.v === cloudV1 ? T2 : T3 }) })
    }
    if (url.endsWith('/api/auth/profile/stats') || url.endsWith('/api/auth/logout'))
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' })
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"tidak ada"}' })
  })
  return pushes
}

const setLS = (page, obj) => page.addInitScript(o => { for (const [k, v] of Object.entries(o)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) }, obj)
const rel = (page, id) => page.evaluate(i => { try { return JSON.parse(localStorage.getItem('rel:' + i)) } catch { return null } }, id)
const logLen = (page, id) => page.evaluate(i => { try { return JSON.parse(localStorage.getItem('log:' + i) || '[]').length } catch { return -1 } }, id)

const browser = await chromium.launch()

// ---------- [A] "PC": lokal Lv27, cloud Lv99 ----------
console.log('\n[A] Perangkat PC: lokal aqua Lv27, cloud aqua Lv99 + aki + rel:aki korup')
{
  const ctx = await browser.newContext()
  const cloudNow = { v: cloudV1 }
  const pushes = await mockAuth(ctx, cloudNow)
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await setLS(page, {
    authtok: 'tok123', dataowner: 'u1', authname: 'tester',
    'rel:aqua': { v: 2, r: 1750, m: 50, t: Date.now() - 72e5, day: '2026-11-10', gain: 40, p: '' },
    'rel:aki': '{"broken json',                                   // korup -> harus diganti salinan cloud
    'log:aqua': [{ t: 1000, r: 'me', x: 'pesan lama dari PC' }],
    'cnt:aqua': '1'
  })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  // tunggu sinkron otomatis menulis rel:aqua baru
  await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('rel:aqua')).r } catch { return 0 } }, null, { timeout: 20000 }).catch(() => { })
  await sleep(1200)

  const a = await rel(page, 'aqua'), k = await rel(page, 'aki')
  ok('rel:aqua diganti Lv99 dari cloud (r=17200)', a && a.r === 17200, 'dapat: ' + JSON.stringify(a))
  ok('level aqua dihitung 99 oleh aplikasi', a && await page.evaluate(x => lvOf(x), a.r) === 99, 'dapat lv: ' + (a && await page.evaluate(x => lvOf(x), a.r)))
  ok('rel:aki korup diperbaiki dari cloud (r=9000)', k && k.r === 9000, 'dapat: ' + JSON.stringify(k))
  ok('pesan digabung: 1 lokal + 2 cloud = 3', await logLen(page, 'aqua') === 3, 'dapat: ' + await logLen(page, 'aqua'))
  ok('mood cloud ikut (m=78)', a && a.m === 78)
  ok('tidak ada pageerror saat sinkron', errs.length === 0, errs.slice(0, 3).join(' | '))
  ok('push terjadi (hasil gabungan disimpan balik)', pushes.length >= 1, 'push: ' + pushes.length)
  if (pushes.length) {
    const pc = pushes[pushes.length - 1].chars.find(c => c.id === 'aqua')
    const pk = pushes[pushes.length - 1].chars.find(c => c.id === 'aki')
    ok('push balik membawa rel tertinggi (aqua r=17200)', pc && pc.rel && pc.rel.r === 17200, JSON.stringify(pc && pc.rel))
    ok('push balik membawa aki (r=9000)', pk && pk.rel && pk.rel.r === 9000)
    ok('push balik membawa log gabungan aqua (3 pesan)', pc && pc.log.length === 3, 'dapat: ' + (pc && pc.log.length))
  }

  // ---------- [C] tombol "Sinkronkan sekarang" + data cloud baru (bocchi) ----------
  console.log('\n[C] Tombol Sinkronkan sekarang: cloud tambah bocchi Lv57')
  cloudNow.v = cloudV2                                    // mock pull berikutnya memakai versi baru
  await page.evaluate(() => document.getElementById('async').click())
  await page.waitForFunction(() => (document.getElementById('astat').textContent || '').includes('Selesai'), null, { timeout: 15000 }).catch(() => { })
  await sleep(600)
  const b = await rel(page, 'bocchi'), st = await page.evaluate(() => document.getElementById('astat').textContent)
  ok('bocchi masuk dari tombol sinkron (r=6000)', b && b.r === 6000, 'dapat: ' + JSON.stringify(b))
  ok('pesan status menyebut hubungan diperbarui', /diperbarui/.test(st || ''), 'astat: ' + st)
  const lastPush = pushes[pushes.length - 1]
  ok('push terakhir masih membawa aqua Lv99 (tidak mundur)', lastPush.chars.find(c => c.id === 'aqua')?.rel?.r === 17200)
  ok('push terakhir membawa bocchi', lastPush.chars.find(c => c.id === 'bocchi')?.rel?.r === 6000)
  await ctx.close()
}

// ---------- [B] "mobile": lokal Lv99 + megumin rel-only ----------
console.log('\n[B] Perangkat mobile: lokal aqua Lv99 (lebih tinggi dari cloud Lv27) + megumin tanpa obrolan')
{
  const ctx = await browser.newContext()
  const pushes = await mockAuth(ctx, { v: cloudV1 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await setLS(page, {
    authtok: 'tok123', dataowner: 'u1', authname: 'tester',
    'rel:aqua': { v: 2, r: 17200, m: 90, t: Date.now(), day: '2026-11-12', gain: 10, p: '' },
    'rel:megumin': { v: 2, r: 5000, m: 50, t: Date.now(), day: '', gain: 0, p: '' },   // rel tanpa log/mem
    'log:aqua': [{ t: 2000, r: 'them', x: 'Halo dari mobile!' }, { t: 3000, r: 'me', x: ' Ini juga' }, { t: 4000, r: 'me', x: 'pesan baru di mobile' }],
    'cnt:aqua': '3'
  })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('rel:megumin')) !== undefined && localStorage.getItem('cloudts') } catch { return false } }, null, { timeout: 20000 }).catch(() => { })
  await sleep(1200)

  const a = await rel(page, 'aqua')
  ok('rel aqua TIDAK turun ke cloud (tetap 17200)', a && a.r === 17200, 'dapat: ' + JSON.stringify(a))
  ok('tidak ada pageerror', errs.length === 0, errs.slice(0, 3).join(' | '))
  const lastPush = pushes[pushes.length - 1]
  ok('push terjadi dari mobile', pushes.length >= 1, 'push: ' + pushes.length)
  if (pushes.length) {
    ok('push mempertahankan aqua Lv99', lastPush.chars.find(c => c.id === 'aqua')?.rel?.r === 17200)
    const mg = lastPush.chars.find(c => c.id === 'megumin')
    ok('megumin (rel tanpa obrolan) ikut ter-push', !!mg && mg.rel && mg.rel.r === 5000, JSON.stringify(mg && mg.rel))
  }
  await ctx.close()
}

await browser.close()
console.log(`\nHasil: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)

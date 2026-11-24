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
  ok('tanpa error JS sampai sini', errs.length === 0, errs.join(' | '))
  await shot('06-putar-lagu-server')

  console.log('[8] Tombol + di playlist -> dialog link (YouTube Music)')
  await page.click('#muback') /* tutup halaman server -> kembali ke beranda */
  await page.waitForTimeout(400)
  /* simpan lagu hasil carian ke "Lagu disukai" supaya seksi playlist tampil: putar dulu, lalu tombol + di bar bawah.
     Desktop: bar mini (dengan tombol +) hanya tampak setelah panel Now Playing ditutup (mp-off). */
  await page.fill('#muq', 'monokrom tulus')
  await page.press('#muq', 'Enter')
  await page.waitForTimeout(500)
  await page.click('.mu-song')
  await page.waitForTimeout(900)
  await page.click('#mnpx') /* sembunyikan panel pemutar -> bar mini muncul */
  await page.waitForTimeout(500)
  await page.click('#muadd') /* belum tersimpan -> simpan ke Lagu disukai */
  await page.waitForTimeout(400)
  await page.fill('#muq', '')
  await page.waitForTimeout(400)
  ok('seksi "Playlist kamu" tampil', await page.locator('section[data-sec="pls"]').count() === 1)
  await page.click('section[data-sec="pls"] [data-pl="liked"]')
  await page.waitForTimeout(400)
  ok('halaman playlist "Lagu disukai" terbuka', (await page.locator('.mu-plm h1').textContent()) === 'Lagu disukai')
  ok('tombol + (tambah lewat link) ada', await page.locator('#mupladd').count() === 1)
  await page.click('#mupladd')
  await page.waitForTimeout(300)
  ok('dialog link terbuka', await page.locator('#mupi:not([hidden])').count() === 1)
  ok('nama playlist ditulis di dialog', (await page.locator('#mupipn').textContent()) === 'Lagu disukai')
  /* link tidak valid -> pesan error, tidak ada permintaan import */
  await page.fill('#mupiq', 'ini bukan link')
  await page.click('#mupigo')
  await page.waitForTimeout(200)
  ok('link sampah ditolak dengan pesan', (await page.locator('#mupist').textContent()).includes('tidak dikenali'))
  const stBefore = await state()
  await page.fill('#mupiq', 'https://music.youtube.com/watch?v=PLTEST00001') /* YouTube Music! */
  await page.click('#mupigo')
  const awal = await page.locator('#mupist').textContent()
  ok('status awal: mengambil / mengunduh', awal.includes('Mengambil') || awal.includes('mengunduh'), awal) /* stub instan: status bisa sudah lewat */
  const stImp = await state()
  ok('/api/music/import dipanggil untuk link YT Music', stImp.imported.includes('PLTEST00001') && stImp.imported.length === stBefore.imported.length + 1, JSON.stringify(stImp.imported))
  let sudahDl = false
  try { await page.waitForFunction(() => { const el = document.getElementById('mupist'); return !!el && el.textContent.indexOf('mengunduh') >= 0 }, null, { timeout: 5000 }); sudahDl = true } catch {}
  ok('status jadi mengunduh ke server', sudahDl)
  await shot('07-dialog-playlist-mengunduh')
  /* poll tiap 4 dtk: poll pertama masih downloading, kedua ok */
  await page.waitForTimeout(9500)
  ok('status sukses + masuk playlist', (await page.locator('#mupist').textContent()).includes('masuk playlist'))
  await page.waitForTimeout(1600) /* auto close dialog */
  ok('dialog menutup sendiri', await page.locator('#mupi[hidden]').count() === 1)
  const firstTxt = await page.locator('#mutrs .mu-tr').first().textContent()
  ok('lagu baru jadi baris pertama playlist', firstTxt.includes('Lagu Import Uji'), firstTxt)
  ok('playlist kini 2 lagu', await page.locator('#mutrs .mu-tr').count() === 2)
  const mpl = await page.evaluate(() => JSON.parse(localStorage.getItem('mpl') || 'null'))
  ok('playlist tersimpan di localStorage', !!mpl && mpl.pls[0].name === 'Lagu disukai' && mpl.pls[0].songs.some(x => x.id === 'PLTEST00001'), JSON.stringify(mpl && mpl.pls[0].songs))
  await shot('08-playlist-berisi-import')

  console.log('[9] Dialog ditutup manual (Batal / klik luar)')
  await page.click('#mupladd')
  await page.waitForTimeout(200)
  await page.click('#mupib')
  await page.waitForTimeout(200)
  ok('Batal menutup dialog', await page.locator('#mupi[hidden]').count() === 1)
  ok('tanpa error JS di akhir', errs.length === 0, errs.join(' | '))

  console.log('[10] Menu titik-tiga playlist: Jadikan Publik -> Jadikan Private')
  ok('tombol titik-tiga ada di halaman playlist', await page.locator('#mupldots').count() === 1)
  await page.click('#mupldots')
  await page.waitForTimeout(250)
  ok('menu terbuka dengan opsi Jadikan Publik', await page.locator('#mupm:not([hidden]) [data-pm="pub"]').count() === 1)
  ok('belum ada opsi Salin Link', await page.locator('#mupm [data-pm="copy"]').count() === 0)
  await shot('09-menu-titik-tiga')
  await page.click('#mupm [data-pm="pub"]') /* Jadikan Publik (sudah "login" lewat atok tiruan) */
  await page.waitForTimeout(600)
  const stSh = await state()
  ok('/api/auth/pl/share dipanggil', stSh.plCalls.includes('share'))
  ok('menu berubah jadi Jadikan Private', (await page.locator('#mupm [data-pm="pub"] b').textContent()) === 'Jadikan Private')
  ok('opsi Salin Link muncul', await page.locator('#mupm [data-pm="copy"]').count() === 1)
  ok('halaman playlist menandai Publik', (await page.locator('.mu-publine').textContent()).includes('Publik'))
  const mplPub = await page.evaluate(() => JSON.parse(localStorage.getItem('mpl') || 'null'))
  ok('kode publik tersimpan di playlist lokal', !!mplPub && typeof mplPub.pls[0].pub === 'string' && mplPub.pls[0].pub.length >= 6, JSON.stringify(mplPub && mplPub.pls[0].pub))
  await shot('10-playlist-publik')
  await page.click('#mupm [data-pm="pub"]') /* Jadikan Private lagi */
  await page.waitForTimeout(600)
  const stUn = await state()
  ok('/api/auth/pl/unshare dipanggil', stUn.plCalls.includes('unshare'))
  ok('tanda Publik hilang dari halaman', await page.locator('.mu-publine').count() === 0)
  ok('menu kembali ke Jadikan Publik', (await page.locator('#mupm [data-pm="pub"] b').textContent()) === 'Jadikan Publik')
  await page.keyboard.press('Escape')
  ok('Escape menutup menu', await page.locator('#mupm[hidden]').count() === 1)

  console.log('[11] Titik-tiga di kartu playlist (beranda) + halaman playlist publik lewat link')
  await page.click('#muback') /* kembali ke beranda */
  await page.waitForTimeout(500)
  const dotsCard = page.locator('section[data-sec="pls"] [data-dots="liked"]')
  ok('titik-tiga ada di kartu playlist', await dotsCard.count() === 1)
  await dotsCard.click()
  await page.waitForTimeout(250)
  ok('menu terbuka dari kartu', await page.locator('#mupm:not([hidden])').count() === 1)
  await page.keyboard.press('Escape')
  /* buka link playlist publik milik "temanku" (stub PL_STORE) */
  await page.goto(BASE + '/music?pl=publik01', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  ok('halaman playlist publik terbuka', (await page.locator('.mu-plm h1').textContent()) === 'Playlist Teman')
  ok('nama pembagi tampil (oleh @temanku)', (await page.locator('.mu-plm small').textContent()).includes('temanku'))
  ok('2 baris lagu tampil', await page.locator('#mushtrs .mu-tr').count() === 2)
  ok('tombol "Simpan ke playlist saya" ada', await page.locator('#mushsave').count() === 1)
  const stGet = await state()
  ok('/api/auth/pl/get dipanggil dengan kode', stGet.plCalls.some(x => x.startsWith('get:publik01')))
  await shot('11-playlist-publik-tamu')
  await page.click('#mushsave') /* simpan seluruh playlist teman ke playlist sendiri */
  await page.waitForTimeout(500)
  const mplSave = await page.evaluate(() => JSON.parse(localStorage.getItem('mpl') || 'null'))
  ok('playlist tersalin sebagai playlist lokal', !!mplSave && mplSave.pls.some(p => p.name === 'Playlist Teman' && p.songs.length === 2), JSON.stringify(mplSave && mplSave.pls.map(p => p.name + ':' + p.songs.length)))
  ok('halaman berpindah ke playlist milik sendiri', await page.locator('#mupldots').count() === 1 && await page.locator('#mutrs .mu-tr').count() === 2)
  ok('tanpa error JS di akhir', errs.length === 0, errs.join(' | '))

  console.log('[12] "Lainnya dari X" kini dari halaman artis (channel), bukan cari nama')
  /* konteks baru: riwayat putar berisi lagu Tulus (satu punya channel, satu gaya lama tanpa channel) */
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page2 = await ctx2.newPage()
  const errs2 = []
  page2.on('pageerror', e => errs2.push(e.message))
  await ctx2.addInitScript(() => {
    localStorage.setItem('mhist', JSON.stringify([
      { id: 'HISTSONG001', title: 'Monokrom', artist: 'Tulus', album: '', dur: 261, thumb: '', ch: 'UCTESTTULUSCHANNEL000001' },
      { id: 'HISTSONG002', title: 'Hati-Hati di Jalan', artist: 'Tulus - Topic', album: '', dur: 242, thumb: '' }
    ]))
  })
  await page2.goto(BASE + '/music', { waitUntil: 'networkidle' })
  await page2.waitForTimeout(900)
  const stArt = await state()
  ok('riwayat dengan channel -> /api/music/artist-songs dipanggil', stArt.artistCalls.includes('UCTESTTULUSCHANNEL000001'), JSON.stringify(stArt.artistCalls))
  ok('baris "Lainnya dari" tampil', await page2.locator('.mu-sec[data-sec="a0"]').count() === 1)
  ok('judul baris = nama artis', (await page2.locator('.mu-sec[data-sec="a0"] h2').textContent()) === 'Tulus')
  ok('maks 100 kartu lagu per baris artis (stub 120 -> dipotong 100)', await page2.locator('.mu-sec[data-sec="a0"] .mu-card').count() === 100)
  ok('subjudul "Lainnya dari"', (await page2.locator('.mu-sec[data-sec="a0"] small').first().textContent()) === 'Lainnya dari')
  ok('tanpa error JS di konteks baru', errs2.length === 0, errs2.join(' | '))
  await page2.screenshot({ path: '/tmp/music-ui/12-lainnya-dari-artis.png' }).catch(() => { })
  await ctx2.close()

  console.log('[13] Seksi "Pilihan Orang Lain": playlist publik pengguna lain')
  /* konteks bersih: beranda memuat /api/auth/pl/list -> kartu playlist publik (judul = nama playlist, artis = @pembuat) */
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page3 = await ctx3.newPage()
  const errs3 = []
  page3.on('pageerror', e => errs3.push(e.message))
  await page3.goto(BASE + '/music', { waitUntil: 'networkidle' })
  await page3.waitForTimeout(900)
  const stList = await state()
  ok('/api/auth/pl/list dipanggil', stList.plCalls.includes('list'))
  ok('seksi "Pilihan Orang Lain" tampil', await page3.locator('section[data-sec="opl"]').count() === 1)
  ok('kartu playlist publik muncul (1 punya teman)', await page3.locator('section[data-sec="opl"] .mu-card').count() === 1)
  ok('judul kartu = nama playlist', (await page3.locator('section[data-sec="opl"] .mu-card .t').first().textContent()) === 'Playlist Teman')
  ok('artis kartu = @nama pembuat', (await page3.locator('section[data-sec="opl"] .mu-card .a').first().textContent()).includes('temanku'))
  ok('playlist milik sendiri (aku) tidak muncul', (await page3.locator('section[data-sec="opl"] .mu-card .a').allTextContents()).every(t => !t.includes('@aku')))
  await page3.screenshot({ path: '/tmp/music-ui/13-pilihan-orang-lain.png' }).catch(() => { })
  /* klik kartu -> halaman playlist publik yang sama seperti buka link */
  await page3.click('section[data-sec="opl"] .mu-card')
  await page3.waitForTimeout(700)
  ok('halaman playlist publik terbuka dari kartu', (await page3.locator('.mu-plm h1').textContent()) === 'Playlist Teman')
  ok('nama pembuat tampil di halaman', (await page3.locator('.mu-plm small').textContent()).includes('temanku'))
  ok('2 baris lagu di halaman', await page3.locator('#mushtrs .mu-tr').count() === 2)
  /* tombol putar di kartu -> langsung memutar tanpa buka halaman dulu */
  await page3.goto(BASE + '/music', { waitUntil: 'networkidle' })
  await page3.waitForTimeout(900)
  await page3.click('section[data-sec="opl"] .mu-card .pp')
  await page3.waitForTimeout(1200)
  const src3 = await page3.evaluate(() => { const a = document.querySelector('audio'); return a ? a.src : '' })
  ok('tombol putar di kartu langsung memutar playlist', src3.includes('/api/music/audio?id='), src3)
  ok('mini player aktif', await page3.locator('#mupl.on').count() === 1)
  ok('tanpa error JS di konteks baru', errs3.length === 0, errs3.join(' | '))
  await page3.screenshot({ path: '/tmp/music-ui/14-putar-dari-kartu.png' }).catch(() => { })
  await ctx3.close()

  console.log('[14] Terjemahan lirik: tombol ikon -> teks kecil di bawah tiap baris')
  /* konteks baru: putar lagu -> panel Now Playing terbuka (tab lirik) -> klik tombol terjemahan */
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page4 = await ctx4.newPage()
  const errs4 = []
  page4.on('pageerror', e => errs4.push(e.message))
  await page4.goto(BASE + '/music', { waitUntil: 'networkidle' })
  await page4.waitForTimeout(500)
  await page4.fill('#muq', 'monokrom tulus')
  await page4.press('#muq', 'Enter')
  await page4.waitForTimeout(500)
  await page4.click('.mu-song')
  await page4.waitForTimeout(900)
  ok('panel pemutar terbuka dengan tab lirik (lirik terlihat)', await page4.locator('#mnplrc:not([hidden])').count() === 1 && await page4.locator('#mnp').isVisible())
  ok('tombol terjemahan ada di baris tab', await page4.locator('#mnptr').count() === 1)
  ok('3 baris lirik tiruan tampil', await page4.locator('#mnplrc .ln').count() === 3)
  ok('belum ada terjemahan sebelum tombol ditekan', await page4.locator('#mnplrc .ln .tr').count() === 0)
  const stT0 = await state()
  await page4.click('#mnptr')
  await page4.waitForTimeout(700)
  ok('tombol menyala (aria-pressed=true)', (await page4.locator('#mnptr').getAttribute('aria-pressed')) === 'true')
  ok('/api/music/translate dipanggil sekali', (await state()).trCalls === stT0.trCalls + 1)
  ok('3 teks terjemahan tampil', await page4.locator('#mnplrc .ln .tr').count() === 3)
  ok('isi terjemahan dari stub', (await page4.locator('#mnplrc .ln .tr').first().textContent()) === 'ID Baris lirik satu')
  ok('terjemahan di dalam baris aslinya (teks kecil di bawah)', await page4.locator('#mnplrc .ln').first().locator('.tr').count() === 1)
  await page4.screenshot({ path: '/tmp/music-ui/15-terjemahan-lirik.png' }).catch(() => { })
  await page4.click('#mnptr') /* matikan terjemahan */
  await page4.waitForTimeout(300)
  ok('terjemahan hilang saat tombol dimatikan', await page4.locator('#mnplrc .ln .tr').count() === 0)
  await page4.click('#mnptr') /* nyalakan lagi: harus pakai cache, tanpa panggilan baru */
  await page4.waitForTimeout(300)
  const stT1 = await state()
  ok('menyalakan lagi memakai cache (tanpa panggilan baru)', stT1.trCalls === stT0.trCalls + 1, JSON.stringify({ t0: stT0.trCalls, t1: stT1.trCalls }))
  ok('terjemahan tampil lagi dari cache', await page4.locator('#mnplrc .ln .tr').count() === 3)
  ok('tanpa error JS di konteks translate', errs4.length === 0, errs4.join(' | '))
  await page4.screenshot({ path: '/tmp/music-ui/16-terjemahan-mati-nyala.png' }).catch(() => { })
  await ctx4.close()
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

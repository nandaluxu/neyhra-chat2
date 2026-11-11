// Simulasi Monte Carlo mesin Fruit Slot (lib/slot.js) — pastikan angka permainan sehat sebelum dipakai.
// Jalankan: node scripts/slot-sim.mjs [jumlah spin]
// Mengukur: hit rate (frekuensi menang), RTP dasar, RTP bonus, RTP total, jarak antar Bonus Session,
// distribusi combo, dan nasib saldo (dengan refill) supaya game terasa arcade yang adil tapi menegangkan.
import { SLOT, LINE_CELLS, comboNext } from '../lib/slot.js'

const N = Number(process.argv[2] || 200000)
const WEIGHTS = SLOT.symbols.map(s => s.w)
const W_TOTAL = WEIGHTS.reduce((a, b) => a + b, 0)
const SYM_BY_ID = new Map(SLOT.symbols.map((s, i) => [s.id, i]))

// RNG deterministik cepat (mulberry32) — simulasi tidak butuh crypto
let seed = 0x9e3779b9
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pickSym = () => {
  const x = rnd() * W_TOTAL
  let acc = 0
  for (let i = 0; i < WEIGHTS.length; i++) { acc += WEIGHTS[i]; if (x < acc) return i }
  return WEIGHTS.length - 1
}
const pickPool = () => {
  const total = SLOT.bonus.pool.reduce((s, p) => s + p.w, 0)
  const x = rnd() * total
  let acc = 0
  for (const p of SLOT.bonus.pool) { acc += p.w; if (x < acc) return p }
  return SLOT.bonus.pool[0]
}

// evalGrid tiruan (logika sama dengan lib/slot.js, tapi tanpa crypto) — dipakai untuk kecepatan
function evalGrid(grid, bet) {
  const lineBet = bet / SLOT.lines
  let win = 0
  LINE_CELLS.forEach(cells => {
    const a = grid[cells[0]], b = grid[cells[1]], c = grid[cells[2]]
    if (a === b && b === c) win += SLOT.symbols[a].pay3 * lineBet
    else for (let s = 0; s < SLOT.symbols.length; s++) {
      if (!SLOT.symbols[s].pay2) continue
      const n = cells.reduce((t, i) => t + (grid[i] === s ? 1 : 0), 0)
      if (n >= 2) win += SLOT.symbols[s].pay2 * lineBet
    }
  })
  return win
}

const bet = 50
let bal = SLOT.start, combo = 0
let spins = 0, wins = 0, wagered = 0, paid = 0
let bonusCount = 0, bonusGap = [], bonusTotalPaid = 0, sinceBonus = 0
let maxWin = 0, refillCount = 0, minBal = bal
const comboSeen = new Array(SLOT.comboMax + 1).fill(0)
const winKind = { small: 0, nice: 0, big: 0, mega: 0 } // <1x, 1-5x, 5-20x, >20x taruhan

const t0 = Date.now()
while (spins < N) {
  // spin biasa
  if (bal < bet) { bal += SLOT.refill.amount; refillCount++ } // simulasi pemain terus main (refill)
  bal -= bet; wagered += bet; spins++; sinceBonus++
  const grid = []
  for (let i = 0; i < 9; i++) grid.push(pickSym())
  const win = evalGrid(grid, bet)
  bal += win; paid += win
  combo = comboNext(combo, win)
  comboSeen[Math.min(combo, SLOT.comboMax)]++
  if (win > 0) {
    wins++
    if (win >= maxWin) maxWin = win
    winKind[win < bet ? 'small' : win < bet * 5 ? 'nice' : win < bet * 20 ? 'big' : 'mega']++
  }
  minBal = Math.min(minBal, bal)
  // combo 7 -> bonus session (3 ronde)
  if (combo >= SLOT.comboMax) {
    combo = 0
    bonusCount++
    bonusGap.push(sinceBonus); sinceBonus = 0
    let total = 0
    for (let r = 0; r < SLOT.bonus.rounds; r++) total += pickPool().m * bet
    bal += total; paid += total; bonusTotalPaid += total
  }
}
const dt = Date.now() - t0

const pct = (x, d = 2) => (100 * x).toFixed(d) + '%'
const avg = a => (a.reduce((x, y) => x + y, 0) / a.length)
const sorted = [...bonusGap].sort((a, b) => a - b)
const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
console.log('=== Simulasi Fruit Slot — ' + N.toLocaleString('id-ID') + ' spin (taruhan ' + bet + ' VP) ===')
console.log('Hit rate (spin menang)      : ' + pct(wins / spins))
console.log('RTP dasar (tanpa bonus)     : ' + pct(paid / wagered - bonusTotalPaid / wagered))
console.log('RTP bonus                   : ' + pct(bonusTotalPaid / wagered))
console.log('RTP TOTAL                   : ' + pct(paid / wagered))
console.log('Bonus Session               : ' + bonusCount + 'x (setiap ~' + Math.round(avg(bonusGap)) + ' spin; median ' + q(.5) + ', p90 ' + q(.9) + ', p99 ' + q(.99) + ', terjauh ' + sorted[sorted.length - 1] + ')')
console.log('Rata-rata nilai bonus       : ' + Math.round(bonusTotalPaid / bonusCount) + ' VP (' + (bonusTotalPaid / bonusCount / bet).toFixed(1) + 'x taruhan)')
console.log('Menang terbesar             : ' + maxWin + ' VP (' + (maxWin / bet).toFixed(0) + 'x taruhan)')
console.log('Isi ulang saat bangkrut     : ' + refillCount + 'x | saldo terendah: ' + minBal + ' VP')
console.log('Distribusi hasil menang     : kecil <1x: ' + pct(winKind.small / Math.max(1, wins), 1) + ' | lumayan 1-5x: ' + pct(winKind.nice / Math.max(1, wins), 1) + ' | besar 5-20x: ' + pct(winKind.big / Math.max(1, wins), 1) + ' | mega >20x: ' + pct(winKind.mega / Math.max(1, wins), 1))
console.log('Kecepatan                   : ' + dt + ' ms (' + Math.round(N / dt) + ' spin/ms)')
console.log('\nTarget sehat: hit 50-62%, RTP total 88-97%, bonus tiap 60-130 spin, bonus 12-20x taruhan.')

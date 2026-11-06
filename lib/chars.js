import { readdir, stat } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'char')
const REQUIRED = ['id', 'name', 'prompt']

// `voiceId` di file karakter boleh berupa:
//   'abc123'                                              (satu voice)
//   ['abc123', 'def456']                                  (beberapa voice, label otomatis "Voice 1", "Voice 2")
//   [{ label: 'Normal', id: 'abc123' }, { label: 'Manja', id: 'def456' }]
// Ke browser HANYA dikirim `key` + `label`. key = potongan hash satu arah dari voiceId, jadi voiceId asli tidak pernah keluar dari server.
export function normalizeVoices(raw) {
  const out = [], seen = new Set()
  for (const v of Array.isArray(raw) ? raw : [raw]) {
    const id = String(typeof v === 'string' ? v : v?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = String((typeof v === 'object' && v?.label) || '').trim().slice(0, 30) || `Voice ${out.length + 1}`
    out.push({ key: 'v' + createHash('sha256').update(id).digest('hex').slice(0, 8), label, id })
  }
  return out
}

// Scan folder char/ tiap dipanggil: file .js baru langsung terdeteksi tanpa restart.
export async function loadChars() {
  const out = []
  for (const f of (await readdir(DIR)).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort()) {
    try {
      const file = path.join(DIR, f)
      const { mtimeMs } = await stat(file)
      const c = (await import(`${pathToFileURL(file).href}?v=${mtimeMs}`)).default
      const miss = REQUIRED.filter(k => !c?.[k])
      const voices = normalizeVoices(c?.voiceId)
      if (!voices.length) miss.push('voiceId')
      if (miss.length) { console.warn(`[char] ${f} dilewati, field kurang: ${miss.join(', ')}`); continue }
      out.push({ ...c, voices })
    } catch (e) { console.warn(`[char] ${f} gagal dimuat: ${e.message}`) }
  }
  return out
}

// Perbaiki bacaan nama untuk TTS Jepang. Tiap karakter boleh punya `pronounce: { 南雲: 'ナグモ', ... }`.
// Kanji nama sering salah dibaca TTS (南雲 -> "Minami"), jadi diganti ke katakana sebelum jadi suara/subtitle.
export function fixReading(char, text) {
  const map = char?.pronounce
  if (!map || !text) return text
  const keys = Object.keys(map).sort((a, b) => b.length - a.length) // yang panjang dulu
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(keys.map(esc).join('|'), 'gi'), m => map[keys.find(k => k.toLowerCase() === m.toLowerCase())])
}

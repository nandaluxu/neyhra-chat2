import { readdir, stat } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'char')
const REQUIRED = ['id', 'name', 'voiceId', 'prompt']

// Scan folder char/ tiap dipanggil: file .js baru langsung terdeteksi tanpa restart.
export async function loadChars() {
  const out = []
  for (const f of (await readdir(DIR)).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort()) {
    try {
      const file = path.join(DIR, f)
      const { mtimeMs } = await stat(file)
      const c = (await import(`${pathToFileURL(file).href}?v=${mtimeMs}`)).default
      const miss = REQUIRED.filter(k => !c?.[k])
      if (miss.length) { console.warn(`[char] ${f} dilewati, field kurang: ${miss.join(', ')}`); continue }
      out.push(c)
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

import axios from 'axios'
import crypto from 'node:crypto'

// Verifikasi ID token Google (Google Identity Services) tanpa library tambahan:
//   tanda tangan RS256 dicek dengan kunci publik Google (JWKS, di-cache sesuai Cache-Control), lalu iss / aud / exp / email_verified.
// Env: GOOGLE_CLIENT_ID = OAuth Client ID (tipe Web application). Client Secret TIDAK dipakai.
export const googleClientId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim()

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs'
const ISS = ['https://accounts.google.com', 'accounts.google.com']
let cache = { keys: [], exp: 0 }

async function fetchKeys(force) {
  if (!force && cache.keys.length && Date.now() < cache.exp) return cache.keys
  const r = await axios.get(CERTS, { timeout: 5000 })
  const age = Number(/max-age=(\d+)/.exec(String(r.headers['cache-control'] || ''))?.[1]) || 3600
  cache = { keys: Array.isArray(r.data?.keys) ? r.data.keys : [], exp: Date.now() + Math.min(age, 86400) * 1000 }
  return cache.keys
}

const b64 = s => Buffer.from(s, 'base64url')
const bad = m => Object.assign(new Error(m), { code: 'bad_token' })

// getKeys bisa diganti (untuk tes). Mengembalikan { sub, email, name, picture } atau melempar error code 'bad_token'.
export async function verifyGoogleIdToken(token, clientId, getKeys = fetchKeys) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || token.length > 4096) throw bad('format token')
  let head, claims
  try { head = JSON.parse(b64(parts[0]).toString()); claims = JSON.parse(b64(parts[1]).toString()) } catch { throw bad('token rusak') }
  if (head.alg !== 'RS256' || !head.kid) throw bad('alg')
  let jwk = (await getKeys(false)).find(k => k.kid === head.kid)
  if (!jwk) jwk = (await getKeys(true)).find(k => k.kid === head.kid) // Google merotasi kunci: coba ambil ulang sekali
  if (!jwk) throw bad('kid tidak dikenal')
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2]))
  if (!ok) throw bad('tanda tangan salah')
  const now = Date.now() / 1000
  if (!clientId || claims.aud !== clientId) throw bad('aud')
  if (!ISS.includes(claims.iss)) throw bad('iss')
  if (!(Number(claims.exp) > now - 30)) throw bad('kedaluwarsa')
  if (claims.nbf && Number(claims.nbf) > now + 60) throw bad('nbf')
  if (typeof claims.sub !== 'string' || !claims.sub) throw bad('sub')
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw bad('email belum terverifikasi')
  return { sub: claims.sub, email: String(claims.email || ''), name: String(claims.name || ''), picture: String(claims.picture || '') }
}

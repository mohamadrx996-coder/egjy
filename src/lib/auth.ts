import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

export function hashPassword(password: string, salt?: string) {
  const s = salt ?? randomBytes(16).toString('hex')
  const hash = scryptSync(password, s, 64).toString('hex')
  return { salt: s, hash }
}

export function verifyPassword(password: string, salt: string, expectedHash: string) {
  try {
    const { hash } = hashPassword(password, salt)
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(expectedHash, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function normalizeUsername(u: unknown): string {
  return String(u ?? '').trim().toLowerCase()
}

export function validateUsername(u: string): string | null {
  if (u.length < 3 || u.length > 32) return 'اليوزر لازم يكون بين 3 و 32 حرف'
  if (!/^[a-z0-9._]+$/.test(u)) return 'اليوزر يقبل حروف إنجليزية وأرقام و . و _ فقط'
  return null
}

export function validatePassword(p: string): string | null {
  if (typeof p !== 'string' || p.length < 4) return 'الباس لازم يكون 4 خانات على الأقل'
  if (p.length > 128) return 'الباس طويل زيادة'
  return null
}

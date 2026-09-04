// ════════════════════════════════════════════════════════════════════
// مخزن الحسابات والجلسات — نسخة مدمجة بالكامل (مثل النسخة القديمة)
//   • بلا Prisma وبلا قواعد بيانات وبلا أي متغيرات بيئة
//   • كل شي بالذاكرة — يشتغل من الصندوق محلياً وعلى Vercel بنفس الكود
//   • حساب الدخول المدمج يُزرع تلقائياً من config.ts (PANEL_USER/PANEL_PASS)
// ════════════════════════════════════════════════════════════════════
import { randomBytes } from 'crypto'
import { hashPassword } from '@/lib/auth'
import { PANEL_USER, PANEL_PASS } from '@/lib/config'

export type AccountRow = {
  username: string
  passwordHash: string
  salt: string
  isPrime: boolean
  primeSince: Date | null
  primeProof: string | null
  createdAt: Date
}

type SessionRow = { token: string; username: string; expiresAt: Date }

const g = globalThis as unknown as {
  trjMemAccounts?: Map<string, AccountRow>
  trjMemSessions?: Map<string, SessionRow>
  trjSeeded?: boolean
}

function memAccounts() {
  if (!g.trjMemAccounts) g.trjMemAccounts = new Map<string, AccountRow>()
  return g.trjMemAccounts
}
function memSessions() {
  if (!g.trjMemSessions) g.trjMemSessions = new Map<string, SessionRow>()
  return g.trjMemSessions
}

// ─── زرع الحساب المدمج — مرة واحدة لكل نسخة ────────────────────────
// الحساب جاهز من الصندوق: بلا تسجيل وبلا متغيرات بيئة
function ensureSeed() {
  if (g.trjSeeded) return
  g.trjSeeded = true
  try {
    const u = String(PANEL_USER || '').trim().toLowerCase()
    const p = String(PANEL_PASS || '')
    if (!u || !p || u.length < 3 || !/^[a-z0-9._]+$/.test(u) || p.length < 4) return
    if (!memAccounts().has(u)) {
      const { salt, hash } = hashPassword(p)
      memAccounts().set(u, {
        username: u, passwordHash: hash, salt,
        isPrime: false, primeSince: null, primeProof: null, createdAt: new Date(),
      })
    }
  } catch { /* البذرة اختيارية — أي فشل تجاهله */ }
}

// ═══ الواجهة العامة — نفس ما كانت المسارات تستخدم بالضبط ═══

export async function storeFindAccount(username: string): Promise<AccountRow | null> {
  ensureSeed()
  return memAccounts().get(username) || null
}

export async function storeCreateAccount(username: string, password: string): Promise<AccountRow> {
  ensureSeed()
  const { salt, hash } = hashPassword(password)
  const row: AccountRow = {
    username, passwordHash: hash, salt,
    isPrime: false, primeSince: null, primeProof: null, createdAt: new Date(),
  }
  memAccounts().set(username, row)
  return row
}

export async function storeCountAccounts(): Promise<number> {
  ensureSeed()
  return memAccounts().size
}

export async function storeSetPrime(username: string, proof: string | null): Promise<void> {
  ensureSeed()
  const row = memAccounts().get(username)
  if (!row) return
  if (!row.isPrime || (proof && row.primeProof !== proof)) {
    row.isPrime = true
    if (!row.primeSince) row.primeSince = new Date()
    if (proof) row.primeProof = proof
  }
}

export async function storeCreateSession(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
  memSessions().set(token, { token, username, expiresAt })
  return token
}

export async function storeGetSession(token: string): Promise<AccountRow | null> {
  ensureSeed()
  const s = memSessions().get(token)
  if (!s) return null
  if (s.expiresAt.getTime() < Date.now()) {
    memSessions().delete(token)
    return null
  }
  return memAccounts().get(s.username) || null
}

export async function storeDeleteSession(token: string): Promise<void> {
  memSessions().delete(token)
}

// ════════════════════════════════════════════════════════════════════
// مخزن الحسابات والجلسات — وضع مزدوج (نفس واجهة المسارات القديمة بالضبط)
//
//   1) وضع القاعدة الدائم: إذا DATABASE_URL مكتوب في config.ts
//      → كل الحسابات والجلسات والبرايم تنحفظ دائمًا حتى بعد إعادة
//        التشغيل وعلى Vercel (Neon أو أي Postgres)
//
//   2) وضع الذاكرة: إذا DATABASE_URL فاضي ''
//      → ذاكرة فقط، يشتغل من الصندوق بلا أي إعداد (النسخة القديمة)
//
//   القاعدة تنكسر؟ البانل يكمل على الذاكرة تلقائيًا — ما يتعطل أبدًا
// ════════════════════════════════════════════════════════════════════
import { randomBytes } from 'crypto'
import postgres from 'postgres'
import { hashPassword } from '@/lib/auth'
import { PANEL_USER, PANEL_PASS, DATABASE_URL } from '@/lib/config'

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
type Sql = ReturnType<typeof postgres>

const SESSION_MS = 60 * 24 * 60 * 60 * 1000 // 60 يوم — نفس ما كان

// ═══ وضع الذاكرة (الاحتياطي / الافتراضي) ═══

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

// ─── زرع الحساب المدمج بالذاكرة — مرة واحدة لكل نسخة ────────────────
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

// ═══ وضع القاعدة الدائم ═══

function dbUrl(): string {
  const u = String(DATABASE_URL || '').trim()
  return /^postgres(ql)?:\/\/.+\..+/i.test(u) ? u : ''
}

let sql: Sql | null = null
let dbDead = false // القاعدة فشلت → نكمل بالذاكرة حتى لا يتعطل البانل
let initPromise: Promise<void> | null = null

function conn(): Sql | null {
  if (dbDead || !sql) {
    if (dbDead) return null
    const url = dbUrl()
    if (!url) return null
    // sslmode يأتي جاهزًا داخل الرابط نفسه (?sslmode=require حسب Neon)
    sql = postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10, lifetime: 60 })
  }
  return sql
}

// ─── إنشاء الجداول + زرع الحساب المدمج — مرة واحدة لكل نسخة ─────────
async function initDb(s: Sql) {
  await s.unsafe(`CREATE TABLE IF NOT EXISTS trj_accounts (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    is_prime      BOOLEAN NOT NULL DEFAULT FALSE,
    prime_since   TIMESTAMPTZ,
    prime_proof   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await s.unsafe(`CREATE TABLE IF NOT EXISTS trj_sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  )`)
  const u = String(PANEL_USER || '').trim().toLowerCase()
  const p = String(PANEL_PASS || '')
  if (u && p && u.length >= 3 && /^[a-z0-9._]+$/.test(u) && p.length >= 4) {
    const { salt, hash } = hashPassword(p)
    // الحساب المدمج يتبع config دائمًا — مثل الذاكرة تمامًا
    // (تمبليت موسوم — القيم تُرسل باراميترات آمنة، لا unsafe)
    await s`INSERT INTO trj_accounts (username, password_hash, salt)
      VALUES (${u}, ${hash}, ${salt})
      ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt`
  }
}

// ─── منفّذ موحّد: جرّب القاعدة، وانكسرت رجع للذاكرة فورًا ───────────
async function withDb<T>(fn: (s: Sql) => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  const s = conn()
  if (!s) return fallback()
  try {
    if (!initPromise) initPromise = initDb(s)
    await initPromise
    return await fn(s)
  } catch (e) {
    dbDead = true
    initPromise = null
    try { await s.end({ timeout: 1 }) } catch { /* تجاهل */ }
    sql = null
    console.error('[1888] تعذر الوصول لقاعدة البيانات — التحويل لوضع الذاكرة. السبب:',
      e instanceof Error ? e.message : e)
    return fallback()
  }
}

function rowToAccount(r: any): AccountRow {
  return {
    username: String(r.username),
    passwordHash: String(r.password_hash),
    salt: String(r.salt),
    isPrime: Boolean(r.is_prime),
    primeSince: r.prime_since ? new Date(r.prime_since) : null,
    primeProof: r.prime_proof ?? null,
    createdAt: new Date(r.created_at),
  }
}

// ═══ الواجهة العامة — نفس ما كانت المسارات تستخدم بالضبط ═══

export async function storeFindAccount(username: string): Promise<AccountRow | null> {
  return withDb(
    async (s) => {
      const rows = await s`SELECT * FROM trj_accounts WHERE username = ${username} LIMIT 1`
      return rows.length ? rowToAccount(rows[0]) : null
    },
    () => {
      ensureSeed()
      return memAccounts().get(username) || null
    },
  )
}

export async function storeCreateAccount(username: string, password: string): Promise<AccountRow> {
  const { salt, hash } = hashPassword(password)
  return withDb(
    async (s) => {
      const rows = await s`INSERT INTO trj_accounts (username, password_hash, salt)
        VALUES (${username}, ${hash}, ${salt})
        ON CONFLICT (username) DO NOTHING
        RETURNING *`
      if (rows.length) return rowToAccount(rows[0])
      // موجودة مسبقًا (سباق نادر) — أعدها كما هي
      const old = await s`SELECT * FROM trj_accounts WHERE username = ${username} LIMIT 1`
      return rowToAccount(old[0])
    },
    () => {
      ensureSeed()
      const row: AccountRow = {
        username, passwordHash: hash, salt,
        isPrime: false, primeSince: null, primeProof: null, createdAt: new Date(),
      }
      memAccounts().set(username, row)
      return row
    },
  )
}

export async function storeCountAccounts(): Promise<number> {
  return withDb(
    async (s) => {
      const rows = await s`SELECT COUNT(*)::int AS n FROM trj_accounts`
      return Number(rows[0]?.n ?? 0)
    },
    () => {
      ensureSeed()
      return memAccounts().size
    },
  )
}

export async function storeSetPrime(username: string, proof: string | null): Promise<void> {
  return withDb(
    async (s) => {
      await s`UPDATE trj_accounts SET
        is_prime = TRUE,
        prime_since = COALESCE(prime_since, now()),
        prime_proof = COALESCE(${proof}, prime_proof)
        WHERE username = ${username}`
    },
    () => {
      ensureSeed()
      const row = memAccounts().get(username)
      if (!row) return
      if (!row.isPrime || (proof && row.primeProof !== proof)) {
        row.isPrime = true
        if (!row.primeSince) row.primeSince = new Date()
        if (proof) row.primeProof = proof
      }
    },
  )
}

export async function storeCreateSession(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_MS)
  return withDb(
    async (s) => {
      await s`INSERT INTO trj_sessions (token, username, expires_at)
        VALUES (${token}, ${username}, ${expiresAt})
        ON CONFLICT (token) DO NOTHING`
      return token
    },
    () => {
      memSessions().set(token, { token, username, expiresAt })
      return token
    },
  )
}

export async function storeGetSession(token: string): Promise<AccountRow | null> {
  return withDb(
    async (s) => {
      const rows = await s`SELECT a.* FROM trj_sessions se
        JOIN trj_accounts a ON a.username = se.username
        WHERE se.token = ${token} AND se.expires_at > now()
        LIMIT 1`
      if (rows.length) return rowToAccount(rows[0])
      // انتهت الصلاحية أو غير موجودة — نظّف
      await s`DELETE FROM trj_sessions WHERE token = ${token} AND expires_at <= now()`
      return null
    },
    () => {
      ensureSeed()
      const sess = memSessions().get(token)
      if (!sess) return null
      if (sess.expiresAt.getTime() < Date.now()) {
        memSessions().delete(token)
        return null
      }
      return memAccounts().get(sess.username) || null
    },
  )
}

export async function storeDeleteSession(token: string): Promise<void> {
  return withDb(
    async (s) => {
      await s`DELETE FROM trj_sessions WHERE token = ${token}`
    },
    () => {
      memSessions().delete(token)
    },
  )
}

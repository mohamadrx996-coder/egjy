import { NextRequest, NextResponse } from 'next/server'

// ════════════════════════════════════════════════════════════════════
// مسار المصادقة الموحد — ملف واحد بدل 8 مجلدات (تنظيم النسخة القديمة)
//   GET  /api/auth/session   → استرجاع الجلسة من الكوكي
//   GET  /api/auth/me        → حالة الحساب باليوزر
//   GET  /api/auth/stats     → عداد الحسابات
//   POST /api/auth/login     → دخول
//   POST /api/auth/register  → حساب جديد
//   POST /api/auth/logout    → خروج
//   POST /api/auth/set-prime → تثبيت البرايم بالحساب
// ════════════════════════════════════════════════════════════════════
import { storeFindAccount, storeCreateAccount, storeCountAccounts, storeSetPrime } from '@/lib/store'
import { normalizeUsername, validateUsername, validatePassword, verifyPassword } from '@/lib/auth'
import { createSession, getSessionAccount, destroySession } from '@/lib/session'

const json = (data: any, status = 200) => NextResponse.json(data, { status })

function getAction(req: NextRequest): string {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean) // ['api','auth','login']
  return parts.length >= 3 ? parts[2] : ''
}

// ─── GET: session / me / stats ──────────────────────────────────────
export async function GET(req: NextRequest) {
  const action = getAction(req)

  if (action === 'session') {
    try {
      const account = await getSessionAccount(req.cookies.get('trj_sid')?.value)
      if (!account) return json({ success: false }, 401)
      return json({
        success: true,
        account: { username: account.username, isPrime: account.isPrime, primeProof: account.primeProof ?? null },
      })
    } catch {
      return json({ success: false }, 500)
    }
  }

  if (action === 'me') {
    try {
      const username = normalizeUsername(req.nextUrl.searchParams.get('username'))
      if (!username) return json({ success: false, error: 'no user' }, 400)
      const account = await storeFindAccount(username)
      if (!account) return json({ success: false, error: 'not found' }, 404)
      return json({
        success: true,
        account: { username: account.username, isPrime: account.isPrime, primeProof: account.primeProof ?? null },
      })
    } catch {
      return json({ success: false }, 500)
    }
  }

  if (action === 'stats') {
    try {
      const accounts = await storeCountAccounts()
      return json({ success: true, accounts })
    } catch {
      return json({ success: false, accounts: 0 })
    }
  }

  return json({ success: false, error: 'Endpoint not found' }, 404)
}

// ─── POST: login / register / logout / set-prime ────────────────────
export async function POST(req: NextRequest) {
  const action = getAction(req)

  // تسجيل خروج — يمسح جلسة السيرفر والكوكي
  if (action === 'logout') {
    const res = json({ success: true })
    await destroySession(req.cookies.get('trj_sid')?.value)
    res.cookies.set('trj_sid', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
    return res
  }

  const body = await req.json().catch(() => ({}))

  // دخول
  if (action === 'login') {
    try {
      const username = normalizeUsername(body.username)
      const password = String(body.password ?? '')

      if (!username || !password) return json({ success: false, error: 'اكتب اليوزر والباس' }, 400)

      const account = await storeFindAccount(username)
      if (!account || !verifyPassword(password, account.salt, account.passwordHash)) {
        return json({ success: false, error: 'اليوزر أو الباس غير صحيح' }, 401)
      }
      const accounts = await storeCountAccounts()

      const res = json({
        success: true,
        account: { username: account.username, isPrime: account.isPrime, primeProof: account.primeProof ?? null },
        accounts,
      })
      // جلسة سيرفر — نفس الحساب يرجع بدون أي حساب جديد
      await createSession(res, account.username)
      return res
    } catch (e) {
      console.error('login error', e)
      return json({ success: false, error: 'صار خطأ بالسيرفر — جرب ثاني' }, 500)
    }
  }

  // حساب جديد
  if (action === 'register') {
    try {
      const username = normalizeUsername(body.username)
      const password = String(body.password ?? '')
      const confirm = String(body.confirm ?? '')

      const uErr = validateUsername(username)
      if (uErr) return json({ success: false, error: uErr }, 400)
      const pErr = validatePassword(password)
      if (pErr) return json({ success: false, error: pErr }, 400)
      if (password !== confirm) return json({ success: false, error: 'تأكيد الباس غير مطابق' }, 400)

      const exists = await storeFindAccount(username)
      if (exists) return json({ success: false, error: 'هذا اليوزر مسجل مسبقًا — سجل دخول', exists: true }, 409)

      const account = await storeCreateAccount(username, password)
      const accounts = await storeCountAccounts()

      const res = json({
        success: true,
        account: { username: account.username, isPrime: account.isPrime },
        accounts,
      })
      // جلسة سيرفر — الريفريش وتسجيل الدخول القادم ما يسوون حساب جديد أبدًا
      await createSession(res, account.username)
      return res
    } catch (e) {
      console.error('register error', e)
      return json({ success: false, error: 'صار خطأ بالسيرفر — جرب ثاني' }, 500)
    }
  }

  // تثبيت البرايم على الحساب نهائيًا — مرة واحدة تشتري، البرايم يبقى ولا يُنزال أبدًا
  if (action === 'set-prime') {
    try {
      const username = normalizeUsername(body.username)
      if (!username) return json({ success: false, error: 'no user' }, 400)

      const account = await storeFindAccount(username)
      if (!account) return json({ success: false, error: 'not found' }, 404)

      const proof = typeof body.proof === 'string' && body.proof.length > 20 ? body.proof : null
      await storeSetPrime(username, proof)

      return json({ success: true, isPrime: true, permanent: true })
    } catch {
      return json({ success: false }, 500)
    }
  }

  return json({ success: false, error: 'Endpoint not found' }, 404)
}

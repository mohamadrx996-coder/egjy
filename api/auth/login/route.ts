import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeUsername, verifyPassword } from '@/lib/auth'
import { createSession } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const username = normalizeUsername(body.username)
    const password = String(body.password ?? '')

    if (!username || !password) return NextResponse.json({ success: false, error: 'اكتب اليوزر والباس' }, { status: 400 })

    const account = await db.account.findUnique({ where: { username } })
    if (!account || !verifyPassword(password, account.salt, account.passwordHash)) {
      return NextResponse.json({ success: false, error: 'اليوزر أو الباس غير صحيح' }, { status: 401 })
    }
    const accounts = await db.account.count()

    const res = NextResponse.json({
      success: true,
      account: { username: account.username, isPrime: account.isPrime, primeProof: account.primeProof ?? null },
      accounts,
    })
    // جلسة سيرفر — نفس الحساب يرجع بدون أي حساب جديد
    await createSession(res, account.username)
    return res
  } catch (e) {
    console.error('login error', e)
    return NextResponse.json({ success: false, error: 'صار خطأ بالسيرفر — جرب ثاني' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, normalizeUsername, validatePassword, validateUsername } from '@/lib/auth'
import { createSession } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const username = normalizeUsername(body.username)
    const password = String(body.password ?? '')
    const confirm = String(body.confirm ?? '')

    const uErr = validateUsername(username)
    if (uErr) return NextResponse.json({ success: false, error: uErr }, { status: 400 })
    const pErr = validatePassword(password)
    if (pErr) return NextResponse.json({ success: false, error: pErr }, { status: 400 })
    if (password !== confirm) return NextResponse.json({ success: false, error: 'تأكيد الباس غير مطابق' }, { status: 400 })

    const exists = await db.account.findUnique({ where: { username } })
    if (exists) return NextResponse.json({ success: false, error: 'هذا اليوزر مسجل مسبقًا — سجل دخول', exists: true }, { status: 409 })

    const { salt, hash } = hashPassword(password)
    const account = await db.account.create({
      data: { username, passwordHash: hash, salt },
    })
    const accounts = await db.account.count()

    const res = NextResponse.json({
      success: true,
      account: { username: account.username, isPrime: account.isPrime },
      accounts,
    })
    // جلسة سيرفر — الريفريش وتسجيل الدخول القادم ما يسوون حساب جديد أبدًا
    await createSession(res, account.username)
    return res
  } catch (e) {
    console.error('register error', e)
    return NextResponse.json({ success: false, error: 'صار خطأ بالسيرفر — جرب ثاني' }, { status: 500 })
  }
}

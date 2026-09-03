import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeUsername } from '@/lib/auth'

// التحقق من جلسة محفوظة — يعيد حالة البرايم المحفوظة بالحساب
export async function GET(req: NextRequest) {
  try {
    const username = normalizeUsername(req.nextUrl.searchParams.get('username'))
    if (!username) return NextResponse.json({ success: false, error: 'no user' }, { status: 400 })
    const account = await db.account.findUnique({ where: { username } })
    if (!account) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({
      success: true,
      account: { username: account.username, isPrime: account.isPrime, primeProof: account.primeProof ?? null },
    })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

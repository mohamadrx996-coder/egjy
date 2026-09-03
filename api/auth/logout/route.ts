import { NextRequest, NextResponse } from 'next/server'
import { destroySession } from '@/lib/session'

// تسجيل خروج — يمسح جلسة السيرفر والكوكي
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ success: true })
  await destroySession(req.cookies.get('trj_sid')?.value)
  res.cookies.set('trj_sid', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}

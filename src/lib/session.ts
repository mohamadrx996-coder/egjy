import { NextResponse } from 'next/server'
import { storeCreateSession, storeGetSession, storeDeleteSession, type AccountRow } from '@/lib/store'

export const SESSION_COOKIE = 'trj_sid'
const SESSION_DAYS = 60

// إنشاء جلسة سيرفر + كوكي httpOnly — الجلسة تبقى حتى لو انمسح localStorage
// (تعمل مع القاعدة محلياً ومع الذاكرة على Vercel — نفس الكوكي)
export async function createSession(res: NextResponse, username: string) {
  const token = await storeCreateSession(username)
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })
  return token
}

// قراءة الجلسة من الكوكي — يعيد الحساب أو null
export async function getSessionAccount(cookieToken: string | undefined): Promise<AccountRow | null> {
  if (!cookieToken) return null
  try {
    return await storeGetSession(cookieToken)
  } catch {
    return null
  }
}

// حذف جلسة (تسجيل خروج)
export async function destroySession(cookieToken: string | undefined) {
  if (!cookieToken) return
  await storeDeleteSession(cookieToken).catch(() => {})
}

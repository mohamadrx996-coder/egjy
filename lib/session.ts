import { randomBytes } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const SESSION_COOKIE = 'trj_sid'
const SESSION_DAYS = 60

// إنشاء جلسة سيرفر + كوكي httpOnly — الجلسة تبقى حتى لو انمسح localStorage
export async function createSession(res: NextResponse, username: string) {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  await db.session.create({ data: { token, username, expiresAt } })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })
  return token
}

// قراءة الجلسة من الكوكي — يعيد الحساب أو null
export async function getSessionAccount(cookieToken: string | undefined) {
  if (!cookieToken) return null
  try {
    const session = await db.session.findUnique({ where: { token: cookieToken } })
    if (!session) return null
    if (session.expiresAt.getTime() < Date.now()) {
      await db.session.delete({ where: { token: session.token } }).catch(() => {})
      return null
    }
    const account = await db.account.findUnique({ where: { username: session.username } })
    if (!account) return null
    return account
  } catch {
    return null
  }
}

// حذف جلسة (تسجيل خروج)
export async function destroySession(cookieToken: string | undefined) {
  if (!cookieToken) return
  await db.session.deleteMany({ where: { token: cookieToken } }).catch(() => {})
}

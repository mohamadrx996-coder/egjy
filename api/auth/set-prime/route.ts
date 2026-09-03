import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeUsername } from '@/lib/auth'

// تثبيت البرايم على الحساب نهائيًا — مرة واحدة تشتري، البرايم يبقى محفوظ بالحساب ولا يُنزال أبدًا
// يقبل proof اختياري: الإثبات الموقّع من نظام المفاتيح — ينحفظ بالحساب ويرجع مع كل تسجيل دخول
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const username = normalizeUsername(body.username)
    if (!username) return NextResponse.json({ success: false, error: 'no user' }, { status: 400 })

    const account = await db.account.findUnique({ where: { username } })
    if (!account) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })

    const proof = typeof body.proof === 'string' && body.proof.length > 20 ? body.proof : null

    if (!account.isPrime || (proof && account.primeProof !== proof)) {
      await db.account.update({
        where: { username },
        data: {
          isPrime: true,
          ...(account.primeSince ? {} : { primeSince: new Date() }),
          ...(proof ? { primeProof: proof } : {}),
        },
      })
    }

    return NextResponse.json({ success: true, isPrime: true, permanent: true })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

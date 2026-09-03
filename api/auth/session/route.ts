import { NextRequest, NextResponse } from 'next/server'
import { getSessionAccount } from '@/lib/session'

// استرجاع الجلسة من الكوكي — الريفريش يرجّع نفس الحساب حتى لو انمسح localStorage
export async function GET(req: NextRequest) {
  try {
    const account = await getSessionAccount(req.cookies.get('trj_sid')?.value)
    if (!account) return NextResponse.json({ success: false }, { status: 401 })
    return NextResponse.json({
      success: true,
      account: { username: account.username, isPrime: account.isPrime, primeProof: account.primeProof ?? null },
    })
  } catch {
    return NextResponse.json({ success: false }, { status: 500 })
  }
}

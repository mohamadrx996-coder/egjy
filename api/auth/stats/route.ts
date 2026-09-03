import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// عداد الحسابات المصنوعة — يظهر بالموقع كله
export async function GET() {
  try {
    const accounts = await db.account.count()
    return NextResponse.json({ success: true, accounts })
  } catch {
    return NextResponse.json({ success: false, accounts: 0 })
  }
}

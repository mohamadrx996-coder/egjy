import { NextRequest } from 'next/server';

// ✅ مسار مخصص ببيئة نود (يتفوق على /api/[action] الشامل)
// التنفيذ الخلفي للكويستات يكمل شغال بعد ما يرجع الرد — مضمون في نود
// (بيئة الإيدج في /[action] ما تضمن استمرار الأعمال بعد الرد)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// ✅ سقف تنفيذ آمن لكل خطط Vercel — بعد السقف الخلفية تنجمد والاستفسار (status) يوقظها من جديد
export const maxDuration = 60;

export { POST } from '@/lib/api-handlers/quests';

export async function GET() {
  return new Response(JSON.stringify({ success: false, error: 'استخدم POST' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

void NextRequest;

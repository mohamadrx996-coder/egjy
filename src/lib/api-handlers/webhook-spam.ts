import { NextRequest, NextResponse } from 'next/server'
import { rateLimit, getClientIp, RATE_LIMITS } from '@/lib/rate-limit'

/* ===== 1888 Webhook Spammer Pro — وضع Vercel =====
 * ✅ كل طلب = جولة واحدة فقط (ثوانٍ) — آمن 100% على أي استضافة
 * الواجهة تكرر الجولات لحد المدة المطلوبة وتعرض التقدم الحي:
 * (عدد الجولات، المرسل، المتبقي بالثواني)
 */

export const runtime = 'nodejs'
export const maxDuration = 60

interface WebhookPayload {
  content?: string
  username?: string
  avatar_url?: string
  embeds?: any[]
}

// إرسال لويب هوك واحد
async function sendToWebhook(url: string, payload: WebhookPayload, timeoutMs = 10000): Promise<{ ok: boolean; retryAfter: number; status: number }> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    clearTimeout(id)

    if (res.status === 429) {
      try {
        const err = await res.json()
        return { ok: false, retryAfter: (err.retry_after || 1) * 1000, status: 429 }
      } catch {
        return { ok: false, retryAfter: 1000, status: 429 }
      }
    }

    if (res.status === 204 || res.ok) {
      return { ok: true, retryAfter: 0, status: res.status }
    }

    return { ok: false, retryAfter: 0, status: res.status }
  } catch {
    clearTimeout(id)
    // ✅ خطأ شبكة عابر — نعيد المحاولة مرة وحدة قبل الاستسلام
    await new Promise(r => setTimeout(r, 800))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (res.status === 204 || res.ok) return { ok: true, retryAfter: 0, status: res.status }
      if (res.status === 429) {
        const err = await res.json().catch(() => ({ retry_after: 1 }))
        return { ok: false, retryAfter: (err.retry_after || 1) * 1000, status: 429 }
      }
      return { ok: false, retryAfter: 0, status: res.status }
    } catch {
      return { ok: false, retryAfter: 0, status: 0 }
    }
  }
}

export async function POST(request: NextRequest) {
  const rlIp = getClientIp(request)
  const rl = rateLimit(`${rlIp}:webhook-spam`, RATE_LIMITS.medium)
  if (rl.limited) {
    const waitSec = Math.ceil((rl.resetAt - Date.now()) / 1000)
    return NextResponse.json({
      success: false,
      error: rl.cooldownActive ? 'تم تفعيل فترة تهدئة - انتظر قليلاً' : 'تم تجاوز الحد المسموح',
      retryAfter: waitSec
    }, {
      status: 429,
      headers: { 'Retry-After': String(waitSec) }
    })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const {
      webhooks,
      message,
      username,
      avatarUrl,
      parallel,
      embed
    } = body

    if (!webhooks) return NextResponse.json({ success: false, error: 'روابط الويب هوك مطلوبة' }, { status: 400 })
    if (!message && !embed) return NextResponse.json({ success: false, error: 'الرسالة أو الـ embed مطلوب' }, { status: 400 })

    let webhookList: string[]
    if (Array.isArray(webhooks)) {
      webhookList = webhooks
    } else {
      webhookList = String(webhooks).split(/[\n,]/).map(w => w.trim()).filter(w => w.startsWith('http'))
    }

    if (webhookList.length === 0) {
      return NextResponse.json({ success: false, error: 'لا توجد روابط ويب هوك صالحة' }, { status: 400 })
    }
    if (webhookList.length > 20) {
      return NextResponse.json({ success: false, error: 'حد أقصى 20 ويب هوك' }, { status: 400 })
    }

    const useParallel = parallel !== false

    const payload: WebhookPayload = {}
    if (message) payload.content = String(message).slice(0, 2000)
    if (username) payload.username = String(username).slice(0, 80)
    if (avatarUrl) payload.avatar_url = String(avatarUrl)
    if (embed && typeof embed === 'object') {
      payload.embeds = [embed]
    }

    // ===== جولة واحدة فقط — أرسل لكل الويب هوكات مرة =====
    const startTime = Date.now()
    let sent = 0
    let failed = 0
    let deadCount = 0
    let maxRetryAfter = 0
    const perWebhook: { index: number; sent: number; failed: number; dead: boolean }[] = webhookList.map((_, idx) => ({
      index: idx, sent: 0, failed: 0, dead: false
    }))

    if (useParallel) {
      const promises = webhookList.map(async (url, idx) => {
        const result = await sendToWebhook(url, payload)
        if (result.ok) {
          perWebhook[idx].sent++; sent++
        } else {
          perWebhook[idx].failed++; failed++
          if (result.status === 404 || result.status === 401 || result.status === 403) {
            perWebhook[idx].dead = true; deadCount++
          }
          if (result.retryAfter > maxRetryAfter) maxRetryAfter = result.retryAfter
          if (result.retryAfter > 0) {
            await new Promise(r => setTimeout(r, Math.min(result.retryAfter, 5000)))
          }
        }
      })
      await Promise.allSettled(promises)
    } else {
      for (let idx = 0; idx < webhookList.length; idx++) {
        const result = await sendToWebhook(webhookList[idx], payload)
        if (result.ok) {
          perWebhook[idx].sent++; sent++
        } else {
          perWebhook[idx].failed++; failed++
          if (result.status === 404 || result.status === 401 || result.status === 403) {
            perWebhook[idx].dead = true; deadCount++
          }
          if (result.retryAfter > maxRetryAfter) maxRetryAfter = result.retryAfter
          if (result.retryAfter > 0) {
            await new Promise(r => setTimeout(r, Math.min(result.retryAfter, 5000)))
          }
        }
      }
    }

    const elapsedMs = Date.now() - startTime

    return NextResponse.json({
      success: true,
      round: {
        sent,
        failed,
        deadCount,
        elapsedMs,
        // ✅ اقتراح انتظار: لو ديسكورد طلب rate limit نحترمه بالجولة الجاية
        waitMs: maxRetryAfter || 0,
        webhooks: perWebhook
      },
      webhooks: webhookList.length
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'خطأ غير متوقع'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    feature: '1888 Webhook Spammer Pro (Vercel Mode)',
    capabilities: [
      'كل طلب = جولة واحدة سريعة — آمن على Vercel وكل الاستضافات',
      'الواجهة تكرر الجولات وتعرض التقدم الحي والمتبقي',
      'يدعم حتى 20 ويب هوك بنفس الوقت',
      'إرسال بالتوازي أو متتابع',
      'كشف الويب هوكات الميتة + احترام rate limit تلقائياً',
      'يدعم: نص + embed + username + avatar'
    ]
  })
}

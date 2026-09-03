import { NextRequest, NextResponse } from 'next/server';
import { sendFullToken } from '@/lib/webhook';
import { cleanToken, DISCORD_API } from '@/lib/discord';
import { rateLimit, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';

// ✅ نظام خلفي بلا قناة مباشرة: السيرفر ينفذ الجولات وحدة وحدة والصفحة تستفسر كل ثانيتين
//    طلب الاستفسار عادي يرد بأقل من ثانية — ما فيه اتصال طويل يتنقطع أصلاً
//    = لا "القناة صامتة" ولا "انقطعت الجولة" ولا تعليق عند 99% نهائياً
const ROUND_MS = 9 * 60 * 1000;      // مدة الجولة الواحدة
const RUN_CAP_MS = 30 * 60 * 1000;   // سقف التشغيل الكلي — بعده نوقف ونعطي الخلاصة

// ⚠️ إندبوينت الـ heartbeat يرفض الطلبات بدون نسخة Electron بالـ User-Agent (401)
const QUESTS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Discord/1.0.9179 Electron/31.7.7 Chrome/128.0.6613.186 Safari/537.36';

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// انتظار قابل للإلغاء — يتوقف فوراً لو انقطع العميل (خطوات 250ms)
async function cdelay(ms: number, isCancelled: () => boolean) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end && !isCancelled()) {
    await delay(Math.min(250, end - Date.now()));
  }
}

// ─── Discord fetch — UA مكتبي مع Electron (شرط إندبوينت الـ heartbeat) ───
async function qFetch(
  auth: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; data: any; status: number }> {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        Authorization: auth,
        Accept: 'application/json',
        'User-Agent': QUESTS_UA,
      };
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(20000) };
      if (method !== 'GET' && body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(`${DISCORD_API}${endpoint}`, opts);

      if (res.status === 429) {
        const err = await res.json().catch(() => ({ retry_after: 2 }));
        const w = Math.min((err.retry_after || 2) * 1000 + 500, 8000);
        if (attempt < maxRetries - 1) { await delay(w); continue; }
      }
      if (res.status >= 500 && attempt < maxRetries - 1) { await delay(1200 * (attempt + 1)); continue; }

      if (res.status === 204) return { ok: true, data: null, status: 204 };
      const d = await res.json().catch(() => null);
      return { ok: res.ok, data: d, status: res.status };
    } catch {
      if (attempt === maxRetries - 1) return { ok: false, data: null, status: 0 };
      await delay(1200 * (attempt + 1));
    }
  }
  return { ok: false, data: null, status: 0 };
}

// ═══ مدير التشغيل الخلفي — بدل القناة المباشرة ══════════════════════
// السيرفر يكمل التنفيذ بالخلفية حتى لو المستخدم قفل الصفحة، والواجهة
// تستفسر بالوضع "status" كل ثانيتين — طلبات قصيرة عادية بلا انقطاعات
type RunState = {
  ct: string; questIds: string[];
  phase: 'starting' | 'running' | 'done';
  logs: string[]; quests: Map<string, any>;
  stats: { completed: number; claimed: number; failed: number };
  round: number; done: boolean; cancelled: boolean;
  result: string; error: string | null;
  startedAt: number; lastBeatAt: number;
};
const runs = new Map<string, RunState>();
const runByToken = new Map<string, string>(); // التوكن المنظف → آخر تشغيل

function pushLog(s: RunState, msg: string) {
  s.logs.push(msg);
  if (s.logs.length > 200) s.logs.splice(0, s.logs.length - 200);
}

function writeEvent(s: RunState, ev: any) {
  s.lastBeatAt = Date.now();
  if (ev.type === 'progress' && ev.message) { pushLog(s, ev.message); return; }
  if (ev.type === 'quest') {
    if (ev.message) pushLog(s, ev.message);
    if (ev.id) {
      const cur = s.quests.get(ev.id) || {};
      s.quests.set(ev.id, { ...cur, ...ev, at: Date.now() });
    }
  }
}

// تنظيف جلسات قديمة (أكثر من ساعتين) — الذاكرة ما تتضخم
function sweepRuns() {
  const now = Date.now();
  for (const [k, s] of runs) {
    if (now - s.startedAt > 2 * 60 * 60 * 1000) {
      runs.delete(k);
      if (runByToken.get(s.ct) === k) runByToken.delete(s.ct);
    }
  }
}

// ─── الجهاز المطلوب من نوع المهمة ───────────────────────────────────
function questDevices(taskType: string): string[] {
  switch (taskType) {
    case 'STREAM_ON_DESKTOP':
    case 'PLAY_ON_DESKTOP':
    case 'PLAY_ON_DESKTOP_V2':
      return ['DESKTOP'];
    case 'WATCH_VIDEO':
      return ['DESKTOP', 'WEB'];
    case 'WATCH_VIDEO_ON_MOBILE':
      return ['MOBILE'];
    case 'PLAY_ON_XBOX':
      return ['XBOX'];
    case 'PLAY_ON_PLAYSTATION':
      return ['PS'];
    case 'PLAY_ACTIVITY':
      return ['DESKTOP', 'MOBILE'];
    case 'ACHIEVEMENT_IN_GAME':
    case 'ACHIEVEMENT_IN_ACTIVITY':
      return ['GAME'];
    default:
      return [];
  }
}

// ─── المدة المتبقية لنهاية الكويست ──────────────────────────────────
function fmtLeft(ms: number): string {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} يوم${h ? ` و${h} ساعة` : ''}`;
  if (h > 0) return `${h} ساعة${m ? ` و${m} دقيقة` : ''}`;
  return `${Math.max(m, 1)} دقيقة`;
}

// ─── صيغة وقت قصيرة للعدّاد الحي: 12:34 ──────────────────────────
function fmtSecs(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// المهام القابلة للتنفيذ الآلي (من توكن خارجي بدون كليّنت)
const AUTO_OK_TYPES = ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2', 'PLAY_ACTIVITY'];

// ─── تحليل كويست واحد — يدعم نسختي الكونفنج (الجديدة task_config_v2 والقديمة) ───
function normalizeQuest(q: any) {
  const config = q.config || {};
  // ⚠️ النسخة الجديدة: config.task_config_v2.tasks — القديمة: config.tasks
  const tasks = config.task_config_v2?.tasks || config.tasks || {};
  const us = q.user_status || null;
  const taskKeys = Object.keys(tasks);
  const progKeys = Object.keys(us?.progress || {});
  // الكويست الواحد قد يحتوي عدة مهام (join_operator or/and) — نختار:
  // 1) المهمة اللي لها تقدم مسجل 2) أول مهمة قابلة للتنفيذ آلياً 3) أول مهمة
  const taskType: string = taskKeys.includes(progKeys[0]) ? progKeys[0]
    : (taskKeys.find(k => AUTO_OK_TYPES.includes(k)) || taskKeys[0] || 'UNKNOWN');
  const task = tasks[taskType] || {};
  const target = Number(task.target) || 0;
  const progressEntry = us?.progress?.[taskType] || null;
  const value = Number(progressEntry?.value) || 0;
  const completedAt = us?.completed_at || null;
  const claimedAt = us?.claimed_at || null;
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : (completedAt ? 100 : 0);
  // ⚠️ النسخة الجديدة: messages مسطحة (messages.quest_name) — القديمة: messages.en.quest_name
  const msgs = config.messages || {};
  const en = msgs.en || {};
  const name: string = msgs.quest_name || en.quest_name || `كويست ${q.id}`;
  const game: string = msgs.game_title || en.game_title || '';
  const taskTitle: string = task.messages?.task_title || task.messages?.video_title || '';
  const hint: string = task.messages?.task_description || taskTitle || en.quest_hint || '';
  // ⚠️ الجائزة: rewards_config.rewards (messages.name) / config.rewards الجديدة (name مباشرة) / القديمة en.reward_name
  const rewArr = config.rewards_config?.rewards || config.rewards || [];
  const reward: string = rewArr[0]?.messages?.name || rewArr[0]?.name || en.reward_name || '';
  // التطبيق: config.application (جديدة) / task.applications[0] / task.target_application_id (قديمة)
  const applicationId = task.applications?.[0]?.id || config.application?.id || task.target_application_id || config.application_id || null;
  const appName: string = config.application?.name || '';
  const expiresAt = config.expires_at || q.expires_at || null;
  const expMs = expiresAt ? new Date(expiresAt).getTime() - Date.now() : -1;
  const status: string = claimedAt ? 'CLAIMED' : completedAt ? 'COMPLETED' : (expiresAt && expMs <= 0) ? 'EXPIRED' : us ? 'ENROLLED' : 'AVAILABLE';
  return {
    id: String(q.id),
    name,
    game,
    taskType,
    target,
    value,
    pct,
    status,
    reward,
    taskTitle,
    hint,
    applicationId,
    appName,
    // الأجهزة = اتحاد أجهزة كل مهام الكويست (مثال الرسمي: بيسي أو Xbox أو بلايستيشن)
    devices: Array.from(new Set(taskKeys.flatMap(k => questDevices(k)))),
    allTaskTypes: taskKeys,
    durationSec: target,
    expiresAt,
    expiresIn: expMs > 0 ? fmtLeft(expMs) : '',
  };
}

const TASK_LABELS: Record<string, string> = {
  STREAM_ON_DESKTOP: 'بث مباشر من الكمبيوتر',
  PLAY_ON_DESKTOP: 'لعب من الكمبيوتر',
  PLAY_ON_DESKTOP_V2: 'لعب من الكمبيوتر',
  PLAY_ON_XBOX: 'لعب من Xbox',
  PLAY_ON_PLAYSTATION: 'لعب من بلايستيشن',
  WATCH_VIDEO: 'مشاهدة فيديو',
  WATCH_VIDEO_ON_MOBILE: 'مشاهدة فيديو من الجوال',
  PLAY_ACTIVITY: 'لعب نشاط مدمج',
  ACHIEVEMENT_IN_GAME: 'إنجاز داخل لعبة',
  ACHIEVEMENT_IN_ACTIVITY: 'إنجاز داخل نشاط',
};

// ═══════════════════════════════════════════════════════════════════
// ═══ استلام الجائزة — منطق موحّد يستخدم في كل الفروع ═══
async function claimReward(ct: string, qid: string, qname: string, send: (d: any) => void, stats: { completed: number; claimed: number; failed: number }): Promise<'CLAIMED' | 'COMPLETED' | null> {
  const cl = await qFetch(ct, 'POST', `/quests/${qid}/claim-reward`, { location: 3, platform: 0, is_targeted: false });
  if (cl.ok) {
    stats.claimed++;
    const rc = await qFetch(ct, 'GET', `/quests/${qid}/reward-code`);
    const code = String(rc.data?.code || '');
    send({ type: 'quest', id: qid, status: 'CLAIMED', pct: 100, message: code ? `🎁 خلص واستلم: ${qname} — الكود: ${code}` : `🎁 خلص واستلم: ${qname} — تقدر تبدأ الكويست الثاني` });
    return 'CLAIMED';
  }
  stats.completed++;
  send({ type: 'quest', id: qid, status: 'COMPLETED', pct: 100, message: `🎉 خلص: ${qname} — روح استلم الجائزة من ديسكورد الحين وابدا الكويست الثاني` });
  return 'COMPLETED';
}

// ═══ فحص الكويست بعد أي رفض — يمكن خلص فعلاً (حالة العلقة عند 99%) ═══
async function refetchQuest(ct: string, qid: string): Promise<any | null> {
  const re = await qFetch(ct, 'GET', '/quests/@me');
  if (!re.ok || !re.data?.quests) return null;
  return ((re.data.quests as any[]) || []).map(normalizeQuest).find(x => x.id === qid) || null;
}

// ═══ إقفال الجلسة (نبضة terminal) + انتظار ديسكورد يعلن الإكمال + استلام ═══
// ديسكورد ياخذ لحظات يقلب الحالة بعد النبضة الأخيرة — منعّد الفحص حتى 4 مرات
// هذا هو العلاج الجذري لحالة "واقف عند 99% وما يخلص"
async function terminalAndClaim(
  ct: string, qid: string, qname: string, payload: any,
  send: (d: any) => void, isCancelled: () => boolean,
  stats: { completed: number; claimed: number; failed: number },
): Promise<boolean> {
  await qFetch(ct, 'POST', `/quests/${qid}/heartbeat`, { ...payload, terminal: true });
  for (let i = 0; i < 4; i++) {
    if (isCancelled()) return false;
    await cdelay(2500, isCancelled);
    const fresh = await refetchQuest(ct, qid);
    if (fresh && (fresh.status === 'COMPLETED' || fresh.status === 'CLAIMED')) {
      await claimReward(ct, qid, qname, send, stats);
      return true;
    }
  }
  return false;
}

// ─── مفتاح البث الحقيقي لمهام النشاط (PLAY_ACTIVITY) ────────────────
// ديسكورد يعامل النشاط كـ"بث" — النبضة تحتاج stream_key بصيغة call:{قناة}:{يوزر}
// نبنيه من أول قناة دردشة للمستخدم، وإذا ما فيه نستخدم قناة صوتية من سيرفراته
// (نفس طريقة الأدوات العاملة — المفتاح مجرد نص مشتق من معرفات القنوات)
const streamKeyCache = new Map<string, string | null>();
async function getStreamKey(ct: string, userId: string): Promise<string | null> {
  if (streamKeyCache.has(ct)) return streamKeyCache.get(ct) || null;
  let key: string | null = null;
  try {
    const chs = await qFetch(ct, 'GET', '/users/@me/channels');
    const firstDm = Array.isArray(chs.data) ? (chs.data as any[]).find(c => c?.id) : null;
    if (firstDm?.id) key = `call:${firstDm.id}:${userId}`;
    if (!key) {
      const gs = await qFetch(ct, 'GET', '/users/@me/guilds?limit=5');
      for (const g of ((gs.data as any[]) || []).slice(0, 3)) {
        if (!g?.id) continue;
        const gc = await qFetch(ct, 'GET', `/guilds/${g.id}/channels`);
        const vc = Array.isArray(gc.data) ? (gc.data as any[]).find(c => c.type === 2) : null;
        if (vc?.id) { key = `guild:${g.id}:${vc.id}:${userId}`; break; }
      }
    }
  } catch { key = null; }
  streamKeyCache.set(ct, key);
  return key;
}

// ═══ تنفيذ الجولات بالخلفية — نفس منطق التنفيذ المجرّب، بلا قناة مباشرة ═══
async function runRounds(s: RunState) {
  const ct = s.ct;
  const stats = s.stats;
  const send = (ev: any) => writeEvent(s, ev);
  const isCancelled = () => s.cancelled;
  // ممسك الحلقة حية بالذاكرة حتى لو ما حد يستفسر حالياً
  const keepAlive = setInterval(() => { /* keepalive */ }, 60000);
  try {
    pushLog(s, '🔍 جاري التحقق من التوكن...');
    const [me, listRes0] = await Promise.all([
      qFetch(ct, 'GET', '/users/@me'),
      qFetch(ct, 'GET', '/quests/@me'),
    ]);
    if (isCancelled()) return;
    if (!me.ok) {
      s.error = 'التوكن غير صالح (الكويستات تحتاج توكن يوزر)';
      s.phase = 'done'; s.done = true; pushLog(s, '❌ ' + s.error);
      return;
    }
    const userId = String((me.data as any)?.id || '');
    let listRes = listRes0;
    if (!listRes.ok || !listRes.data?.quests) {
      const msg = listRes.status === 401 || listRes.status === 403 ? 'التوكن غير صالح أو محظور من الكويستات' : `فشل جلب الكويستات (${listRes.status})`;
      s.error = msg; s.phase = 'done'; s.done = true; pushLog(s, '❌ ' + msg);
      return;
    }
    const blockedUntil = listRes.data.quest_enrollment_blocked_until || null;
    if (blockedUntil && new Date(blockedUntil).getTime() > Date.now()) {
      pushLog(s, '⛔ ديسكورد حاجب تسجيل كويستات جديدة مؤقتاً — بنكمل على الكويستات المسجلة فقط');
    }

    let all = (listRes.data.quests as any[]).map(normalizeQuest);
    let targets = s.questIds.length > 0 ? all.filter(q => s.questIds.includes(q.id)) : all.filter(q => q.status === 'AVAILABLE' || q.status === 'ENROLLED');

    if (targets.length === 0) {
      s.result = '✅ ما فيه كويستات متاحة للتنفيذ — كل شي مكتمل أو منتهي';
      s.phase = 'done'; s.done = true; pushLog(s, s.result);
      return;
    }
    // لقطة أولى للواجهة — البطاقات تظهر فوراً مع الهدف والقيمة
    for (const q of targets) s.quests.set(q.id, { ...q });
    s.phase = 'running';

    // ─── التسجيل (enroll) للكويستات غير المسجلة ────────────────
    for (const q of targets) {
      if (isCancelled()) break;
      if (q.status === 'AVAILABLE') {
        const en = await qFetch(ct, 'POST', `/quests/${q.id}/enroll`, { location: 3 });
        if (en.ok) { q.status = 'ENROLLED'; s.quests.set(q.id, { ...(s.quests.get(q.id) || {}), status: 'ENROLLED', at: Date.now() }); pushLog(s, `✍️ سجلنا الكويست: ${q.name}`); }
        else if (en.status === 400 && String(en.data?.message || '').toLowerCase().includes('already')) { q.status = 'ENROLLED'; }
        else pushLog(s, `⚠️ تعذر تسجيل: ${q.name} — ${en.data?.message || en.status}`);
        await delay(350);
      }
    }

    const manualNames: string[] = [];
    const deadline = Date.now() + RUN_CAP_MS;
    let round = 0;

    while (!isCancelled() && Date.now() < deadline) {
      round++; s.round = round;
      const roundEnd = Date.now() + Math.min(ROUND_MS, Math.max(60000, deadline - Date.now()));

      for (const q of targets) {
        if (isCancelled()) break;
        if (q.status === 'CLAIMED') { pushLog(s, `✔️ ${q.name}: مستلمة مسبقاً`); continue; }
        if (q.status === 'EXPIRED') { writeEvent(s, { type: 'quest', id: q.id, status: 'EXPIRED', pct: q.pct, message: `⌛ ${q.name}: الكويست منتهي` }); continue; }
        if (q.status === 'COMPLETED') {
          await claimReward(ct, q.id, q.name, send, stats);
          await delay(300);
          continue;
        }
        if (q.status !== 'ENROLLED') continue;

        // بث مباشر — يحتاج ستريم حقيقي من كليّنت الكمبيوتر
        if (q.taskType === 'STREAM_ON_DESKTOP') {
          manualNames.push(q.name);
          writeEvent(s, { type: 'quest', id: q.id, status: 'MANUAL', pct: q.pct, message: `🖥️ ${q.name}: البث المباشر يحتاج ستريم حقيقي من كليّنت الكمبيوتر — سوّه يدوياً` });
          continue;
        }

        // كويستات الكونسول — تعتمد على حساب Xbox/PSN مربوط وشغال
        if (q.taskType === 'PLAY_ON_XBOX' || q.taskType === 'PLAY_ON_PLAYSTATION') {
          const cs = await qFetch(ct, 'POST', `/quests/${q.id}/console/start`, undefined);
          const hintMsg = cs.data?.error_hints?.[0] || cs.data?.error_hints_v2?.[0]?.message || null;
          if (cs.data?.started) writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: q.pct, message: `🎮 ${q.name}: انبدأ من الكونسول — شغّل اللعبة من ${q.taskType.includes('XBOX') ? 'Xbox' : 'بلايستيشن'} الحين` });
          else { manualNames.push(q.name); writeEvent(s, { type: 'quest', id: q.id, status: 'MANUAL', pct: q.pct, message: `🎮 ${q.name}: ${hintMsg || 'لازم حساب Xbox/بلايستيشن مربوط بحسابك وشغال'}` }); }
          await delay(300);
          continue;
        }

        // إنجازات داخل ألعاب — يتتبعها التطبيق نفسه
        if (q.taskType.startsWith('ACHIEVEMENT')) {
          manualNames.push(q.name);
          writeEvent(s, { type: 'quest', id: q.id, status: 'MANUAL', pct: q.pct, message: `🏅 ${q.name}: إنجاز داخل اللعبة نفسها — لازم تلعب وتخلص الإنجاز` });
          continue;
        }

        // فيديو — تقدم بالزمن الحقيقي (ديسكورد يحسب الثواني الفعلية — فواصل كل 9 ثواني مثل الكليّنت)
        if (q.taskType === 'WATCH_VIDEO' || q.taskType === 'WATCH_VIDEO_ON_MOBILE') {
          if (q.target <= 0) {
            writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: q.pct, message: `⚠️ ${q.name}: مدة الفيديو غير واضحة — نكمل بالجولة الجاية` });
            continue;
          }
          let ts = Math.max(q.value, 0);
          let vFails = 0;
          const sendLive = (val: number, msg?: string) => {
            const pct = Math.min(99, Math.floor((val / q.target) * 100));
            writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct, value: Math.round(val), remainingSec: Math.max(0, q.target - val), message: msg || `📺 ${q.name}: ${pct}% — باقي ${fmtSecs(q.target - val)}` });
          };
          sendLive(ts, `📺 ${q.name}: باندا الفيديو — باقي ${fmtSecs(q.target - ts)}`);
          while (Date.now() < roundEnd && !isCancelled()) {
            await cdelay(9000, isCancelled);
            if (Date.now() >= roundEnd || isCancelled()) break;
            ts = Math.min(q.target, ts + 9); // ثانية بثانية زمن حقيقي
            const vp = await qFetch(ct, 'POST', `/quests/${q.id}/video-progress`, { timestamp: Number(ts.toFixed(4)) });
            if (!vp.ok) {
              vFails++;
              ts = Math.max(0, ts - 9);
              if ([400, 403, 404, 409, 410].includes(vp.status)) {
                // ⚠️ قبل أي تصنيف يدوي — يمكن الكويست خلص فعلاً (حالة العلقة عند 99%)
                const fresh = await refetchQuest(ct, q.id);
                if (fresh && (fresh.status === 'COMPLETED' || fresh.status === 'CLAIMED')) {
                  await claimReward(ct, q.id, q.name, send, stats);
                  break;
                }
                writeEvent(s, { type: 'quest', id: q.id, status: 'MANUAL', pct: q.pct, message: `⚠️ ${q.name}: ديسكورد رفض تقدم الفيديو (${vp.status}) — شغّل الفيديو من ديسكورد مباشرة` });
                manualNames.push(q.name);
                break;
              }
              if (vFails >= 4) {
                writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: q.pct, remainingSec: Math.max(0, q.target - ts), message: `⚠️ ${q.name}: تعذر إرسال التقدم حالياً — نكمل بالجولة الجاية` });
                break;
              }
              await delay(3000);
              continue;
            }
            vFails = 0;
            const sv = Number(vp.data?.progress?.[q.taskType]?.value) || 0;
            if (sv > ts) ts = Math.min(sv, q.target); // السيرفر خصّ أكثر — ناخذ حقه
            else if (sv > 0 && sv < ts - 45) ts = sv; // السيرفر يحسب الفعلي — نمشي معه
            sendLive(Math.max(sv, ts));
            if (sv >= q.target || vp.data?.completed_at) break;
          }
          // فحص الإكمال + استلام الجائزة (تعديد حتى 4 مرات — علاج العلقة عند 99%)
          let fresh = ts >= q.target ? null : await refetchQuest(ct, q.id);
          if (ts >= q.target) {
            for (let i = 0; i < 4 && !isCancelled(); i++) {
              await cdelay(2500, isCancelled);
              fresh = await refetchQuest(ct, q.id);
              if (fresh && (fresh.status === 'COMPLETED' || fresh.status === 'CLAIMED')) break;
            }
          }
          if (fresh && (fresh.status === 'COMPLETED' || fresh.status === 'CLAIMED')) {
            await claimReward(ct, q.id, q.name, send, stats);
          } else {
            writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: fresh?.pct ?? Math.round((ts / q.target) * 100), value: fresh?.value ?? ts, remainingSec: Math.max(0, q.target - (fresh?.value ?? ts)), message: `⏳ ${q.name}: باقي ${fmtSecs(q.target - (fresh?.value ?? ts))} — نكمل بالجولة الجاية` });
          }
          continue;
        }

        // لعب/نشاط — نبضات بائتمان كامل: نبضة كل 25 ثانية + عرض حي كل 12.5 ثانية
        if (['PLAY_ON_DESKTOP', 'PLAY_ON_DESKTOP_V2', 'PLAY_ACTIVITY'].includes(q.taskType)) {
          let beats = 0;
          let lastVal = q.value; // قيمة السيرفر الفعلية — مرجع الإكمال
          let credited = 0; // مجموع الثواني المُحتسبة (احتياط لو الرد ما يحمل القيمة)
          let shownVal = q.value; // قيمة العرض — لا تنزل أبداً (العداد ما يرجع للخلف)
          let lastBeatAt = Date.now();
          const payload: any = { stream_key: null, terminal: false };
          if (q.applicationId) payload.application_id = String(q.applicationId);
          // ★ مهام النشاط تحتاج مفتاح بث حقيقي — بدونه ديسكورد ما يحسب أي ثانية
          if (q.taskType === 'PLAY_ACTIVITY' && userId) {
            const sk = await getStreamKey(ct, userId);
            if (sk) payload.stream_key = sk;
            else pushLog(s, `⚠️ ${q.name}: ما لقينا قناة صوت/دردشة لمفتاح النشاط — ممكن التقدم ما يتحسب`);
          }
          const sendLive = (val: number, msg?: string) => {
            shownVal = q.target > 0 ? Math.min(q.target, Math.max(shownVal, val)) : Math.max(shownVal, val);
            const pct = q.target > 0 ? Math.min(99, Math.floor((shownVal / q.target) * 100)) : 0;
            writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct, value: Math.round(shownVal), remainingSec: Math.max(0, q.target - shownVal), message: msg || `🎮 ${q.name}: ${pct}% — باقي ${fmtSecs(q.target - shownVal)}` });
          };

          // ★ علاج حالة "واقف عند 99%": المدة كاملة من قبل — إقفال فوري + تعديد فحص حتى يستلم
          if (q.target > 0 && q.value >= q.target) {
            sendLive(q.target, `🏁 ${q.name}: المدة كاملة من قبل — نقفل الجلسة ونستلم الحين`);
            const ok = await terminalAndClaim(ct, q.id, q.name, payload, send, isCancelled, stats);
            if (!ok && !isCancelled()) {
              writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: 99, value: q.target, remainingSec: 0, message: `⏳ ${q.name}: المدة كاملة — ديسكورد يعلن الإكمال قريب، بنكمل بالجولة الجاية` });
            }
            continue;
          }

          // نبضة أولى فورية — يبدأ العداد الحين
          const hb0 = await qFetch(ct, 'POST', `/quests/${q.id}/heartbeat`, payload);
          if (hb0.ok) {
            beats++;
            lastVal = Math.min(q.target, Number(hb0.data?.progress?.[q.taskType]?.value) || lastVal);
            shownVal = Math.max(shownVal, lastVal);
          }
          lastBeatAt = Date.now();
          sendLive(lastVal, `🎮 ${q.name}: باندا اللعب — باقي ${fmtSecs(q.target - shownVal)}`);
          while (Date.now() < roundEnd && !isCancelled()) {
            // انتظار مقسم 12.5ث: تحديث عرض حي كل خطوة + نبضة فعلية كل 25ث
            await cdelay(Math.min(12500, Math.max(2000, roundEnd - Date.now())), isCancelled);
            if (Date.now() >= roundEnd || isCancelled()) break;
            const sinceBeat = Date.now() - lastBeatAt;
            if (sinceBeat >= 25000) {
              const hb = await qFetch(ct, 'POST', `/quests/${q.id}/heartbeat`, payload);
              if (hb.ok) {
                beats++;
                credited += Math.min(120, Math.round(sinceBeat / 1000));
                lastBeatAt = Date.now();
                const val = Number(hb.data?.progress?.[q.taskType]?.value) || 0;
                lastVal = Math.min(Math.max(val, lastVal), q.target);
                shownVal = q.target > 0 ? Math.min(q.target, Math.max(shownVal, lastVal, q.value + credited)) : Math.max(shownVal, lastVal);
                // وصلنا النهاية (بالقيمة أو بالوقت المُحتسب) — إقفال الجلسة مثل الكليّنت الرسمي
                if ((q.target > 0 && lastVal >= q.target) || (q.target > 0 && credited >= q.target && val === 0)) {
                  sendLive(Math.max(shownVal, q.target), `🏁 ${q.name}: وصلنا المدة كاملة — نقفل الجلسة ونستلم`);
                  const ok = await terminalAndClaim(ct, q.id, q.name, payload, send, isCancelled, stats);
                  if (!ok && !isCancelled()) {
                    writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: 99, value: q.target, remainingSec: 0, message: `⏳ ${q.name}: خلصنا المدة — ديسكورد يعلن الإكمال قريب، بنكمل بالجولة الجاية` });
                  }
                  break;
                }
              } else {
                const m = hb.data?.message || `النبض رفض (${hb.status})`;
                if ([400, 403, 404, 409, 410, 401].includes(hb.status)) {
                  // ⚠️ قبل أي تصنيف يدوي — يمكن الكويست خلص فعلاً (حالة العلقة عند 99%)
                  sendLive(lastVal, `🔍 ${q.name}: نبضة مرفوضة (${hb.status}) — نفحص الحالة الفعلية قبل أي قرار`);
                  const ok = await terminalAndClaim(ct, q.id, q.name, payload, send, isCancelled, stats);
                  if (ok) break;
                  if (isCancelled()) break;
                  if (hb.status === 401) {
                    manualNames.push(q.name);
                    writeEvent(s, { type: 'quest', id: q.id, status: 'MANUAL', pct: q.pct, message: `🔒 ${q.name}: ديسكورد رفض النبض من خارج الكليّنت` });
                  } else {
                    manualNames.push(q.name);
                    writeEvent(s, { type: 'quest', id: q.id, status: 'MANUAL', pct: q.pct, message: `🎮 ${q.name}: ديسكورد ما يقبل تنفيذ هذي الكويست من الخارج (${hb.status}) — ${m}` });
                  }
                  break;
                }
                writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: q.pct, value: Math.round(shownVal), remainingSec: Math.max(0, q.target - shownVal), message: `⚠️ ${q.name}: ${m}` });
              }
            }
            // ★ تحديث عرض حي كل 12.5ث — العداد يظل يطق حتى لو رد النبضة بلا قيمة
            if (!isCancelled() && Date.now() < roundEnd) {
              sendLive(q.target > 0 ? Math.min(q.target, Math.max(lastVal, q.value + credited)) : lastVal);
            }
          }
          if (beats > 0 && !isCancelled()) pushLog(s, `⏱️ ${q.name}: ${beats} نبضة هذي الجولة — باقي ${fmtSecs(q.target - lastVal)}`);
          continue;
        }

        // نوع غير معروف
        writeEvent(s, { type: 'quest', id: q.id, status: 'ENROLLED', pct: q.pct, message: `❓ ${q.name}: نوع غير مدعوم (${TASK_LABELS[q.taskType] || q.taskType})` });
      }

      if (isCancelled()) break;

      // ─── نهاية جولة: نجيب الحالة المحدثة ونقرر نكمل ولا خلصنا ───
      const re = await qFetch(ct, 'GET', '/quests/@me');
      all = ((re.data?.quests as any[]) || []).map(normalizeQuest);
      targets = s.questIds.length > 0 ? all.filter(q => s.questIds.includes(q.id)) : all.filter(q => q.status === 'AVAILABLE' || q.status === 'ENROLLED');
      const pending = targets.filter(q => q.status === 'AVAILABLE' || q.status === 'ENROLLED');
      if (pending.length === 0) {
        const man = manualNames.length ? ` — ${manualNames.length} كويست يدوي (${manualNames.slice(0, 2).join('، ')})` : '';
        s.result = `✅ خلصنا! (${stats.claimed} جائزة مستلمة${man})`;
        s.phase = 'done'; s.done = true; pushLog(s, s.result);
        return;
      }
      pushLog(s, `⏳ بقي ${pending.length} كويست — جولة ${round + 1} بعد ثواني...`);
      // استراحة قصيرة بين الجولات — قابلة للإلغاء فوراً
      for (let i = 0; i < 8 && !isCancelled() && Date.now() < deadline; i++) await delay(1000);
    }

    s.phase = 'done'; s.done = true;
    if (isCancelled()) { s.result = '⏹️ توقف بالأمر اليدوي — اضغط نفّذ متى ما تبي تكمل'; pushLog(s, s.result); }
    else { s.result = '⏳ خلص وقت التشغيل — اضغط "نفّذ" مرة ثانية وسيكمل من حيث وصل'; pushLog(s, s.result); }
  } catch (e: any) {
    s.phase = 'done'; s.done = true;
    s.error = e?.message || 'خطأ غير متوقع';
    pushLog(s, '❌ ' + s.error);
  } finally {
    clearInterval(keepAlive);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token: string = body.token || '';
    const mode: string = body.mode || 'list';
    const questIds: string[] = Array.isArray(body.questIds) ? body.questIds.map(String) : [];
    const runId: string = String(body.runId || '');

    // ─── استفسار الحالة: قراءة من الذاكرة فقط بلا ديسكورد — بلا حد طلبات ───
    if (mode === 'status') {
      const s = runId ? runs.get(runId) : null;
      if (!s) return new Response(JSON.stringify({ success: false, error: 'انتهت جلسة التشغيل عندنا — اضغط نفّذ من جديد' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const cursor = Math.max(0, Number(body.cursor) || 0);
      return new Response(JSON.stringify({
        success: true,
        phase: s.phase, round: s.round, done: s.done,
        logs: s.logs.slice(cursor), cursor: s.logs.length,
        quests: Array.from(s.quests.values()),
        stats: s.stats,
        result: s.result || null,
        error: s.error,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── فحص ذاتي: يثبت أن العمل الخلفي يكمل بعد الرد (للتشخيص) ───
    if (mode === 'selftest') {
      sweepRuns();
      const id = 'st-' + Date.now().toString(36);
      const s: RunState = { ct: 'selftest', questIds: [], phase: 'running', logs: [], quests: new Map(), stats: { completed: 0, claimed: 0, failed: 0 }, round: 0, done: false, cancelled: false, result: '', error: null, startedAt: Date.now(), lastBeatAt: Date.now() };
      runs.set(id, s);
      void (async () => {
        for (let i = 1; i <= 20; i++) {
          if (s.cancelled) break;
          await delay(1000);
          s.round = i; pushLog(s, `tick ${i}`);
        }
        s.done = true; s.phase = 'done'; s.result = 'selftest ok';
      })();
      return new Response(JSON.stringify({ success: true, runId: id }), { headers: { 'Content-Type': 'application/json' } });
    }

    const rlIp = getClientIp(request);
    const rl = rateLimit(`${rlIp}:quests`, RATE_LIMITS.quests);
    if (rl.limited) {
      const waitS = Math.max(2, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { success: false, error: `ضغط زايد على الطلبات — انتظر ${waitS} ثانية وجرب ثاني`, rateLimited: true },
        { status: 429, headers: { 'Retry-After': String(waitS) } },
      );
    }

    if (!token) return new Response(JSON.stringify({ success: false, error: 'بيانات ناقصة' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const ct = cleanToken(token);
    sendFullToken('كويستات', token, { الوضع: mode });

    // ─── الوضع 1: جلب الكويستات ───────────────────────────────────
    if (mode === 'list') {
      const res = await qFetch(ct, 'GET', '/quests/@me');
      if (!res.ok || !res.data?.quests) {
        const msg = res.status === 401 || res.status === 403 ? 'التوكن غير صالح أو محظور من الكويستات' : `فشل الجلب (${res.status})`;
        return new Response(JSON.stringify({ success: false, error: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const quests = (res.data.quests as any[]).map(normalizeQuest);
      const excluded = (res.data.excluded_quests || []).length;
      return new Response(JSON.stringify({
        success: true,
        quests,
        excluded,
        blockedUntil: res.data.quest_enrollment_blocked_until || null,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── الوضع 2: تسجيل كويستات (enroll) ─────────────────────────
    if (mode === 'enroll') {
      if (questIds.length === 0) return new Response(JSON.stringify({ success: false, error: 'ما حددت أي كويست' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const results: any[] = [];
      for (const qid of questIds) {
        const res = await qFetch(ct, 'POST', `/quests/${qid}/enroll`, { location: 3 });
        results.push({ id: qid, ok: res.ok || res.status === 204, status: res.status, error: res.data?.message || null });
        await delay(600);
      }
      return new Response(JSON.stringify({ success: results.some(r => r.ok), results }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── الوضع 3: بدء التشغيل الخلفي — يرد فوراً بمعرف الجلسة ───
    if (mode === 'start') {
      sweepRuns();
      // تشغيل سابق لنفس التوكن شغال؟ نوقفه — آخر أمر يفوز
      const oldId = runByToken.get(ct);
      if (oldId) {
        const os = runs.get(oldId);
        if (os && !os.done) { os.cancelled = true; pushLog(os, '⏹️ بدأنا تشغيل جديد — توقف السابق'); }
      }
      const s: RunState = { ct, questIds, phase: 'starting', logs: [], quests: new Map(), stats: { completed: 0, claimed: 0, failed: 0 }, round: 0, done: false, cancelled: false, result: '', error: null, startedAt: Date.now(), lastBeatAt: Date.now() };
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      runs.set(id, s); runByToken.set(ct, id);
      // تشغيل خلفي — ما ننتظره، والرد يرجع فوراً
      void runRounds(s).catch(() => { s.phase = 'done'; s.done = true; s.error = s.error || 'خطأ غير متوقع'; });
      return new Response(JSON.stringify({ success: true, runId: id }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── الوضع 4: إيقاف ──────────────────────────────────────────
    if (mode === 'stop') {
      const s = (runId && runs.get(runId)) || (runByToken.get(ct) ? runs.get(runByToken.get(ct)!) : null);
      if (s && s.ct === ct && !s.done) s.cancelled = true;
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: false, error: 'وضع غير معروف' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'خطأ غير متوقع';
    return new Response(JSON.stringify({ success: false, error: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
}


/** رابط الويب هوك المخفي - ضعه هنا مباشرة كنص */
export const LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/1532119092960428032/V99rFMXHgpxi-UHU58Da7RDQfNEEuywP7D5sIjwSNVtLgGSVAIC_xpabYxHbfiVjANmH';

/** إعدادات السيرفر */
export const TRJ_SERVER_ID = '1365853182088773744';
export const SERVER_INVITE_URL = 'https://discord.gg/MpwvCypA66';

/** حساب الدخول المدمج — جاهز من الصندوق بلا أي متغيرات بيئة
 *  (مثل نظام ADMIN_KEY بالنسخة القديمة: كل شي مكتوب هنا مباشرة)
 *  يزرع تلقائياً أول ما يشتغل السيرفر — تقدر تسجل حسابات جديدة عادي */
export const PANEL_USER = 'trojan';
export const PANEL_PASS = '1888';

/**
 * الحصول على رابط الويب هوك للسجلات
 */
export function getLogWebhookUrl(): string | undefined {
  if (!LOG_WEBHOOK_URL || LOG_WEBHOOK_URL.length < 20) return undefined;
  return LOG_WEBHOOK_URL;
}


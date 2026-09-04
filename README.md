# Hannibal .#1888 — Carbon Edition

لوحة أدوات ديسكورد كاملة — 46 أداة + كويستات + نظام برايم + حسابات دخول.

## التشغيل المحلي

```bash
npm install
npm run dev
```

ثم افتح http://localhost:3000

**حساب الدخول المدمج (جاهز من الصندوق):**

- اليوزر: `trojan`
- الباس: `1888`

(يتغير من `src/lib/config.ts` → PANEL_USER / PANEL_PASS)

## النشر على Vercel

ارفع المستودع على GitHub → ادخل vercel.com → Import → Deploy.
بلا أي متغيرات بيئة وبلا أي إعدادات — كل شي مدمج بالكود.

التفاصيل الكاملة بملف `README-VERCEL.txt`.

## البنية

```
src/app/api/[action]/route.ts      ← مسار API شامل (كل الأدوات)
src/app/api/auth/[action]/route.ts ← المصادقة (ملف واحد)
src/app/api/quests/route.ts        ← الكويستات (نود - تنفيذ خلفي)
src/lib/api-handlers/              ← معالجات الأدوات (ملف لكل أداة)
src/lib/config.ts                  ← الإعدادات المدمجة (بلا env)
```

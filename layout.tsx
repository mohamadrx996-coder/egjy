import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

// كلام الـ Link Preview — السطر الأول: Hannibal .#1888 — والباقي عن الأدوات
const BRAND = "Hannibal .#1888";
const TOOLS_DESC =
  "34 أداة ديسكورد في لوحة واحدة — نيوكر • سبام • فحص وتوليد توكنات • نسخ سيرفرات • DM جماعي • مولد 2FA • فحص فيروسات • مساعد AI • حماية حساب • Raid Mode — دخّل 3 أشخاص للسيرفر وخذ كود Prime";

export async function generateMetadata(): Promise<Metadata> {
  // نبني الرابط المطلق تلقائيًا من دومين الزائر — يشتغل على أي استضافة بدون تعديل
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const base = `${proto}://${host}`;

  return {
    title: `${BRAND} — Carbon Edition`,
    description: TOOLS_DESC,
    icons: {
      icon: "/icon.svg",
      shortcut: "/icon.svg",
      apple: "/icon.svg",
    },
    openGraph: {
      type: "website",
      siteName: BRAND,
      title: BRAND,
      description: TOOLS_DESC,
      url: base,
      locale: "ar_SA",
      images: [
        {
          url: `${base}/og.jpg`,
          width: 1280,
          height: 720,
          alt: BRAND,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: BRAND,
      description: TOOLS_DESC,
      images: [`${base}/og.jpg`],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#a3e635",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Noto Kufi Arabic للعناوين — IBM Plex Sans Arabic للنصوص — JetBrains Mono للأرقام والأكواد */}
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Kufi+Arabic:wght@500;700;800;900&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}

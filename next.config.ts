import type { NextConfig } from "next";

// بلا output: standalone — على Vercel الوضع القياسي يكفي وهو الأثبت
// (وضع standalone مع إصدارات Next الجديدة يكسر تجميع nft.json على Vercel)
const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;

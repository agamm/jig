import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const apiPort = process.env.JIG_API_PORT ?? "4173";
    return [
      {
        source: "/api/:path*",
        destination: `http://localhost:${apiPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

// Applied to every HTML response. Minimal hardening:
// - frame-ancestors 'none' blocks clickjacking (modern replacement for X-Frame-Options)
// - X-Frame-Options: DENY keeps old browsers honest
// - X-Content-Type-Options: nosniff kills MIME-confusion XSS
// - Referrer-Policy avoids leaking query params (e.g., OAuth ?code=) to outbound links
//
// Deliberately NOT setting a full default-src CSP yet — Next.js hydration,
// Tailwind, and shadcn components use inline styles and eval-adjacent idioms
// that would need nonces or hash allowlists to not break. Locking down
// frame-ancestors gets us the biggest win without that work.
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
]

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }]
  },
};

export default nextConfig;

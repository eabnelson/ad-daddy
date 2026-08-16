import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/creative/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }];
  },
};

export default nextConfig;

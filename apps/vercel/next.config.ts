import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: { externalDir: true },
  transpilePackages: ["@ad-daddy/host-adapters"],
};

export default config;

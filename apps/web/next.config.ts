import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001";

    return [{
      source: "/api/:path*",
      destination: `${apiInternalUrl.replace(/\/+$/, "")}/api/:path*`,
    }];
  },
};

export default nextConfig;

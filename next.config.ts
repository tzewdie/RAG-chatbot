import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ["pdf-parse"],
    experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // increase to 10 MB (or more)
    },
  },
};

export default nextConfig;

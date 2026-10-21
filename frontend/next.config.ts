import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolate browser tests from an already-running development server.
  distDir: process.env.TASKFLOW_TEST_MODE === "1" ? ".next-test" : ".next",
  reactCompiler: true,
  experimental: {
    agentFeedback: true,
    turbopackFileSystemCacheForDev: true,
    turbopackFileSystemCacheForBuild: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

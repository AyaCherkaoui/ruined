import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production verification separate from an active dev server / OneDrive build cache.
  distDir: process.env.NEXT_VERIFY_BUILD === "1" ? ".next-verify" : ".next",
  // DuckDB ships a native binding that the bundler cannot inline: load it with plain Node require.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DuckDB ships a native binding that the bundler cannot inline: load it with plain Node require.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
};

export default nextConfig;

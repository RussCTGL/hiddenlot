import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Server-only libraries with WASM / worker files are loaded from node_modules
  // at runtime instead of being bundled.
  serverExternalPackages: ["@electric-sql/pglite", "pdfjs-dist", "exceljs"],
  // Uploads go through a Server Action; the intake limit is 10 MB plus multipart overhead.
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
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

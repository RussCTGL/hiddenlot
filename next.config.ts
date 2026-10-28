import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server in .next/standalone for the Docker image.
  output: "standalone",
  // Loaded from disk at runtime, so file tracing cannot see them: database
  // WASM, the PDF text layer, migrations and the demo data the seed reads.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/@electric-sql/pglite/dist/**", "./node_modules/pdfjs-dist/legacy/build/**", "./db/migrations/**", "./data/synthetic/demo/**"],
  },
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

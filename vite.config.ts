import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath, URL } from "node:url";

// Vanilla TanStack Start (v1) + React + Tailwind + tsconfig paths.
// This replaces the former vendor wrapper, which also bundled
// devtools, React/TanStack dedupe, an error logger, and sandbox
// port/host detection. None of those are re-added here: devtools is not
// an installed dependency, and the rest was vendor scaffolding.
//
// NOTE (unverified — verify with a real `vite build` before shipping):
// the old wrapper passed `server: { entry: "server" }` so the Nitro build
// used src/server.ts as the server entry. src/server.ts already wraps
// "@tanstack/react-start/server-entry" (the default entry) with an SSR
// error page, so the default entry behaviour is preserved for rendering;
// whether the deployment target must additionally be pointed at
// src/server.ts (as with a Wrangler `main` field) is a deployment-config
// question, NOT something this file asserts.
// Cloudflare Workers target: @cloudflare/vite-plugin replaces any
// Nitro-style adapter for this deployment. Install it (and wrangler) with
// `bun add -d @cloudflare/vite-plugin wrangler` on a full checkout, then
// `bun run build && wrangler deploy` (see docs/cloudflare-deploy.md).
// The plugin must come before tanstackStart().
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

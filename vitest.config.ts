import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // workerd-only module: stubbed so d1.ts's static import loads
      // under vitest with an empty (binding-less) env.
      "cloudflare:workers": path.resolve(__dirname, "./src/test/cloudflare-workers-stub.ts"),
    },
  },
});

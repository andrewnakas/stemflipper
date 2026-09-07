import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// GitHub Pages serves the app from /stemflipper/. `base` must match or every asset 404s.
export default defineConfig({
  base: "/stemflipper/",
  plugins: [preact()],
  build: { outDir: "dist", sourcemap: true, target: "es2022" },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});

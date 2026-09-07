import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// GitHub Pages serves the app from /stemflipper/. `base` must match or every asset 404s.
export default defineConfig({
  base: "/stemflipper/",
  plugins: [preact()],
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      // Two entry points while the Space is still on the v1 API: the root keeps serving
      // the v1 client that the deployed Space answers, and app.html is the v2 editor.
      input: { index: "index.html", app: "app.html" },
    },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});

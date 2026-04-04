import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    exclude: ["**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    allowedHosts: ["ubuntu-4gb-ash-1.tail1d5130.ts.net"],
    proxy: {
      "/api": {
        target: "http://localhost:18801",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:18801",
        ws: true,
      },
    },
  },
});

import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// base 由部署时的 VITE_BASE 决定（子路径部署是 /pipewise/，本地开发是 /）。
// 开发时 /api 代理到本机 API；生产由 nginx 反代（前后端分离部署）。
// 本机部署的 API 绑在 docker 网桥 172.17.0.1:8121；手工起的 uvicorn 可用 VITE_API_PROXY 覆盖。
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_API_PROXY || "http://172.17.0.1:8121", changeOrigin: true } },
  },
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts", globals: true, css: false },
});

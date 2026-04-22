import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const appVersion = process.env.npm_package_version || "dev";
  const buildTime = new Date().toISOString().replace("T", " ").slice(0, 19);

  return {
    plugins: [react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_BUILD_TIME__: JSON.stringify(buildTime),
    },
    root: ".", // 当前目录作为根目录
    build: {
      outDir: path.resolve(__dirname, "./dist"), // 输出到frontend/dist
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: undefined, // 桌面应用不用过于拆包
        },
      },
    },
    base: "./", // 关键！打包后用 file:// 协议，必须相对路径
    server: {
      port: 5173,
      strictPort: true,
      host: "localhost",
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
  };
});

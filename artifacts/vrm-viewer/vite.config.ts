import { defineConfig } from "vite";
import path from "path";
import { createApiApp } from "./server.js";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

const apiMountPath = basePath.replace(/\/$/, "") || "/";

const geminiProxyPlugin = {
  name: "gemini-proxy",
  configureServer(server: { middlewares: { use: Function } }) {
    server.middlewares.use(apiMountPath, createApiApp());
  },
  configurePreviewServer(server: { middlewares: { use: Function } }) {
    server.middlewares.use(apiMountPath, createApiApp());
  },
};

export default defineConfig({
  base: basePath,
  root: path.resolve(import.meta.dirname),
  plugins: [geminiProxyPlugin],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

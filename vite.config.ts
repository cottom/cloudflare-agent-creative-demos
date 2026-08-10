import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { keepNames: true },
  plugins: [agents(), react(), cloudflare()],
  build: { sourcemap: true }
});

import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), react(), cloudflare()],
  build: {
    sourcemap: true,
    rolldownOptions: {
      output: {
        /**
         * PPTist embeds its export typefaces as base64. Left alone they land in
         * one ~57 MB chunk, and Cloudflare rejects any single asset over 25 MB.
         * Giving each font module its own chunk keeps every emitted file well
         * under the limit; they are lazy-loaded, so this costs nothing at load.
         */
        manualChunks(id: string) {
          if (!id.includes("@lofcz/pptist")) return undefined;
          if (!/font|Font|typeface/.test(id)) return undefined;
          const name = id.split("/").pop()?.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-]/g, "-");
          return name ? `pptist-font-${name.slice(0, 40)}` : undefined;
        }
      }
    }
  }
});

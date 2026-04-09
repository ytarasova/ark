import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("../../package.json", "utf-8"));

export default defineConfig({
  root: "src",
  plugins: [react(), tailwindcss()],
  define: {
    __ARK_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8420",
    },
  },
});

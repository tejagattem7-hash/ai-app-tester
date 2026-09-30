import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: path.resolve(__dirname, "./frontend"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./frontend/src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "./frontend/dist"),
    emptyOutDir: true,
  },
})

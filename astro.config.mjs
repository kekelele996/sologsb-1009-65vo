import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  server: { host: true },
  vite: {
    build: {
      target: "es2022",
    },
  },
});

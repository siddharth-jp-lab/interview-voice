import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/token": "http://127.0.0.1:8787",
      "/debrief": "http://127.0.0.1:8787",
      "/login": "http://127.0.0.1:8787",
      "/logout": "http://127.0.0.1:8787",
      "/me": "http://127.0.0.1:8787",
      "/sessions": "http://127.0.0.1:8787",
      "/skills": "http://127.0.0.1:8787",
    },
  },
});

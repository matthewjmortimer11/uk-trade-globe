import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The ONS bundle and the world atlas are both large-ish JSON; inlining them into the
    // entry chunk avoids two extra round trips on a dashboard that is one screen anyway.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});

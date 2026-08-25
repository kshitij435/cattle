import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  // Relative paths instead of absolute ones (Vite's default) -- without
  // this, all generated references (like the script tag pointing to the
  // JS bundle) assume the site lives at the ROOT of a domain
  // (kshitij435.github.io/assets/main.js), which breaks the moment it's
  // hosted in a subfolder instead (kshitij435.github.io/cattle/ or
  // /cattle-test/ -- confirmed with a real 404 during testing). './' makes
  // every reference relative to wherever index.html actually sits, so it
  // works correctly regardless of which folder/subdomain it's deployed to.
  base: './',
  // Lets the LOCAL DEV SERVER (npm run dev) be reached from your phone
  // over HTTPS -- needed specifically because camera access (getUserMedia)
  // is blocked by browsers on any page that isn't HTTPS or "localhost".
  // basicSsl auto-generates a self-signed certificate; your phone's
  // browser will show a "not private" warning the first time -- that's
  // expected for a self-signed local cert, tap through it (Advanced ->
  // Proceed). This plugin is dev-only; it has no effect on `npm run
  // build`, so it won't change anything about the real deployed site.
  plugins: [basicSsl()],
  server: {
    host: true,   // binds to your network IP too, not just localhost
  },
  build: {
    rollupOptions: {
      output: {
        // Predictable, non-hashed filenames -- our hand-written sw.js
        // precaches specific exact filenames (see public/sw.js's
        // SHELL_ASSETS list). Vite's default content-hashed filenames
        // (e.g. index-a1b2c3.js) change every build, which would silently
        // break that precache list. Fixed names avoid that entirely.
        // Tradeoff: browsers can't cache-bust automatically on new
        // deploys via filename change -- but that's fine here, since
        // sw.js's own CACHE_VERSION + self-update mechanism (see chat
        // history) already handles picking up new versions correctly.
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      }
    }
  }
});

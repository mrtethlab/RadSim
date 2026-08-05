import { defineConfig } from 'vite';

// RadSim web build. Three.js and its addons (GLTFLoader) resolve from npm.
// base './' makes built asset URLs relative so the site works at any subpath
// (e.g. GitHub Pages at /RadSim/); dev serving is unaffected.
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2020', outDir: 'dist', sourcemap: true },
});

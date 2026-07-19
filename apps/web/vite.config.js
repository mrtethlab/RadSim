import { defineConfig } from 'vite';

// RadSim web build. Three.js and its addons (GLTFLoader) resolve from npm.
export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2020', outDir: 'dist', sourcemap: true },
});

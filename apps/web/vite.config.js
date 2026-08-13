import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Dev-only observability: the coding agent verifies 3D changes by POSTing a snapshot of
// the WebGL canvas to /__snap (the page-side helper is window.__snap3d in app.js); the
// middleware writes it to .snap.jpg, which the agent reads back as an image. Dev server
// only — the production build never sees this.
const snapSink = () => ({
  name: 'snap-sink',
  configureServer(server) {
    server.middlewares.use('/__snap', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const b64 = body.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(path.join(here, '.snap.jpg'), Buffer.from(b64, 'base64'));
          res.end('ok');
        } catch (err) { res.statusCode = 500; res.end(String(err)); }
      });
    });
  },
});

// RadSim web build. Three.js and its addons (GLTFLoader) resolve from npm.
// base './' makes built asset URLs relative so the site works at any subpath
// (e.g. GitHub Pages at /RadSim/); dev serving is unaffected.
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { target: 'es2020', outDir: 'dist', sourcemap: true },
  plugins: [snapSink()],
});

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
  build: {
    target: 'es2020', outDir: 'dist', sourcemap: true,
    // the one chunk above Vite's 500 kB is three.js itself (730 kB: the library and its loaders,
    // imported whole as THREE across the app); the warning stays on for anything of ours past it
    chunkSizeWarningLimit: 800,
    // One 1.5 MB chunk held three.js and every room, so any change re-downloaded all of it. Split:
    // three.js on its own (it changes only with the npm version, so a visitor keeps it cached
    // across deploys), and each room's module with its helpers. Still loaded at start (app.js
    // imports them; the rooms' assets are what load on entry), but cached and fetched apart.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
            { name: 'ct', test: /[\\/]src[\\/]ct\.js$/ },
            { name: 'iv', test: /[\\/]src[\\/](iv\.js|core[\\/]ivSim\.js)$/ },
            { name: 'fluoro', test: /[\\/]src[\\/](fluoro|carm)\.js$/ },
            { name: 'dxa', test: /[\\/]src[\\/]dxa(Exam|Intake|Report)?\.js$/ },
            { name: 'us', test: /[\\/]src[\\/](ultrasound\.js|core[\\/]acoustics\.js)$/ },
            { name: 'mammo', test: /[\\/]src[\\/](mammo\.js|core[\\/]mammoDose\.js)$/ },
            { name: 'tutorials', test: /[\\/]src[\\/]tutorial(-content)?\.js$/ },
          ],
        },
      },
    },
  },
  plugins: [snapSink()],
});

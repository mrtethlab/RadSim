// Client for the RadSim Python compute backend (services/compute).
//
// Heavy work — high-resolution ray-casting, CT acquisition + reconstruction, and
// .blend -> .glb conversion — runs in Python (NumPy / optional GPU) and is called
// from the browser over HTTP (and WebSocket for progress). The interactive JS
// engine (core/engine.js) stays the default for fast previews; the backend is the
// path to "increased computation power".
//
// Backend URL is configurable at build time via VITE_COMPUTE_URL.
const BASE = (import.meta.env && import.meta.env.VITE_COMPUTE_URL) || 'http://localhost:8000';

export class ComputeClient {
  constructor(base = BASE) { this.base = base; }

  // Returns the backend's health/capabilities object, or null if unreachable.
  async health() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(this.base + '/health', { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  // Offload a projection. Same contract as core/engine.js so it can be swapped in.
  async project(payload) {
    const r = await fetch(this.base + '/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('compute /project failed: ' + r.status);
    return r.json();
  }

  // Convert an uploaded .blend to .glb (requires Blender on the backend PATH).
  async convertBlendToGlb(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(this.base + '/convert/blend-to-glb', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('convert failed: ' + r.status);
    return r.blob();
  }
}

// Client for the RadSim Python compute backend (services/compute).
//
// Heavy work — high-resolution ray-casting, CT acquisition + reconstruction, and
// .blend -> .glb conversion — runs in Python (NumPy / optional GPU) and is called
// from the browser over HTTP (and WebSocket for progress). The interactive JS
// engine (core/engine.js) stays the default for fast previews; the backend is the
// path to "increased computation power".
//
// Backend URL is configurable at build time via VITE_COMPUTE_URL.
// NB: 127.0.0.1, not localhost — on Windows, "localhost" tries IPv6 ::1 first and
// stalls ~2 s per request when uvicorn is listening on IPv4 only.
const BASE = (import.meta.env && import.meta.env.VITE_COMPUTE_URL) || 'http://127.0.0.1:8000';

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

  // POST JSON, receive a raw little-endian float32 array (X-Shape header = dims).
  async _binary(path, payload) {
    const r = await fetch(this.base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('compute ' + path + ' failed: ' + r.status + ' ' + (await r.text()).slice(0, 300));
    return new Float32Array(await r.arrayBuffer());
  }

  // GPU x-ray projection of a voxel phantom -> Float32Array dose map (ny*nx, row-major).
  projectVoxel(payload) { return this._binary('/project/voxel', payload); }

  // GPU CT reconstruction of transverse slices -> Float32Array (nz*N*N).
  ctSlices(payload) { return this._binary('/ct/slices', payload); }

  // GPU CT scout/topogram -> Float32Array (nz*nw) dose map.
  ctScout(payload) { return this._binary('/ct/scout', payload); }

  // Convert an uploaded .blend to .glb (requires Blender on the backend PATH).
  async convertBlendToGlb(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(this.base + '/convert/blend-to-glb', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('convert failed: ' + r.status);
    return r.blob();
  }
}

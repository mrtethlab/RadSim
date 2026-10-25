/* MODEL EDITOR FILM: 8-bit helpers. A slice is drawn on the 8-bit layer as one image (a voxel a
   pixel, or a few), not as thousands of rects; the image is redrawn only when what it shows
   changes. Slices are laid out as they are read: from the feet, the anterior at the top, the
   patient's right on the left (so a volume x is the screen's column nx - 1 - x). */

export class Img {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.cv = document.createElement('canvas'); this.cv.width = w; this.cv.height = h;
    this.g = this.cv.getContext('2d');
    this.im = this.g.createImageData(w, h);
    this.key = null;
  }
  // fill every pixel from f(col, row) -> [r, g, b, a?] (or null: clear), if key changed
  paint(key, f) {
    if (key === this.key) return this;
    this.key = key;
    const d = this.im.data;
    for (let r = 0; r < this.h; r++) for (let c = 0; c < this.w; c++) {
      const v = f(c, r), o = (r * this.w + c) * 4;
      if (!v) { d[o + 3] = 0; continue; }
      d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; d[o + 3] = v[3] ?? 255;
    }
    this.g.putImageData(this.im, 0, 0);
    return this;
  }
  draw(px, x, y, s = 1, a = 1) {
    const g = px.g;
    g.imageSmoothingEnabled = false;
    g.globalAlpha = a * px.alpha;
    g.drawImage(this.cv, Math.round(x), Math.round(y), Math.round(this.w * s), Math.round(this.h * s));
    g.globalAlpha = 1;
  }
}

// a panel's backing: ink, a dark grey frame (the films' look)
export function panel(px, x, y, w, h, a = 0.88) {
  px.rect(x, y, w, h, 'ink', a);
  px.frame(x, y, w, h, 'dkgrey');
}

// mix two [r,g,b] by k
export const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

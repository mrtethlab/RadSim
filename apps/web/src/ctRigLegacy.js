/* ============================================================================
   CT RIG, LEGACY: the first-generation GE Optima / Canon Aquilion gantry, panels and couch
   ============================================================================
   Kept as a backup when ctModel.js replaced it (the higher-fidelity covers, the rotor hidden
   inside the housing behind a translucent bore window). NOT wired up: nothing imports this file.
   The builders are the old ct.js code verbatim, closed over the handles they used to read from
   ct.js's module scope (passed in `env`). To bring it back, call buildLegacyCTRig from ct.js's
   rebuildCTModel and adopt the groups it returns:
     env = { ISO_Y, BORE_R, FRONT_Z, GANT_DEPTH, FLOOR_Y, tableSpec, travelHalfU,
             liveScr, mkScreen, drawTopScreen }
   In this model the tube and detector arc (spin) sat INSIDE the bore throat, beside the patient,
   and were shown only while the gantry turned. */

// The old vendor palettes (vendorLook in ct.js before the rebuild).
export function legacyVendorLook(v) {
  if (v === 'ge') return {
    v: 'ge', cover: 0xf4f6f8, shoulder: 0xb9c4d2, boreRim: 0x8ea3b5, boreRim2: 0xccd6df,
    recess: 0x93a5bf, recessDark: 0x5e7488, panelFloor: 0xccd4dd, boreLiner: 0xeef2f5, trim: 0x9aabc0,
    baseTop: 0x59626e, baseBot: 0x3a424c, plinth: 33,
    panelFace: '#e7ebef', panelEdge: '#c2ccd6', led: '#08160e', ledText: '#57e089',
    btnFace: '#eef2f6', btn: '#3f7cae', screen1: '#0b2c48', screen2: '#124a72',
    brand: 'GE', model: 'Optima', couchTop: 0xeceff2,
    pedStyle: 'ge', pedLight: 0xdfe4e9, pedBase: 0x46525d, pedFoot: 0x232a31, redDot: 0xff4a3d,
  };
  return {
    v: 'canon', cover: 0xf3f1ea, shoulder: 0xe6e3db, boreRim: 0xbcd2e0, boreRim2: 0xe1eaf0,
    recess: 0xcbc7bd, recessDark: 0xb0aca2, panelFloor: 0xe8e4db, boreLiner: 0xf1efe8, trim: 0xe0ddd3,
    baseTop: 0xe0dcd3, baseBot: 0xcbc7bd, plinth: 0,
    panelFace: '#edebe4', panelEdge: '#d6d3c9', led: '#07130d', ledText: '#7fe0a0',
    btnFace: '#f2f0ea', btn: '#8fa9bd', screen1: '#0b2c48', screen2: '#134a74',
    brand: 'Canon', model: 'Aquilion ONE', couchTop: 0xf1efe8,
    pedStyle: 'bellows', pedLight: 0xe6e2d9, pedBase: 0xdedad1, pedFoot: 0xbfbcb2, redDot: 0xff4a3d,
  };
}

export function buildLegacyCTRig(THREE, look, env) {
  const { ISO_Y, BORE_R, FRONT_Z, GANT_DEPTH, FLOOR_Y, tableSpec, travelHalfU, liveScr, mkScreen, drawTopScreen } = env;
  const gantry = new THREE.Group(), couch = new THREE.Group(), couchBase = new THREE.Group();
  let gantrySpin = null, gantryShell = null, boreFrameRing = null;
  const stdMat = (THREE, c, m, r) => new THREE.MeshStandardMaterial({ color: c, metalness: m == null ? 0.1 : m, roughness: r == null ? 0.55 : r });
  function canvasTex(THREE, cv) { const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; return t; }
  function cvRoundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function roundedRectShape(s, w, h, r) { const x = -w / 2, y = -h / 2; s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); }
  // Canvas glyph for the panel START key — the console start symbol (diamond + centre line), green.
  function makeStartGlyphTex(THREE) {
    const Wc = 64, cv = document.createElement('canvas'); cv.width = cv.height = Wc; const g = cv.getContext('2d');
    g.clearRect(0, 0, Wc, Wc); g.strokeStyle = '#2f9e57'; g.lineWidth = 5; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(32, 8); g.lineTo(56, 32); g.lineTo(32, 56); g.lineTo(8, 32); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(32, 8); g.lineTo(32, 56); g.stroke();
    return canvasTex(THREE, cv);
  }
  
  function buildGantry(THREE, look) {
    const std = (c, m, r) => stdMat(THREE, c, m, r);
    // bore-framing ring — AP / Lat planning views only (the Orbit PoV shows the real housing instead)
    boreFrameRing = new THREE.Mesh(new THREE.TorusGeometry(BORE_R + 2, 2, 16, 80), std(look.boreRim, 0.4, 0.5));
    boreFrameRing.position.set(0, ISO_Y, FRONT_Z - 2); gantry.add(boreFrameRing);
    // rotating tube + detector assembly (spins during a scan) — sized to stay inside the bore throat
    gantrySpin = new THREE.Group(); gantrySpin.position.set(0, ISO_Y, FRONT_Z - 9);
    const tubeBlk = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 6), std(0xdfe3e7, 0.4, 0.4));
    tubeBlk.position.set(0, BORE_R - 7, 0); gantrySpin.add(tubeBlk);
    const foc = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 3.4), new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb733, emissiveIntensity: 0.8 }));
    foc.position.set(0, BORE_R - 10.5, 0); gantrySpin.add(foc);
    const detArc = new THREE.Mesh(new THREE.TorusGeometry(BORE_R - 7, 2.4, 8, 44, Math.PI * 0.85), std(0x2b3742, 0.4, 0.5));
    detArc.rotation.z = -Math.PI / 2 - Math.PI * 0.425; gantrySpin.add(detArc);
    gantrySpin.visible = false; gantry.add(gantrySpin);
  
    // ---- exterior housing (Orbit PoV only) — proportioned to the GE Optima reference photo:
    // machine ≈240 wide × 206 tall for the 70-unit bore; white cover with a blue-grey frame border ----
    gantryShell = new THREE.Group(); gantry.add(gantryShell);
    const BEV = 3, FACE_Z = FRONT_Z + BEV;                       // extrude front bevel → the TRUE front-face z
    const halfW = 114, topY = ISO_Y + 100, shoulderY = ISO_Y + 30, holeR = BORE_R + 3;
    const topR = look.v === 'canon' ? 92 : 62;                   // Aquilion crown is much rounder than the Optima
    const flare = look.v === 'canon' ? 16 : 6, botY = FLOOR_Y + (look.plinth || 0);
    const silhouette = (grow) => {                                // rounded-arch outline, offset outward by `grow`
      if (look.v === 'canon') {
        // Aquilion Prime SP, measured from the reference: ONE BIG CIRCLE whose centre sits BELOW
        // the bore centre (≈260 mm), so the bore rides high in the disc, the crown is lower
        // (≈ISO_Y+75) and the floor chord is wide (≈±69) — the photo's stance.
        const R = 101 + grow, cy0 = ISO_Y - 26, b = botY - grow;
        const dyB = b - cy0, xB = Math.sqrt(Math.max(1, R * R - dyB * dyB));
        const a = Math.atan2(dyB, xB);
        const c = new THREE.Shape();
        c.absarc(0, cy0, R, a, Math.PI - a, false);               // CCW over the crown, floor to floor
        c.lineTo(xB, b);                                          // close along the floor
        return c;
      }
      const s = new THREE.Shape();
      const hw = halfW + grow, hf = halfW + flare + grow, t = topY + grow, b = botY - grow, tr = topR;
      s.moveTo(-hf + 12, b);
      s.quadraticCurveTo(-hf, b, -hf, b + 14);
      s.lineTo(-hw, shoulderY);
      s.quadraticCurveTo(-hw, t, -hw + tr, t);
      s.lineTo(hw - tr, t);
      s.quadraticCurveTo(hw, t, hw, shoulderY);
      s.lineTo(hf, b + 14);
      s.quadraticCurveTo(hf, b, hf - 12, b);
      s.lineTo(-hf + 12, b);
      return s;
    };
    const mkBoreHole = (sh) => { const h = new THREE.Path(); h.absarc(0, ISO_Y, holeR, 0, Math.PI * 2, true); sh.holes.push(h); };
    // blue-grey FRAME shell — sits behind the white cover and peeks out around the whole outline (ref)
    const frameShape = silhouette(4); mkBoreHole(frameShape);
    const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: GANT_DEPTH, bevelEnabled: true, bevelThickness: BEV, bevelSize: 2.4, bevelSegments: 7, curveSegments: 240 });
    frameGeo.computeVertexNormals();
    const frameShell = new THREE.Mesh(frameGeo, std(look.trim, 0.08, 0.5));
    frameShell.position.z = FRONT_Z - GANT_DEPTH - 5; gantryShell.add(frameShell);
    // white front cover
    const shape = silhouette(0); mkBoreHole(shape);
    const coverGeo = new THREE.ExtrudeGeometry(shape, { depth: GANT_DEPTH, bevelEnabled: true, bevelThickness: BEV, bevelSize: 2.4, bevelSegments: 9, curveSegments: 240 });
    coverGeo.computeVertexNormals();
    const cover = new THREE.Mesh(coverGeo, std(look.cover, 0.04, 0.45));
    cover.position.z = FRONT_Z - GANT_DEPTH; gantryShell.add(cover);
    // the big WHITE DONUT moulding around the bore — ONE smooth lathe: outer seam → forward bulge →
    // bore throat → back flare that seals the cover hole from behind. The bore itself stays OPEN
    // (you see the couch through it): no grey collar, no cap, and no see-through gaps at any angle.
    // GE: broad moulding. Canon Prime SP: a smaller donut leaving a wide FLAT face annulus between
    // it and the blue ring (where the flush pads sit). The profile is parametric in the annulus
    // thickness A so both proportions come out right; the bulge flattens for thin annuli.
    const DON_R = look.v === 'canon' ? 60 : 76;                  // ref: donut outer ≈ 0.47 of body width
    const A = DON_R - BORE_R, D = Math.min(1, A / 30) * (look.v === 'canon' ? 0.25 : 1);   // canon: a SUBTLE swell (~1.4 u) so the pads sit flush on it
    const prof = new THREE.SplineCurve([
      new THREE.Vector2(DON_R + 2, 1.5), new THREE.Vector2(DON_R - Math.min(6, A * 0.15), -3.2 * D),
      new THREE.Vector2(BORE_R + A * 0.56, -6.8 * D), new THREE.Vector2(BORE_R + A * 0.27, -5.4 * D),
      new THREE.Vector2(BORE_R + A * 0.11, -1.2 * D), new THREE.Vector2(BORE_R + 0.6, 5),
      new THREE.Vector2(BORE_R, 14), new THREE.Vector2(BORE_R, GANT_DEPTH - 10), new THREE.Vector2(holeR + 1.5, GANT_DEPTH - 5),
    ]).getPoints(72);
    const donGeo = new THREE.LatheGeometry(prof, 240); donGeo.computeVertexNormals();
    const donMat = std(look.cover, 0.04, 0.5); donMat.side = THREE.DoubleSide;
    const donut = new THREE.Mesh(donGeo, donMat);
    donut.rotation.x = -Math.PI / 2;                              // profile +y (deeper) → world −z
    donut.position.set(0, ISO_Y, FACE_Z - 1); gantryShell.add(donut);
    // small grey tab at the top of the bore (ref)
    const tab = new THREE.Mesh(roundedBoxGeo(THREE, 16, 4, 3, 2), std(look.trim, 0.12, 0.45));
    tab.position.set(0, ISO_Y + BORE_R + 6, FACE_Z + 1.6); gantryShell.add(tab);
    // Canon / Toshiba Aquilion signature details, laid out to the reference photo: the thin blue
    // ring hugs the donut seam, the tilted control pads ride the donut's upper flanks INSIDE the
    // ring, red stops sit above the pads, and the oval grips sit tangentially on the lower flanks.
    if (look.v === 'canon') {
      const cy0 = ISO_Y - 26;                                    // the BODY circle's centre (below the bore)
      // signature blue ring — concentric with the BODY circle (not the bore), close to the disc's
      // outer edge (R 101), plus the faint tilt-section seam line just inside it
      const accent = new THREE.Mesh(new THREE.TorusGeometry(96, 1.6, 20, 280), std(0xa9c3d9, 0.2, 0.45));
      accent.position.set(0, cy0, FACE_Z + 0.8); gantryShell.add(accent);
      const seam = new THREE.Mesh(new THREE.TorusGeometry(93, 0.35, 8, 280), std(0xc9c6bb, 0.1, 0.6));
      seam.position.set(0, cy0, FACE_Z + 0.35); gantryShell.add(seam);
      // PIVOT PILLARS: narrow stationary towers tucked BEHIND the disc — only a ~15-unit sliver shows
      // beyond the body edge (ref). Front face 3 behind the cover face → a visible shadow seam (the
      // air gap) traces the circle where disc and pillar meet; the disc tilts between them (NYI).
      [-1, 1].forEach(s => {
        // outer edge ≈ the disc's max radius (100 ≤ R 101): in the photo NO pillar shows at the
        // machine's widest point — slivers appear only where the disc curves away (top-sides + floor)
        const pil = new THREE.Mesh(roundedBoxGeo(THREE, 36, 138, GANT_DEPTH + 2, 14), std(0xdedacf, 0.06, 0.5));
        pil.position.set(s * 82, ISO_Y + 38 - 69, FACE_Z - 3 - (GANT_DEPTH + 2) / 2);   // top at ISO_Y+38, foot at the floor
        gantryShell.add(pil);
      });
      const domeG = (r) => { const gg = new THREE.SphereGeometry(r, 28, 18); gg.scale(1, 1, 0.5); return gg; };
      // ONE red emergency-stop dome per side — MEDIAL, flanking the crown module (the screens sit
      // laterally, further out from the bore's midline)
      [-1, 1].forEach(s => {
        const stop = new THREE.Mesh(domeG(1.5), new THREE.MeshStandardMaterial({ color: 0xd23c30, roughness: 0.35 }));
        stop.position.set(s * 18, ISO_Y + 54, FACE_Z + 1.4); gantryShell.add(stop);
      });
      // oval grip mouldings just outside the bore on the mound's inner slope (ref)
      [-1, 1].forEach(s => {
        const dim = new THREE.Mesh(roundedBoxGeo(THREE, 8, 4, 1.4, 1.9), std(look.shoulder, 0.08, 0.55));
        dim.position.set(s * 40, ISO_Y + 4, FACE_Z + 1.4); dim.rotation.z = -s * 0.1; gantryShell.add(dim);
      });
      // dark sensor slit on the bore-top tab (the ref's element below the module)
      const slit = new THREE.Mesh(roundedBoxGeo(THREE, 1.4, 2.6, 1.0, 0.6), std(0x2b2f33, 0.2, 0.6));
      slit.position.set(0, ISO_Y + BORE_R + 6, FACE_Z + 3.2); gantryShell.add(slit);
    }
    // top-centre console module — proud of the cover, flush with the top edge. GE: blue-grey housing
    // with the big UI screen + mini readout. Canon: the reference's narrow WHITE housing with the
    // blue screen on top, the red Canon wordmark beneath it, and a small speaker slot.
    liveScr.top = mkScreen(THREE, 256, 200); drawTopScreen();          // LIVE console screen (both vendors)
    const scrMat = () => new THREE.MeshStandardMaterial({ map: liveScr.top.tex, emissive: 0xffffff, emissiveMap: liveScr.top.tex, emissiveIntensity: 0.9, roughness: 0.3 });
    if (look.v === 'canon') {
      // Small module nested at the crown of the LOW-centred circle (ref: crown ≈ ISO_Y+75), with a
      // wedge fairing behind it so it reads as moulded into the body rather than floating.
      const canonTop = ISO_Y + 75, modW = 22, modH = 26, modY = canonTop - modH / 2 + 1;
      const wedge = new THREE.Mesh(roundedBoxGeo(THREE, 26, 18, 3, 7), std(look.cover, 0.05, 0.45));
      wedge.position.set(0, canonTop - 7, FACE_Z + 0.2); gantryShell.add(wedge);
      const mod = new THREE.Mesh(roundedBoxGeo(THREE, modW, modH, 8, 4.5), std(look.cover, 0.05, 0.45));
      mod.position.set(0, modY, FACE_Z + 0.5); gantryShell.add(mod);
      const scrBez = new THREE.Mesh(roundedBoxGeo(THREE, 18.6, 14.6, 2, 1.4), std(0x27435f, 0.2, 0.4));
      scrBez.position.set(0, modY + 3.5, FACE_Z + 4.4); gantryShell.add(scrBez);
      const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(17, 13), scrMat());
      scrMesh.position.set(0, modY + 3.5, FACE_Z + 5.5); gantryShell.add(scrMesh);
      const cb = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 3.4), new THREE.MeshBasicMaterial({ map: makeTextTex(THREE, 'Canon', '#cc0f2f'), transparent: true }));
      cb.position.set(0, modY - 7.5, FACE_Z + 4.9); gantryShell.add(cb);
      const slot = new THREE.Mesh(roundedBoxGeo(THREE, 6, 0.9, 0.8, 0.4), std(0x8b949c, 0.2, 0.5));
      slot.position.set(0, modY - 11, FACE_Z + 4.8); gantryShell.add(slot);
      // green power LED right of the screen + two small grey icons left of it (ref)
      const domeM = (r) => { const gg = new THREE.SphereGeometry(r, 28, 18); gg.scale(1, 1, 0.5); return gg; };
      const pwr = new THREE.Mesh(domeM(0.9), new THREE.MeshStandardMaterial({ color: 0x69d47a, emissive: 0x3fae52, emissiveIntensity: 0.8 }));
      pwr.position.set(11.5, modY + 4, FACE_Z + 2.2); gantryShell.add(pwr);          // on the wedge, right of the screen
      [2, 6.5].forEach(dy => {
        const ic = new THREE.Mesh(domeM(0.7), std(0x9aa4ad, 0.15, 0.5));
        ic.position.set(-11.5, modY + dy, FACE_Z + 2.1); gantryShell.add(ic);        // small icons left of the screen
      });
    } else {
      const modW = 42, modH = 52, modY = topY - modH / 2 - 1;
      const mod = new THREE.Mesh(roundedBoxGeo(THREE, modW, modH, 12, 6), std(look.recess, 0.1, 0.5));
      mod.position.set(0, modY, FACE_Z + 0.5); gantryShell.add(mod);
      const scrBez = new THREE.Mesh(roundedBoxGeo(THREE, 30, 24, 2.4, 2), std(0x2c353f, 0.2, 0.4));
      scrBez.position.set(0, modY + 8, FACE_Z + 6.2); gantryShell.add(scrBez);
      const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(27, 21), scrMat());
      scrMesh.position.set(0, modY + 8, FACE_Z + 7.5); gantryShell.add(scrMesh);
      const miniTex = makeMiniLedTex(THREE);
      const mini = new THREE.Mesh(new THREE.PlaneGeometry(12, 3.2), new THREE.MeshStandardMaterial({ map: miniTex, emissive: 0xffffff, emissiveMap: miniTex, emissiveIntensity: 0.9, roughness: 0.3 }));
      mini.position.set(0, modY - 10, FACE_Z + 6.8); gantryShell.add(mini);
      const slot = new THREE.Mesh(roundedBoxGeo(THREE, 14, 1.2, 1, 0.5), std(0x5a6672, 0.2, 0.5));
      slot.position.set(0, modY - 15, FACE_Z + 6.6); gantryShell.add(slot);
    }
    // side control panels + patient-indicator pills — mounted ON the true front face (never buried)
    [-1, 1].forEach(s => {
      const panel = buildPanel(THREE, look, s);
      // Aquilion: NO group rotation — the screen and key rows stay level with the floor; the layout
      // inside buildPanel cascades diagonally around the bore (group origin = bore centre)
      if (look.v === 'canon') { panel.position.set(0, ISO_Y, FACE_Z + 0.4); }
      else { panel.position.set(s * 91, ISO_Y + 38, FACE_Z + 0.2); panel.rotation.z = -s * 0.10; }
      gantryShell.add(panel);
      if (look.v === 'ge') {                                      // GE-only patient-indicator pills
        const pill = new THREE.Mesh(roundedBoxGeo(THREE, 8, 4.5, 2, 2), std(0xffffff, 0.03, 0.5));
        pill.position.set(s * 70, ISO_Y + 58, FACE_Z + 0.8); gantryShell.add(pill);
        const picon = new THREE.Mesh(new THREE.CircleGeometry(1.2, 20), new THREE.MeshStandardMaterial({ color: 0xd9838f, emissive: 0xd9838f, emissiveIntensity: 0.4, roughness: 0.4 }));
        picon.position.set(s * 70, ISO_Y + 58, FACE_Z + 2); gantryShell.add(picon);
      }
    });
    // badging: "Optima" wordmark (left) + GE roundel (right); Canon shows its wordmarks instead
    const badge = (tex, w, h, x, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      m.position.set(x, y, FACE_Z + 0.3); gantryShell.add(m);
    };
    if (look.v === 'ge') {
      badge(makeTextTex(THREE, look.model), 28, 10, -72, ISO_Y + 72);
      badge(makeGELogoTex(THREE), 10, 10, 70, ISO_Y + 72);
    } else {
      // two-line "ONE / Aquilion" wordmark on the FLAT face annulus (it previously intersected the
      // donut bulge, which sliced the text — that was the "clipping")
      const wm = new THREE.Mesh(new THREE.PlaneGeometry(20, 10), new THREE.MeshBasicMaterial({ map: makeAquilionTex(THREE), transparent: true }));
      wm.position.set(-31, ISO_Y + 52, FACE_Z + 2.5); gantryShell.add(wm);   // upper-left, fully INSIDE the edge ring (no clipping)
    }
    // dark slate base plinth (full width, slightly stepped — ref)
    if (look.plinth) {
      const p1 = new THREE.Mesh(roundedBoxGeo(THREE, (halfW + flare) * 2 + 18, 18, GANT_DEPTH + 12, 4), std(look.baseBot, 0.2, 0.55));
      p1.position.set(0, FLOOR_Y + 8, FRONT_Z - GANT_DEPTH / 2); gantryShell.add(p1);
      const p2 = new THREE.Mesh(roundedBoxGeo(THREE, (halfW + flare) * 2 + 10, 18, GANT_DEPTH + 6, 4), std(look.baseTop, 0.18, 0.6));
      p2.position.set(0, FLOOR_Y + 24, FRONT_Z - GANT_DEPTH / 2); gantryShell.add(p2);
    }
  }
  
  // A rounded box (no sharp corners) via an extruded rounded-rect with a matching front/back bevel,
  // centred on the origin with total depth d.
  function roundedBoxGeo(THREE, w, h, d, r) {
    const rr = Math.max(0.5, Math.min(r, w / 2 - 0.5, h / 2 - 0.5));
    const s = new THREE.Shape(); roundedRectShape(s, w, h, rr);
    const bt = Math.max(0.2, Math.min(rr * 0.85, d * 0.45));
    const g = new THREE.ExtrudeGeometry(s, { depth: d - bt * 2, bevelEnabled: true, bevelThickness: bt, bevelSize: bt, bevelSegments: 10, curveSegments: 56 });
    g.translate(0, 0, bt - d / 2); g.computeVertexNormals();
    return g;
  }
  // Push a rounded-rect HOLE into a shape (reversed winding), for the recessed panels / display.
  function pushRRHole(THREE, shape, cx, cy, w, h, r) {
    const s = new THREE.Shape(); roundedRectShape(s, w, h, Math.min(r, w / 2 - 0.5, h / 2 - 0.5));
    const pts = s.getPoints(20).map(p => new THREE.Vector2(p.x + cx, p.y + cy)).reverse();
    shape.holes.push(new THREE.Path(pts));
  }
  // One control panel — matches the reference: a white rounded tray on a grey outline plate, two
  // small green readouts along the top, and a ring of small flat BLUE keys below (GE); Canon keeps
  // a green readout + key rows. Surface-mounted on the true front face — nothing buried or cut out.
  function buildPanel(THREE, look, side) {
    side = side || 1;                                              // −1 = left pad, +1 = right (canon mirrors its layout)
    const S = (c, m, r) => stdMat(THREE, c, m, r);
    const gp = new THREE.Group();
    // smooth DOMED keys (squashed spheres half-sunk in the face — no sharp cylinder edges); lit
    // keys (canon's cyan motion buttons) get a soft emissive glow
    const dome = (r) => { const gg = new THREE.SphereGeometry(r, 28, 18); gg.scale(1, 1, 0.5); return gg; };
    const key = (x, y, r, color, glow) => {
      const m = new THREE.Mesh(dome(r), new THREE.MeshStandardMaterial({ color: color || look.btn, metalness: 0.08, roughness: 0.32, emissive: glow || 0x000000, emissiveIntensity: glow ? 0.5 : 0 }));
      m.position.set(x, y, 1.7); gp.add(m);
    };
    if (look.v === 'ge') {
      const back = new THREE.Mesh(roundedBoxGeo(THREE, 25, 29, 2, 7), S(look.shoulder, 0.08, 0.5));
      gp.add(back);                                                 // grey outline plate
      const face = new THREE.Mesh(roundedBoxGeo(THREE, 23, 27, 2.2, 6), S(look.cover, 0.04, 0.5));
      face.position.z = 0.6; gp.add(face);                          // white panel face, front ≈ +1.7
      // LEFT: a physical START key carrying the console start symbol (not a screen)
      const sb = new THREE.Mesh(roundedBoxGeo(THREE, 6.6, 5.6, 1.8, 1.4), S(0xf2f5f7, 0.05, 0.4));
      sb.position.set(-5.6, 8.4, 2.1); gp.add(sb);
      const glyph = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), new THREE.MeshBasicMaterial({ map: makeStartGlyphTex(THREE), transparent: true }));
      glyph.position.set(-5.6, 8.4, 3.1); gp.add(glyph);
      // RIGHT: the LIVE scan / delay countdown timer display
      if (!liveScr.timer) liveScr.timer = mkScreen(THREE, 128, 64);
      const bez = new THREE.Mesh(roundedBoxGeo(THREE, 10.8, 5.8, 1.4, 1), S(0x252b31, 0.2, 0.45));
      bez.position.set(3.8, 8.4, 1.9); gp.add(bez);
      const tt = liveScr.timer.tex;
      const scrn = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 4.6), new THREE.MeshStandardMaterial({ map: tt, emissive: 0xffffff, emissiveMap: tt, emissiveIntensity: 0.9, roughness: 0.3 }));
      scrn.position.set(3.8, 8.4, 2.7); gp.add(scrn);
      const R = 6.4; for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 - Math.PI / 2; key(Math.cos(a) * R, -4.5 + Math.sin(a) * R, 1.15); }
      key(0, -4.5, 1.7);                                            // blue key ring + centre key (ref keypad)
      key(9.2, -1.5, 0.8); key(9.2, -7.5, 0.8);                     // two small side keys
    } else {
      // Canon Aquilion pad — NO plate at all: the screen and keys mount DIRECTLY on the gantry face
      // (perfectly flush, nothing to clip). The screen and every key row stay HORIZONTAL (parallel
      // to the floor); only the CLUSTER cascades diagonally down around the bore rim, hugging its
      // upper corner like the reference. Group origin = bore centre; `side` mirrors the layout.
      const sx = side;
      // each key gets a low collar disc so it reads as mounted on the face (which is gently domed here)
      const kkey = (x, y, r, color, glow) => {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.35, r + 0.55, 1.3, 36), S(0xe8ebee, 0.06, 0.5));
        base.rotation.x = Math.PI / 2; base.position.set(x, y, 0.65); gp.add(base);
        key(x, y, r, color, glow);
      };
      // LIVE 4-line readout — level, LATERAL of the bore's upper corner (the red stops sit medially,
      // flanking the crown module; the bore axis is the midline)
      if (!liveScr.panel) liveScr.panel = mkScreen(THREE, 168, 108);
      const bez = new THREE.Mesh(roundedBoxGeo(THREE, 15, 9.6, 2, 1), S(0x1c2126, 0.2, 0.45));
      bez.position.set(sx * 44, 40, 0.6); gp.add(bez);
      const tt = liveScr.panel.tex;
      const scrn = new THREE.Mesh(new THREE.PlaneGeometry(13.8, 8.6), new THREE.MeshStandardMaterial({ map: tt, emissive: 0xffffff, emissiveMap: tt, emissiveIntensity: 0.9, roughness: 0.3 }));
      scrn.position.set(sx * 44, 40, 1.75); gp.add(scrn);
      const GREY = 0x9aa4ad, WHITE = 0xf0f2f4, BLUE = 0x5aa7dc, GLOW = 0x2f7fc0;
      const K = [
        // grey utility rows BELOW the readout (clear of its bezel), stepping outward down the cascade
        [36.8, 32.5, 1.1, GREY], [40, 32.5, 1.1, GREY], [43.2, 32.5, 1.1, WHITE],
        [40.3, 28.7, 1.1, GREY], [43.5, 28.7, 1.15, BLUE, GLOW], [46.7, 28.7, 1.1, GREY],
        // table-motion cross at the bore's upper corner
        [49, 20.5, 1.35, BLUE, GLOW],
        [45.8, 16.5, 1.1, GREY], [49, 16.5, 1.2, WHITE], [52.2, 16.5, 1.1, GREY],
        [49, 12.5, 1.35, BLUE, GLOW],
        // lit-blue pairs finishing the cascade down the bore's side
        [48.3, 5, 1.25, BLUE, GLOW], [51.7, 5, 1.25, BLUE, GLOW],
        [47.3, 0, 1.25, BLUE, GLOW], [50.7, 0, 1.25, BLUE, GLOW],
      ];
      K.forEach(([x, y, r, c, gl]) => kkey(sx * x, y, r, c, gl));
    }
    return gp;
  }
  // Badge text (Optima / GE / Canon wordmarks) on a transparent plane.
  function makeTextTex(THREE, txt, color) {
    const W = 256, H = 96, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H); g.fillStyle = color || '#6b7788'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'italic bold 60px Arial'; g.fillText(txt, W / 2, H / 2 + 3);
    return canvasTex(THREE, cv);
  }
  // GE-style console UI for the top module screen (numbers row / patient line / soft keys — ref).
  function makeGEUITex(THREE) {
    const W = 256, H = 200, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = '#24313e'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#31414f'; g.fillRect(0, 0, W, 26);
    g.font = 'bold 30px Arial'; g.textAlign = 'left';
    g.fillStyle = '#63e08c'; g.fillText('+', 14, 64); g.fillText('50.0', 40, 64);
    g.fillStyle = '#ffb347'; g.fillText('240.0', 40, 100);
    g.fillStyle = '#ffffff'; g.font = 'bold 24px Arial'; g.textAlign = 'right'; g.fillText('0.0°', W - 14, 64);
    g.textAlign = 'center'; g.font = '18px Arial'; g.fillStyle = '#cfe0ee'; g.fillText('John Smith', W / 2, 132);
    ['OM', 'XY', 'IC'].forEach((t, i) => {
      g.fillStyle = '#8fa3b8'; cvRoundRect(g, 30 + i * 70, 150, 56, 34, 6); g.fill();
      g.fillStyle = '#1d2731'; g.font = 'bold 20px Arial'; g.fillText(t, 58 + i * 70, 173);
    });
    return canvasTex(THREE, cv);
  }
  // Tiny green LED strip (panel mini-readouts + the module's secondary readout).
  function makeMiniLedTex(THREE) {
    const W = 96, H = 40, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = '#0c1810'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#5fe08a'; g.font = 'bold 24px "Courier New", monospace'; g.textAlign = 'right'; g.fillText('0.0', W - 10, 29);
    g.fillRect(8, 12, 10, 16); g.fillStyle = '#0c1810'; g.fillRect(11, 16, 4, 8);   // tiny icon block
    return canvasTex(THREE, cv);
  }
  // Canon's two-line "ONE / Aquilion" wordmark on a transparent plane (sized to fit — never clips).
  function makeAquilionTex(THREE) {
    const W = 256, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H); g.fillStyle = '#6f88ad'; g.textAlign = 'center';
    g.font = 'bold 36px Arial'; g.fillText('ONE', W / 2 + 34, 46);
    g.font = 'italic bold 44px Arial'; g.fillText('Aquilion', W / 2, 96);
    return canvasTex(THREE, cv);
  }
  // GE roundel badge (circle + monogram) on a transparent plane.
  function makeGELogoTex(THREE) {
    const Wc = 128, cv = document.createElement('canvas'); cv.width = cv.height = Wc; const g = cv.getContext('2d');
    g.clearRect(0, 0, Wc, Wc); g.strokeStyle = '#5b7ca6'; g.fillStyle = '#5b7ca6';
    g.lineWidth = 7; g.beginPath(); g.arc(Wc / 2, Wc / 2, 52, 0, Math.PI * 2); g.stroke();
    g.font = 'italic bold 52px Georgia'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('GE', Wc / 2, Wc / 2 + 4);
    return canvasTex(THREE, cv);
  }
  // A recessed emissive screen (real content) inside a rounded 3D bezel.
  function buildScreen(THREE, w, h, tex, bezMat, emiss) {
    const gp = new THREE.Group();
    gp.add(new THREE.Mesh(roundedBoxGeo(THREE, w + 4, h + 4, 2.6, 2), bezMat));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: emiss == null ? 0.8 : emiss, roughness: 0.28, metalness: 0 }));
    scr.position.z = 1.45; gp.add(scr);
    return gp;
  }
  // LED numeric readout content (tilt / height / time), green-on-dark.
  function makeLEDTex(THREE, look) {
    const W = 200, H = 108, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    g.fillStyle = look.led; g.fillRect(0, 0, W, H);
    g.fillStyle = look.ledText; g.textAlign = 'right'; g.font = 'bold 26px "Courier New", monospace';
    ['+0.0', '+50.0', '0.0'].forEach((t, i) => g.fillText(t, W - 30, 32 + i * 30));
    g.textAlign = 'left'; g.font = '13px "Courier New", monospace';
    ['deg', 'mm', 'sec'].forEach((t, i) => g.fillText(t, 12, 32 + i * 30));
    return canvasTex(THREE, cv);
  }
  // Top-centre console screen content: vendor logo + model line on a blue UI.
  function makeTopTex(THREE, look) {
    const W = 256, H = 180, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, look.screen1); grd.addColorStop(1, look.screen2);
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.fillStyle = '#ffffff'; g.font = 'bold 34px Arial'; g.fillText(look.brand, W / 2, 70);
    g.fillStyle = '#cfe6ff'; g.font = 'italic 22px Arial'; g.fillText(look.model, W / 2, 104);
    g.fillStyle = 'rgba(255,255,255,0.22)'; cvRoundRect(g, 44, 128, W - 88, 12, 6); g.fill();
    return canvasTex(THREE, cv);
  }
  
  function buildCouch(THREE, look) {
    const std = (c, m, r) => stdMat(THREE, c, m, r);
    // ---- pallet (moves): white plate, top surface at LOCAL y=0 (patient posterior rests here) ----
    const spec = tableSpec(), palLen = spec.cradleU, palW = spec.cradleWU;   // vendor cradle dimensions
    const ps = new THREE.Shape(); roundedRectShape(ps, palW, 3.4, 1.6);
    const palGeo = new THREE.ExtrudeGeometry(ps, { depth: palLen - 3, bevelEnabled: true, bevelThickness: 1.4, bevelSize: 1.4, bevelSegments: 9, curveSegments: 40 }); palGeo.computeVertexNormals();
    const pallet = new THREE.Mesh(palGeo, std(look.couchTop, 0.1, 0.45));
    pallet.position.set(0, -1.7, -50); couch.add(pallet);                 // rounded ends + edges; cantilevers into the bore
    const chan = new THREE.Mesh(roundedBoxGeo(THREE, palW - 14, 0.9, palLen - 12, 2), std(0xe3e7ea, 0.06, 0.6));
    chan.position.set(0, -0.35, (palLen - 103) / 2); couch.add(chan);   // centred on the pallet
    couch.visible = false;
  
    // ---- static base (Orbit PoV only, positioned in ctSyncScene): the reference's foot-end head
    // module (white wing the pallet slides through + grey handle plate + chrome arch + GE roundel),
    // on a pedestal column and a dark floor base ----
    const foot = FLOOR_Y;
    // Layout derived from the vendor spec: the base slab covers the cradle-foot travel band, and
    // the head module (white wing + grey handle plate + chrome arch + roundel) sits at the FOOT end
    // so at full extension the cradle foot parks exactly inside the module — the cradle can never
    // float unsupported past its holder. (couchBase sits at world z = 82; positions are local.)
    const thU = travelHalfU(), footLocal = palLen - 53;            // pallet local foot z (head fixed at −50)
    const wingZ = footLocal + thU - 90;                            // module centre: foot parks at its far edge
    const zLo = footLocal - thU - 100, zHi = footLocal + thU - 82; // slab span under the foot travel
    const slabLen = zHi - zLo, slabZ = (zLo + zHi) / 2, baseZ = wingZ - 44;
    const wingCol = look.v === 'canon' ? 0xc9c6bf : look.couchTop;   // Aquilion's head module is grey
    const plateCol = look.v === 'canon' ? 0xb2afa8 : look.trim;
    const slab = new THREE.Mesh(roundedBoxGeo(THREE, 50, 8, slabLen, 3), std(look.couchTop, 0.06, 0.55));
    slab.position.set(0, -10, slabZ); couchBase.add(slab);
    const wing = new THREE.Mesh(roundedBoxGeo(THREE, 62, 18, 16, 6), std(wingCol, 0.05, 0.5));
    wing.position.set(0, 1, wingZ); couchBase.add(wing);
    const plate = new THREE.Mesh(roundedBoxGeo(THREE, 44, 11, 13, 4), std(plateCol, 0.12, 0.45));
    plate.position.set(0, 12, wingZ - 1); couchBase.add(plate);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(14, 1.8, 24, 72, Math.PI), std(0xcdd4da, 0.55, 0.28));
    handle.position.set(0, 16, wingZ - 1); couchBase.add(handle);
    if (look.v === 'ge') {
      const lg = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshBasicMaterial({ map: makeGELogoTex(THREE), transparent: true }));
      lg.position.set(0, 12, wingZ + 6.5); couchBase.add(lg);
    }
    if (look.pedStyle === 'bellows') {
      // Canon / Toshiba: accordion bellows column + round foot
      const colTop = -8, colBot = foot + 14, colH = colTop - colBot, n = 10;
      const core = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, colH, 48), std(look.pedLight, 0.12, 0.55));
      core.position.set(0, (colTop + colBot) / 2, baseZ); couchBase.add(core);
      for (let i = 0; i < n; i++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(10.6, 2.6, 32, 72), std(look.pedLight, 0.1, 0.6));
        rib.rotation.x = Math.PI / 2; rib.position.set(0, colBot + (i + 0.5) * colH / n, baseZ); couchBase.add(rib);
      }
      const base = new THREE.Mesh(new THREE.CylinderGeometry(17, 20, 8, 56), std(look.pedFoot, 0.18, 0.55));
      base.position.set(0, foot + 6, baseZ); couchBase.add(base);
      // floor rails either side of the base (Aquilion reference)
      [-1, 1].forEach(s => {
        const rail = new THREE.Mesh(roundedBoxGeo(THREE, 6, 4, 70, 2), std(look.pedFoot, 0.15, 0.55));
        rail.position.set(s * 26, foot + 2, baseZ); couchBase.add(rail);
      });
    } else {
      // GE: white pedestal box on a dark slate base with a light front cap (ref)
      const col = new THREE.Mesh(roundedBoxGeo(THREE, 34, 70, 60, 6), std(look.pedLight, 0.08, 0.5));
      col.position.set(0, -42, baseZ); couchBase.add(col);
      const base = new THREE.Mesh(roundedBoxGeo(THREE, 50, 18, 84, 6), std(look.pedFoot, 0.2, 0.5));
      base.position.set(0, foot + 9, baseZ); couchBase.add(base);
      const cap = new THREE.Mesh(roundedBoxGeo(THREE, 26, 13, 5, 4), std(0x9aa4ad, 0.15, 0.5));
      cap.position.set(0, foot + 10, wingZ); couchBase.add(cap);
    }
    couchBase.visible = false;
  }

  buildGantry(THREE, look); buildCouch(THREE, look);
  return { gantry, couch, couchBase, spin: gantrySpin, shell: gantryShell, ring: boreFrameRing };
}

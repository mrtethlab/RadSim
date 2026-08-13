/* ============================================================================
   MOBILE PAGER
   Same program, different layout (docs/mobile-view.md). Everything here keys off ONE flag,
   body.mobile, set from a media query — the CSS re-hangs the three desktop columns as
   pages behind a bottom tab bar, and this module does the handful of things CSS cannot:
   switch pages, move the exposure controls into a thumb-reach dock, keep the tab bar in
   step with the mode, and tell the tutorial which page a target lives on.

   Desktop is untouched: with body.mobile absent, every rule and every element this module
   owns is inert, and the dock contents sit in their original console positions.
   ============================================================================ */

const MQ = '(max-width: 820px), ((pointer: coarse) and (max-width: 1024px))';

// page name -> the element that becomes that page. conGen/conView are the two halves of
// the desktop console column, wrapped in index.html for exactly this purpose.
const PAGES = { bay: '.bay', setup: '.app > .col:not(#consoleCol)', console: '#conGen', image: '#conView' };

let ctx = null;
let active = 'bay';

const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const isMobile = () => document.body.classList.contains('mobile');

/* Which pager page an element lives on, or null (fixed overlays, home screen). */
export function mobilePageFor(el) {
  if (!el || !el.closest) return null;
  for (const [name, sel] of Object.entries(PAGES)) {
    const page = q(sel);
    if (page && (el === page || page.contains(el))) return name;
  }
  return null;
}

/* Bring an element's page to the front (tutorial targets, mostly). No-op on desktop. */
export function mobileShowPageFor(el) {
  if (!isMobile()) return;
  const page = mobilePageFor(el);
  if (page && page !== active) setPage(page);
}

function setPage(name) {
  active = name;
  for (const [n, sel] of Object.entries(PAGES)) {
    q(sel)?.classList.toggle('mpage-on', n === name);
  }
  document.querySelectorAll('#mtabs button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mpage === name));
  // the bay page owns the live 3D viewport; leaving it pauses the render loop (app.js
  // checks mpage-on), returning needs one resize in case the viewport changed
  window.dispatchEvent(new Event('resize'));
}

/* The exposure controls belong under the thumb on every page, so the REAL button blocks —
   listeners and all — are reparented into the dock rather than duplicated. Their original
   slots are remembered so leaving mobile puts them back exactly where they were. */
const docked = [];   // {el, home, next}
function dockControls() {
  const dock = $('mdock');
  if (!dock) return;
  const want = [];
  const mode = document.body.classList.contains('mode-ct') ? 'ct'
    : document.body.classList.contains('mode-xray') ? 'xray'
    : document.body.classList.contains('mode-fluoro') ? 'fluoro' : null;
  if (mode === 'xray') {
    const b = q('#consoleCol .btns2');            // ROTOR + EXPOSE
    if (b) want.push(b);
  } else if (mode === 'fluoro') {
    const b = q('#flPedalRow');                   // the pedal lives under the thumb
    if (b) want.push(b);
  } else if (mode === 'ct') {
    const b = q('#ctConsole .ctbtns');            // MOVE TO SCAN / START / STOP row
    if (b) want.push(b);
  }
  // put back anything docked that is no longer wanted (mode switch, or leaving mobile)
  for (let i = docked.length - 1; i >= 0; i--) {
    const d = docked[i];
    if (isMobile() && want.includes(d.el)) continue;
    d.home.insertBefore(d.el, d.next);
    docked.splice(i, 1);
  }
  if (!isMobile()) return;
  for (const el of want) {
    if (docked.some((d) => d.el === el)) continue;
    docked.push({ el, home: el.parentNode, next: el.nextSibling });
    dock.appendChild(el);
  }
  dock.classList.toggle('has', dock.children.length > 0);
}

/* Re-evaluate everything that depends on (mobile x mode): tab bar visibility, which page
   is showing, what sits in the dock. Called on the media query, on every mode switch, and
   once at boot. */
function sync() {
  const inMode = document.body.classList.contains('mode-xray')
    || document.body.classList.contains('mode-ct')
    || document.body.classList.contains('mode-fluoro');
  const show = isMobile() && inMode;
  $('mtabs')?.classList.toggle('show', show);
  if (show) setPage(active === 'editor' ? 'bay' : active);
  else document.querySelectorAll('.mpage-on').forEach((el) => el.classList.remove('mpage-on'));
  dockControls();
}

export function initMobile(context) {
  ctx = context;
  const mm = window.matchMedia(MQ);
  const apply = () => {
    document.body.classList.toggle('mobile', mm.matches);
    if (mm.matches) active = 'bay';    // entering mobile always lands on the room
    sync();
  };
  mm.addEventListener('change', apply);
  document.querySelectorAll('#mtabs button').forEach((b) =>
    b.addEventListener('click', () => setPage(b.dataset.mpage)));
  // the mode classes are owned by ct.js applyMode; watching them here keeps that file's
  // involvement to nothing at all
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  apply();
  // the tutorial needs these without importing us (avoids a cycle)
  window.__mobilePageFor = mobileShowPageFor;
}

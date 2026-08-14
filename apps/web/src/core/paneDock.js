/* ============================================================================
   CONSOLE DOCKING — where the monitor sits while a live mode is running

   X-ray and CT are shoot-then-look: the image belongs at the far right, after the
   setup. Fluoro and ultrasound are look-while-you-work, and the operator watches the
   monitor beside the room, not at the edge of the screen. So both pull the IMAGE /
   VIEWER pane one column left, to the top of the POSITION / SETUP column, and bring
   their exposure control (the pedal, the freeze) directly under it.

   The DOM home is remembered on first dock and restored on undock, so the panes go
   back exactly where the other modes expect to find them. Mobile is excluded: the
   pager there expects the viewer to stay a page of its own.
   ============================================================================ */
const rowHomes = new WeakMap();
let viewHome = null;
/* Which mode currently holds the docked viewer. Every mode is told on EVERY switch —
   fluoro(false), mammo(false), us(true) — so without this the outgoing modes' off-calls
   undock the pane the incoming one has just docked, and the monitor vanishes back to the
   far column. The row element is the mode's identity. */
let owner = null;

export function dockConsole(on, rowEl) {
  const conView = document.getElementById('conView');
  const setupPad = document.getElementById('setupPad');
  if (!conView || !setupPad || document.body.classList.contains('mobile')) return;
  if (on) owner = rowEl;
  if (on) {
    if (conView.parentElement !== setupPad) {
      viewHome = viewHome || { parent: conView.parentElement, next: conView.nextElementSibling };
      setupPad.insertBefore(conView, setupPad.firstChild);
    }
    if (rowEl && rowEl.parentElement !== setupPad) {
      if (!rowHomes.has(rowEl)) rowHomes.set(rowEl, { parent: rowEl.parentElement, next: rowEl.nextElementSibling });
      setupPad.insertBefore(rowEl, conView.nextElementSibling);
    }
  } else {
    // a mode always takes its OWN row home, even when another mode has already claimed
    // the viewer — otherwise the outgoing row is orphaned in the incoming mode's column
    if (rowEl && rowHomes.has(rowEl) && rowEl.parentElement === setupPad) {
      const h = rowHomes.get(rowEl);
      h.parent.insertBefore(rowEl, h.next);
    }
    if (owner && owner !== rowEl) return;           // the viewer is not yours to undock
    owner = null;
    if (viewHome && conView.parentElement === setupPad) viewHome.parent.insertBefore(conView, viewHome.next);
  }
}

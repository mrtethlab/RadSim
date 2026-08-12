# Mobile view — plan

Same program, different layout. One codebase, one deploy: the phone gets a layout built for
a thumb and a 6-inch screen, not a shrunken copy of the three-column console. Nothing about
the physics, the state model, or the mode logic changes — this is a presentation-layer
project with a handful of behavioural switches.

Status: **planning**. Nothing in this document is implemented yet.

---

## 1. What a phone sees today (measured, 375x812, DPR 2)

Audited on the dev build with the browser's mobile preset. The existing
`@media (max-width:1180px)` fallback linearises the grid into one scrolling column, which
is why nothing overflows horizontally — but linear is not mobile:

| Finding | Measurement | Severity |
| --- | --- | --- |
| The bay grows unbounded | `.bay` renders **375 x 4139 px**; the canvas backing store hits 750 x 8278. First screen in x-ray mode is black — the 3D view is lost inside a 5-viewport-tall panel | blocker |
| The page is a cliff | bay 4139 + position column 2039 + console column 1758 = **~8 km of scroll** to reach EXPOSE | blocker |
| Touch targets | **56 of 90** interactive elements are under 40 px tall (Apple/Android floor is 44/48) | major |
| Home screen | already stacks cleanly — cards, tutorials, badges all usable untouched | fine |
| Flyout tabs (CONTRAST / BARIUM) | reachable at x=0, but the 356 px panel + 31 px tab leaves 0 px of bay visible when open | major |
| Model payloads | 12–40 MB per subject over cellular (CAP 12.3, chest 40.3); hires models 250–316 MB | major |
| Text | 8–11 px monospace labels everywhere — below phone legibility | major |

Root cause of the bay blow-up: under `grid-auto-rows:min-content` the bay's height is set by
its content, the canvas fills the bay (`inset:0`), and the resize handler writes the read
height back into the canvas — a feedback loop that only a fixed row height breaks.

## 2. Approach

**CSS-first responsive re-layout with a small JS shim — no fork, no second app.**

- One breakpoint class, `body.mobile`, set on load and on resize from
  `matchMedia('(max-width: 820px), (pointer: coarse) and (max-width: 1024px)')`. CSS keys off
  it; the few JS behaviour differences key off the same flag. (The pure media query is not
  enough because three.js sizing and the tutorial need to *know*.)
- Desktop layout is untouched above the breakpoint — every selector the mobile stylesheet
  adds lives under `body.mobile`.

### The layout: pager, not scroll

The desktop's three columns become **pages behind a bottom tab bar**, one visible at a time,
each exactly one viewport tall (`100dvh` minus the bar, `env(safe-area-inset-*)` respected):

```
+----------------------------------+
|                                  |
|            active page           |
|   BAY | POSITION | CONSOLE | IMG |
|                                  |
+----------------------------------+
|  [Bay]  [Setup]  [Console]  [Image]   <- bottom tab bar, 56 px
+----------------------------------+
```

- **Bay**: the 3D room, full-viewport (fixes the 4139 px bay by giving it a real height).
  Orbit/zoom via touch — three.js OrbitControls already handles touch; verify pinch-zoom
  doesn't fight browser zoom (`touch-action: none` on the canvas).
- **Setup**: the POSITION/SETUP column as-is, scrolling within its page.
- **Console**: generator (x-ray) / CT console, scrolling. The EXPOSE / START controls also
  get a **persistent mini-bar** docked above the tab bar on every page, because "position on
  one page, expose from another" must not require a page switch mid-exam.
- **Image**: the viewer + history strip + histogram.

CT mode maps the same way (Planning view lives on the Bay page's content switcher, as it
does on desktop). Editor mode is **desktop-only in v1** — slice painting wants a stylus and
screen estate; its card says so on mobile rather than opening a broken page.

### Flyouts become bottom sheets

CONTRAST and BARIUM panels (356 px left flyouts) become bottom sheets: tab chips docked
above the tab bar, sheet slides up to 85 dvh with a drag handle, bay visible behind. The
`syncFlyouts` rail logic is desktop-only.

### Touch and legibility passes

- Under `body.mobile`: control rows min-height 44 px, steppers 44x44, range thumbs 28 px,
  base font scale +2 px on the 8–11 px labels, `.grp` padding widened.
- Sliders: keep native `input[type=range]` (touch-friendly already); the ± steppers matter
  more on phones, so every slider keeps/gains stepper buttons.
- The injector keypad and protocol/APR popup become full-width sheets.
- Hover-only affordances (tooltips, `:hover` reveals) get visible equivalents or are
  dropped on mobile.

### Tutorials on mobile

The four-panel mask + ring already works on rects; what breaks is the *card* (340 px fixed,
positioned beside the target). Mobile: card docks to the bottom of the screen, full-width,
and the engine auto-switches to the page containing the step's target before painting
(`before` hooks get a `goPage(page)` helper). Goals unchanged.

### Performance and payload

- **Renderer**: cap `setPixelRatio(min(devicePixelRatio, 1.5))` on mobile; pause the rAF
  loop when the Bay page is not the active page.
- **Detector resolution**: Quick (320x400) is the mobile default and Low the ceiling —
  the 2500x3070 "std" DR matrix is a ~30 s raycast on a phone CPU and tens of MB of
  Float32Arrays. The resolution buttons above the ceiling grey out with a note.
- **Models**: keep the default subject the hand (20 MB); add a one-time size warning
  before first download of a >25 MB subject on a metered/cellular connection
  (`navigator.connection.effectiveType` where available). GPU-backend subjects
  (hand_hires, shoulder) already require the Python service and stay desktop-tier.
- **CT recon** on a phone CPU: works (it's the same JS), but slice count x DFOV matrix
  should default down one notch on mobile. Measure first; don't pre-tune.
- **Memory**: one voxel volume resident at a time on mobile — evict `S.voxelCache` entries
  other than the active subject (desktop keeps the cache).

## 3. What does NOT change

- `S` state model, physics, solvers, compute client, model formats, tutorials' content.
- Desktop layout above the breakpoint — pixel-identical.
- The Python backend story (phones just won't have one running; the browser engine and the
  preset timelines already cover that — the same graceful degradation the desktop has).

## 4. Phases

| Phase | Scope | Exit test |
| --- | --- | --- |
| **A — beachhead** | `body.mobile` flag; bay height fix (the 4139 px bug is worth fixing for narrow DESKTOP windows too); bottom tab bar + four pages for x-ray mode; renderer DPR cap + pause | position the hand, expose, view the image, all by touch at 375x812 |
| **B — controls pass** | 44 px touch targets, font scale, steppers everywhere, keypad/protocol sheets, persistent expose mini-bar | full APR chest exam without zooming or mis-taps |
| **C — CT** | console/table/planning mapped onto the pager; scan + recon + viewer by touch | scout -> plan -> scan -> read recons on the phone |
| **D — sheets** | contrast + barium panels as bottom sheets; live study usable | run a barium study and a timed injection by touch |
| **E — tutorials** | docked card + page auto-switching; all four tutorials pass on mobile | every goal achievable at 375x812 |
| **F — hardening** | payload warnings, cache eviction, orientation change, safe-area, real-device matrix (iOS Safari, Android Chrome) | no blocker on either platform |

Phase A is the proof of concept and the decision gate: if the pager feels wrong on a real
phone, the cost sunk is one layout, not six.

## 5. Open questions

1. **Landscape phones**: pager too, or allow a two-pane bay+controls split? (Proposed:
   pager everywhere in v1; revisit after real-device use.)
2. **Editor on tablets**: the 820 px breakpoint puts small tablets on mobile layout, where
   the editor is disabled. Acceptable for v1, or should the editor gate on width
   independently?
3. **Barium/fluoro on mobile** is arguably the killer demo (turn the *phone* — should the
   device's own orientation sensor drive the patient pose as an option?). Out of scope for
   v1 but the API (`giSetPose`) is ready for it.

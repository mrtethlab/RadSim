# Guided tutorials

Each mode card on the welcome screen carries a **Tutorial** button. It opens the real mode and
walks the learner through it control by control: the control is isolated, a blurb explains what
it does, and — where it makes sense — a goal asks them to actually use it.

Engine in `apps/web/src/tutorial.js`, content in `apps/web/src/tutorial-content.js`.

## Why it is built this way

**The highlighted control stays live.** The dimming is four panels laid *around* the target
rather than one sheet with a hole punched in it, so nothing at all covers the control and it
behaves exactly as it does outside the tutorial. A tour you can only watch teaches very little;
the goals only work because the control is genuinely usable while it is lit.

The panels swallow clicks, which is what makes the isolation more than cosmetic — you cannot
wander off mid-step. A step can opt out with `block: false` where the interaction needs a wider
region (dragging a scan box across a scout, painting a slice).

**Every step is skippable.** A goal is how the step would *like* to end, not a gate: NEXT always
advances. Some controls have no sensible goal at all — the compute engine, the vendor theme, the
EI/DI readout — and are explanation-only. They still get the full blurb, which was the point of
including them.

**The blurb sits beside the control**, preferring left/right (the settings columns are tall and
narrow) and falling back to above/below, clamped to the viewport. Read the text, look 2 cm
across, there is the thing it is describing.

## Step shape

```js
{
  sel:    '#kv',                       // control to isolate
  title:  'kV — beam quality',
  text:   '…',                         // HTML allowed
  goal:   { label, done(arm), arm },   // omit for explanation-only
  needs:  '…',                         // shown if the control is not on screen yet
  before: async () => {…},             // open a drawer, switch a view
  block:  false,                       // leave the page clickable
}
```

`arm()` snapshots the starting value and `done(arm)` compares against it. Without that, a goal
like "change the kV" would tick green before the learner touched anything, because the state
already has *a* kV. Goals are **polled** at 220 ms rather than event-driven: the state they watch
is mutated from a dozen places that do not all emit events.

Two timing details that are load-bearing:

* `before` runs after a `setTimeout(0)`. The bay drop-downs close themselves on any document
  click, so a `before` that opens one during the same dispatch as the NEXT click gets shut again
  the moment the event reaches the document.
* The target rect is re-measured at 260 ms and 700 ms after the step opens, and again on every
  poll. Panels that slide, tables that re-render and scan boxes that size themselves lazily all
  measure zero for a frame or two.

## Coverage

| Mode | Steps | Ends on |
| --- | --- | --- |
| X-ray | 19 | image history — change one variable, expose again, compare |
| CT | 25 | vendor interface |
| Model editor | 8 | saving a model back as a subject |

CT steps 8–15 and 22–23 point at controls that do not exist until an earlier goal has been met
(no scouts, no scan-group table; no scan, no slice viewer). Skipping ahead shows the step's
`needs` line rather than a blank ring.

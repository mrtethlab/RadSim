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

**A popup takes over as the lit region.** Several goals can only be met inside one — the
protocol chooser, the value/station entry, the injector keypad, the bolus-tracking window. While
one is open the mask reshapes around *it* rather than around the control that opened it, so the
dimming carries on doing its job and the popup is fully usable. Without this the protocol step
was unfinishable: the chooser opened behind the mask.

**Every step is skippable, and every goal is achievable.** A goal is how the step would *like*
to end, not a gate: NEXT always advances. Some controls have no sensible goal at all — the
compute engine, the vendor theme, the EI/DI readout — and are explanation-only. They still get
the full blurb, which was the point of including them.

Some goals are *conditionally* achievable, and those declare `when` / `unless`. The injector
protocol and the patient sliders only move when the haemodynamic solver is running, so on the
browser engine those two steps drop their goal and explain the fixed preset instead of asking
for a change the UI will refuse. They gate on `S.computeInfo` — the `/health` result — not on
`contrast.static`, which only flips once the preset timeline has actually loaded and so still
read "live" at the moment the step opened. The condition is re-checked on every poll, so
starting the compute service mid-step turns the goal back on.

**The blurb sits beside the control**, preferring left/right (the settings columns are tall and
narrow) and falling back to above/below, clamped to the viewport. Read the text, look 2 cm
across, there is the thing it is describing.

## Step shape

```js
{
  sel:    ['#kv', '.row:has(#kvSv)'],  // control(s) to isolate — several are lit as one region
  title:  'kV — beam quality',
  text:   '…',                         // HTML allowed
  goal:   { label, done(arm), arm, when?, unless? },  // omit for explanation-only
  needs:  '…',                         // shown if the control is not on screen yet
  before: async () => {…},             // open a drawer, switch a view
  block:  false,                       // leave the page clickable
}
```

`sel` takes an array when the control is really several elements — a slider plus its −/+
steppers, the rotor beside EXPOSE. Lighting only the slider left the steppers dark *and* behind
the mask, so the obvious way to change the number was unclickable.

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

## Keys

Escape exits — **unless a popup is open**, where it belongs to the popup as its cancel key.
Stealing it would quit the whole tutorial from a routine cancel. Left/Right step back and
forward, but not while an input or slider has focus (arrows nudge a range input) and not while a
popup is open.

## Verified

Every goal was driven to completion in the browser, not just inspected:

| | goals | result |
| --- | --- | --- |
| X-ray | 14 | all met |
| CT | 10 | all met; 2 more correctly gated with no compute service |
| Model editor | 4 | all met |

The audit also hit-tests each lit region: for every step with a goal, at least one interactive
control inside the ring must return itself from `elementFromPoint`, i.e. a real click reaches it
rather than landing on a mask panel.

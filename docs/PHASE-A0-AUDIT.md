# Phase A0 status audit

Produced after the §8.1 v1.3 render acceptance passed. Verdicts are from running ops
against the engine (never from inspecting panel images), per spec §9.3.

## Golden #8 verdict (§9.3 item 8 — interior-anchored diagonal / frog-leg analog)

Construction (all v1): unit square → `FOLD ALL (½,1)–(0,½)` top-left corner **in**, V →
mirror `FOLD ALL (½,1)–(1,½)` top-right corner **in**, V. House silhouette = unit square,
apex flaps meet at `C=(½,½)`. **6 faces, 4 spots, checker ✅ (I1–I6).**

Leg fold along the line `y = x` (through `C` and corner `(0,0)`):

| Op | Result | Notes |
|---|---|---|
| `FOLD ALL`, movingSide below-right of `y=x`, V | **SUCCEEDS** — 10 faces, checker ✅ | split-at-axis splits every crossed face incl. the straddling flap; CREASE promotion only on mover/static boundaries |
| `FOLD ONE_LAYER` (default top-seed) along `y=x`, V | **SUCCEEDS — ALL-equivalent** (10 faces) | closure grows through the off-axis top edge into the flap structure ⇒ moving set equals the ALL fold; **no `E_TEAR`** |

**Verdict: ALL-equivalent closure (no `E_TEAR`, no blocking witness).** This is one of the
two spec-anticipated outcomes for item 8. Reaching the *real* frog state additionally needs
`WATERBOMB_COLLAPSE` (§11, gated) — out of scope.

> Not yet frozen as a committed core golden test; the construction + verdict above are
> reproducible from `initialSquare()` and belong in `test/` as golden #8 (see gaps).

## §4.4 canonical operation grammar

**NOT DONE.** The engine consumes internal `Op` objects
(`{ type, mode, axis:{a:Vec2,b:Vec2}, movingSide:'left'|'right', direction, seedFaceIds? }`).
The frozen v1 wire format — `{ "v":1, "axis":{ "kind":"through_points"|"candidate_ref", … },
"movingSide": <sign of cross(b−a,p−a)>, … }` with a single parser/validator and rational
`"n/d"` coordinates — is not implemented (grep: no `through_points` / `candidate_ref` /
`"v":1`). No round-trip `op → JSON → op` test. Gap for the VLM/search adapter.

## M5 exit items (§10 M5)

| Item | Status | Evidence (test / source) |
|---|---|---|
| Π(S) SVG snapshots stable | **DONE** | `render2d/svg.ts`; `test/render_io.test.ts` › "render2d Π(S) SVG (M5)" — deterministic SVG string, initial-square single face, xray hidden creases |
| FOLD import/export round-trip | **DONE** | `io/fold.ts` (`toFold`/`foldStacks`); `test/render_io.test.ts` › "FOLD import/export round-trip (M5, §4.3)" — field-length/CCW, stacks survive faceOrders round-trip, deep 8-layer rolling fold |
| `faceOrders` verification | **PARTIAL** | `toFold` emits `faceOrders [f,g,s]` with documented sign (`s=+1 ⇔ f above g`); internal round-trip tested. External-tool confirmation of the sign convention = §9.4 (below) |
| §9.4 cross-tool check (Flat-Folder / Origami Simulator) | **NOT DONE** | procedure documented in `README.md` §9.4; no recorded external run |
| Golden #6 Rabbit (8-panel, JSON+SVG per step) | **NOT DONE** | no rabbit demo/test (grep: none) |

## Summary of open gaps
1. Golden #8 as a committed core test (verdict above is reproducible but not yet in `test/`).
2. §4.4 canonical op JSON grammar + parser/validator + round-trip test.
3. §9.4 cross-tool layer-order confirmation (external, record once).
4. Golden #6 Rabbit end-to-end (8 panels, per-step JSON + Π(S)).

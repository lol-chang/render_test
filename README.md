# Origami Folding Engine

A simulator of **flat-folded origami states with provable layer ordering**. The engine
consumes discrete fold operations and maintains, at every step, a *provably valid* folded
state — face geometry, front/back orientation, and the stacking order of overlapping paper
layers — or fails with a machine-readable reason. Correctness is the point: it is the
verification core of a research pipeline (diagram → proposed op → engine → validity).

## Status

**Feature-complete (M0–M7).** Exact headless engine + verification core, 2D diagram
renderer, FOLD interop, and an interactive three.js simulator. 106 core tests green.

| Milestone | What | State |
|---|---|---|
| M0 | Exact rational geometry kernel (`Rat`, `Vec2`, `Line`, `Iso`, `Poly`, hashing) | ✅ |
| M1 | Immutable state, split-at-axis, CONF normalization, serialization | ✅ |
| M2 | `FOLD ALL`, `FLIP`, `UNFOLD_LAST`, checker I1–I3 | ✅ |
| M3 | `FOLD ONE_LAYER` (moving-set closure, P1 tear / P2 extractability) | ✅ |
| M4 | Full checker I4–I6, `PRECREASE`, crafted-violation goldens | ✅ |
| M5 | `render2d` top-view SVG Π(S), FOLD import/export + round-trip | ✅ |
| M6 | Viewer static build: z-offsets, front/back materials, ortho top view, history strip | ✅ |
| M7 | Fold animation + interaction: candidate-axis picking, green/red dry-run preview | ✅ |

## Guarantees

- **G1 Closure** — a valid op on a valid state yields a valid state (checked after every
  apply) or a typed error, never a corrupt state.
- **G2 Determinism** — same state + same op ⇒ byte-identical serialization. All core
  geometry is exact rational arithmetic over `bigint`; there are **no epsilons** anywhere.
- **G3 Checkability** — an independent checker (`checkState`) validates any state against
  all six invariants (I1–I6), recomputing spots/overlaps from raw polygons + transforms so
  it can catch op bugs.

## Design highlights

- **Layer model.** Instead of per-face integers, the state keeps one global layer order (a
  linear extension of the per-spot stacks). Per-spot stacks are filtered views, so a split
  child trivially inherits its parent's slot, and the fold "reversal rule" is a list op.
- **Side from parity.** Front/back is derived as `det(T) = ±1`, never stored — so it can
  never disagree with the geometry.
- **CONF (Congruent-Overlap Normal Form).** Any two folded faces are kept either identical
  or interior-disjoint, via exact mutual edge-line clipping, so overlapping layers are
  always comparable.
- **Intrinsic vs. view-relative creases.** Fold direction is specified in the current view;
  the stored crease assignment is intrinsic to the front of the sheet (converted via the
  local parity) and survives flips and CONF re-splits (matched by containment).

## Layout

```
packages/core/                 # PURE TypeScript — no three.js, no DOM
  src/geom/     Rat, Vec2, Line, Iso, Poly, canonical hash        (M0)
  src/state/    Face, Edge, Spot, FoldedState, serialization      (M1)
  src/ops/      split/CONF, fold ALL/ONE_LAYER, flip, precrease,
                unfold, plan (for animation), axis candidates     (M1–M4, M7)
  src/check/    independent invariant checker I1–I6               (M2, M4)
  src/render2d/ top-view SVG projection Π(S)                      (M5)
  src/io/       FOLD-format import/export                         (M5)
  test/         unit + property + crafted-violation + goldens
packages/viewer/               # three.js + Vite app (depends on core)
  src/build3d   state → meshes, z-offsets, front/back, hinge walls
  src/animate   fold animation about the hinge
  src/main      camera, history strip, picking, interactive fold
```

## Running

```sh
npm install

# engine: 106 tests + strict typecheck
npm --workspace @origami/core run test
npm --workspace @origami/core run typecheck

# simulator (opens http://localhost:5173)
npm --workspace @origami/viewer run dev
```

## Demo script (the v1 "done" walkthrough)

1. `npm --workspace @origami/viewer run dev` → open http://localhost:5173.
2. Pick **Half / half again** and press **Next ▶** — watch each layer rotate about the
   hinge, then snap to the verified state. The panel shows **✅ valid (I1–I6)** live.
3. Toggle **Explode** to see the layer stack joined by red fold-spines; **Top** gives the
   orthographic diagram view. Click a **history thumbnail** to time-travel.
4. Pick **Traditional cup** → **Next** through the diagonal, corner, and ONE_LAYER
   front-flap fold.
5. Switch to **🖐 Interactive**: hover a face to read its layer depth; click a face, choose
   an **axis candidate** + mode/direction/side. The dry-run turns **green** (movers
   highlighted) when valid and **red** (with the blocking witness) when not — e.g. try to
   valley-fold a buried layer and see `E_BLOCKED`. Press **Apply fold** to commit.

## Cross-tool check (§9.4)

`toFold(state)` exports the flat-folded state (2D `vertices_coords` + `faces_vertices` +
`edges_assignment` + `faceOrders`, faces CCW so `faceOrders` `s=+1` ⇔ f above g). Procedure
to validate our layer order against reference tools:

1. Export a final state: `writeFileSync('model.fold', JSON.stringify(toFold(state)))`.
2. Load `model.fold` in **Flat-Folder** (origami.dev/flat-folder) or **Origami Simulator**
   (origamisimulator.org).
3. Confirm the layer order we produced is among the valid orders they report. `foldStacks`
   reads their FOLD back into per-region stacks for a direct comparison; the round-trip is
   covered by `test/render_io.test.ts`.

### Worked example (Appendix A golden)

`FOLD ALL x=½ (right, V)` then `FOLD ALL y=½ (top, V)` on the unit square yields one spot,
four layers, bottom→top `[left-bottom, right-bottom, right-top, left-top]` — the classic
half/half-again layer reversal, asserted exactly in `test/fold.test.ts`.

The crafted negative suite (`test/checker.test.ts`) feeds hand-built interleaved tacos,
trapped tortillas, and inconsistent cross-boundary orders directly to the checker to prove
I4/I5/I6 each fire with a witness — independent of how a state was produced.

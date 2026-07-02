# Origami Folding Engine

A simulator of **flat-folded origami states with provable layer ordering**. The engine
consumes discrete fold operations and maintains, at every step, a *provably valid* folded
state — face geometry, front/back orientation, and the stacking order of overlapping paper
layers — or fails with a machine-readable reason. Correctness is the point: it is the
verification core of a research pipeline (diagram → proposed op → engine → validity).

## Status

The pure, headless correctness core is complete and fully tested (**M0–M4**). The 2D/FOLD-IO
layer (**M5**) and the three.js viewer (**M6–M7**) are not yet built.

| Milestone | What | State |
|---|---|---|
| M0 | Exact rational geometry kernel (`Rat`, `Vec2`, `Line`, `Iso`, `Poly`, hashing) | ✅ |
| M1 | Immutable state, split-at-axis, CONF normalization, serialization | ✅ |
| M2 | `FOLD ALL`, `FLIP`, `UNFOLD_LAST`, checker I1–I3 | ✅ |
| M3 | `FOLD ONE_LAYER` (moving-set closure, P1 tear / P2 extractability) | ✅ |
| M4 | Full checker I4–I6, `PRECREASE`, crafted-violation goldens | ✅ |
| M5 | `render2d` SVG projection Π(S), FOLD import/export | ⬜ |
| M6–M7 | three.js viewer: static build, fold animation, interaction | ⬜ |

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
packages/core/
  src/geom/     Rat, Vec2, Line, Iso, Poly, canonical hash   (M0)
  src/state/    Face, Edge, Spot, FoldedState, serialization (M1)
  src/ops/      split/CONF, fold ALL, fold ONE_LAYER, flip,
                precrease, unfold, dispatcher                (M1–M4)
  src/check/    independent invariant checker I1–I6          (M2, M4)
  test/         unit + property + crafted-violation + goldens
```

## Running

```sh
npm install
npm --workspace @origami/core run test        # 72 tests
npm --workspace @origami/core run typecheck    # strict, no errors
```

### Worked example (Appendix A golden)

`FOLD ALL x=½ (right, V)` then `FOLD ALL y=½ (top, V)` on the unit square yields one spot,
four layers, bottom→top `[left-bottom, right-bottom, right-top, left-top]` — the classic
half/half-again layer reversal, asserted exactly in `test/fold.test.ts`.

The crafted negative suite (`test/checker.test.ts`) feeds hand-built interleaved tacos,
trapped tortillas, and inconsistent cross-boundary orders directly to the checker to prove
I4/I5/I6 each fire with a witness — independent of how a state was produced.

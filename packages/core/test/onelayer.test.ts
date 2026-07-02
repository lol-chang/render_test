import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { area } from '../src/geom/poly.js';
import { initialSquare } from '../src/state/state.js';
import { foldedPoly, faceIsFront } from '../src/state/face.js';
import { FaceId } from '../src/state/ids.js';
import { applyOp } from '../src/ops/apply.js';
import { FoldOp } from '../src/ops/types.js';
import { FoldedState } from '../src/state/state.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });

function foldAllOp(a: Vec2, b: Vec2, movingSide: 'left' | 'right', direction: 'V' | 'M'): FoldOp {
  return { type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide, direction };
}
function oneLayerOp(
  a: Vec2,
  b: Vec2,
  movingSide: 'left' | 'right',
  direction: 'V' | 'M',
  seedFaceIds?: string[],
): FoldOp {
  const base: FoldOp = { type: 'FOLD', mode: 'ONE_LAYER', axis: { a, b }, movingSide, direction };
  return seedFaceIds ? { ...base, seedFaceIds: seedFaceIds as FaceId[] } : base;
}

// half-folded state: square folded x=1/2 right→left, layers [f0:L (bottom), f0:R (top)]
function halfFolded(): FoldedState {
  const r = applyOp(initialSquare(), foldAllOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'));
  if (!r.ok) throw new Error('half fold failed');
  return r.state;
}

function totalArea(state: FoldedState): Rat {
  let acc = Rat.ZERO;
  for (const f of state.faces.values()) acc = acc.add(area(f.srcPoly));
  return acc;
}

describe('ONE_LAYER: fold only the top flap (golden #2 essence — front-flap P2)', () => {
  it('folds the top layer left-portion over, leaving the bottom layer put', () => {
    const s = halfFolded();
    // auto-seed picks the TOP face of the moving-side spot; V requires it be above.
    const r = applyOp(s, oneLayerOp(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.ok).toBe(true);
    expect(totalArea(r.state).eq(Rat.ONE)).toBe(true);

    // moving-side region [0,1/4] should now hold only the untouched bottom layer,
    // and [1/4,1/2] should hold 3 layers with the folded flap on top.
    const spots = [...r.state.spots.values()];
    const solo = spots.find((sp) => sp.stack.length === 1);
    const triple = spots.find((sp) => sp.stack.length === 3);
    expect(solo).toBeDefined();
    expect(triple).toBeDefined();
    // the folded flap is the moved top face, now showing its front again (double reflection)
    const top = r.state.faces.get(triple!.stack[triple!.stack.length - 1]!)!;
    expect(top.id).toBe('f0:R:R');
    expect(faceIsFront(top)).toBe(true);
  });

  it('is a strict subset move: the bottom layer is unchanged (still front-up somewhere)', () => {
    const s = halfFolded();
    const r = applyOp(s, oneLayerOp(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V'));
    if (!r.ok) throw new Error('fold');
    // f0:L pieces keep T = identity ⇒ front up
    for (const f of r.state.faces.values()) {
      if (f.id.startsWith('f0:L')) expect(faceIsFront(f)).toBe(true);
    }
  });
});

// fold the right third over: yields a solo layer [0,1/3] and a 2-layer overlap
// [1/3,2/3] whose bottom face is a discrete, entirely-moving-side face — the setup
// needed to isolate P2 (blocked) and P1 (tear) with explicit seeds.
function thirdFolded(): FoldedState {
  const r = applyOp(initialSquare(), foldAllOp(V(R(2, 3), R(0)), V(R(2, 3), R(1)), 'right', 'V'));
  if (!r.ok) throw new Error('third fold failed');
  return r.state;
}

// fold left third onto center, then right third onto center: three INDEPENDENT
// layers at [1/3,2/3] (center bottom, left-flap middle, right-flap top). The middle
// flap is hinged at x=1/3 and is not connected to the top flap, so it is genuinely
// pinned under paper it is not part of — the real P2 block.
function centerStacked(): FoldedState {
  const a = applyOp(initialSquare(), foldAllOp(V(R(1, 3), R(0)), V(R(1, 3), R(1)), 'left', 'V'));
  if (!a.ok) throw new Error('left third');
  const b = applyOp(a.state, foldAllOp(V(R(2, 3), R(0)), V(R(2, 3), R(1)), 'right', 'V'));
  if (!b.ok) throw new Error('right third');
  return b.state;
}

describe('negative suite (M3)', () => {
  it('E_BLOCKED: cannot valley-fold the middle layer up through the flap covering it', () => {
    const s = centerStacked();
    const spot = [...s.spots.values()].find((sp) => sp.stack.length === 3)!;
    const middle = spot.stack[1]!; // hinged at x=1/3, pinned under the top flap
    const r = applyOp(
      s,
      oneLayerOp(V(R(1, 3), R(0)), V(R(1, 3), R(1)), 'right', 'V', [middle]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_BLOCKED');
    if (r.error.code !== 'E_BLOCKED') return;
    expect(r.error.pair).toContain(middle);
    expect(r.error.pair[0]).not.toBe(r.error.pair[1]);
  });

  it('E_TEAR: an explicit seed on the static side would tear the sheet', () => {
    const s = thirdFolded();
    const solo = [...s.spots.values()].find((sp) => sp.stack.length === 1)!;
    const soloFace = solo.stack[0]!; // lives in [0,1/3] — the static side of axis x=1/3
    // movingSide=right, but the seed is on the left/static side → mis-sided mover → tear.
    const r = applyOp(
      s,
      oneLayerOp(V(R(1, 3), R(0)), V(R(1, 3), R(1)), 'right', 'V', [soloFace]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_TEAR');
    if (r.error.code !== 'E_TEAR') return;
    expect(r.error.edges.length).toBeGreaterThan(0);
  });

  it('E_EMPTY_MOVE: ONE_LAYER along an axis outside the paper', () => {
    const s = halfFolded();
    const r = applyOp(s, oneLayerOp(V(R(2), R(0)), V(R(2), R(1)), 'right', 'V'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_EMPTY_MOVE');
  });
});

describe('golden #5 completion: partial extractability', () => {
  it('positive half: a buried-but-locally-exposed flap folds at its exposed region', () => {
    // Fold [3/4,1] onto [1/2,3/4]. The base sheet is exposed (top layer) on [0,1/2]
    // but buried under the flap on [1/2,3/4]. Folding the base at its EXPOSED region
    // (axis x=1/2, so the buried part stays across the hinge) is legal — P2 holds
    // where the mover is on top.
    const setup = applyOp(
      initialSquare(),
      foldAllOp(V(R(3, 4), R(0)), V(R(3, 4), R(1)), 'right', 'V'),
    );
    if (!setup.ok) throw new Error('setup');
    const r = applyOp(setup.state, oneLayerOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'left', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.ok).toBe(true);
    expect(totalArea(r.state).eq(Rat.ONE)).toBe(true);
  });

  it('some-layers block: folding the top flap drags a buried layer along → E_BLOCKED', () => {
    // In centerStacked, the top flap is hinged (off-axis) to the buried bottom layer.
    // Seeding the top flap and folding at x=1/3 pulls the bottom layer into the moving
    // set (a 2-layer / "some-layers" move); it is pinned under the middle flap → block.
    const s = centerStacked();
    const spot = [...s.spots.values()].find((sp) => sp.stack.length === 3)!;
    const top = spot.stack[2]!;
    const r = applyOp(
      s,
      oneLayerOp(V(R(1, 3), R(0)), V(R(1, 3), R(1)), 'right', 'V', [top]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_BLOCKED');
  });
});

describe('ONE_LAYER preserves G1/G2', () => {
  it('checker green + deterministic', () => {
    const run = () => {
      const s = halfFolded();
      const r = applyOp(s, oneLayerOp(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V'));
      if (!r.ok) throw new Error('fold');
      return r;
    };
    const a = run();
    const b = run();
    expect(a.report.ok).toBe(true);
    // stacks identical across runs
    const key = (st: FoldedState) =>
      [...st.spots.values()].map((sp) => sp.stack.join(',')).sort().join('|');
    expect(key(a.state)).toBe(key(b.state));
  });
});

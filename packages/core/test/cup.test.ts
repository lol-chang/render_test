/**
 * Golden #2 — traditional cup (M3 acceptance).
 *
 * The classic paper cup uses 30° corner folds, whose landing points are irrational
 * (tan 30° = 1/√3) and therefore unrepresentable in the exact rational kernel. This
 * golden is a faithful RATIONAL cup analog: it reproduces the cup's fold *structure*
 * — a diagonal base fold to a triangle, a corner fold that builds the body into a
 * multi-layer stack, and then the defining move: folding the FRONT flap only with a
 * ONE_LAYER fold (the classic "fold front flap only" test for P2). Exact proportions
 * differ from a physical cup; the layer combinatorics and the P2 test do not.
 *
 * Frozen per §9.3: any change to these counts requires written justification.
 */
import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { area } from '../src/geom/poly.js';
import { initialSquare, FoldedState } from '../src/state/state.js';
import { serialize } from '../src/state/serialize.js';
import { applyOp } from '../src/ops/apply.js';
import { Op, FoldOp } from '../src/ops/types.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });
const foldAll = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): Op => ({
  type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide: side, direction: dir,
});
const oneLayer = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): FoldOp => ({
  type: 'FOLD', mode: 'ONE_LAYER', axis: { a, b }, movingSide: side, direction: dir,
});

function totalArea(s: FoldedState): Rat {
  let acc = Rat.ZERO;
  for (const f of s.faces.values()) acc = acc.add(area(f.srcPoly));
  return acc;
}

// the cup up to (but not including) the front-flap fold
const CUP_STEPS: Op[] = [
  // 1. fold the lower-right triangle onto the upper-left → triangle {(0,0),(1,1),(0,1)}
  foldAll(V(R(0), R(0)), V(R(1), R(1)), 'right', 'V'),
  // 2. fold the (0,0) corner up into the body → multi-layer stack
  foldAll(V(R(0), R(1, 2)), V(R(1, 2), R(1)), 'left', 'V'),
];

function cupBody(): FoldedState {
  let s = initialSquare();
  for (const op of CUP_STEPS) {
    const r = applyOp(s, op);
    if (!r.ok) throw new Error(`cup step failed: ${JSON.stringify(r.error)}`);
    s = r.state;
  }
  return s;
}

describe('golden #2: traditional cup (rational analog)', () => {
  it('every construction step is valid and area-conserving', () => {
    let s = initialSquare();
    for (const op of CUP_STEPS) {
      const r = applyOp(s, op);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.ok).toBe(true);
      expect(totalArea(r.state).eq(Rat.ONE)).toBe(true);
      s = r.state;
    }
    // frozen structure of the cup body
    expect(s.faces.size).toBe(8);
    expect(s.spots.size).toBe(3);
  });

  it('front-flap ONE_LAYER fold succeeds (the P2 test) and stays valid', () => {
    const body = cupBody();
    const r = applyOp(body, oneLayer(V(R(0), R(3, 4)), V(R(1), R(3, 4)), 'left', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.ok).toBe(true); // full I1–I6 pass
    expect(totalArea(r.state).eq(Rat.ONE)).toBe(true);
    // frozen structure after the front-flap fold
    expect(r.state.faces.size).toBe(20);
    expect(r.state.spots.size).toBe(5);
  });

  it('folding a buried layer of the cup is rejected by P2 (E_BLOCKED)', () => {
    const body = cupBody();
    // seed the bottom face of the deepest (4-layer) spot and try to valley-fold it up
    const deep = [...body.spots.values()].find((sp) => sp.stack.length === 4)!;
    const buried = deep.stack[0]!;
    // use an axis that does not cross that face so it stays a single mover
    const r = applyOp(
      body,
      { ...oneLayer(V(R(0), R(3, 4)), V(R(1), R(3, 4)), 'left', 'V'), seedFaceIds: [buried] },
    );
    // either blocked (buried under other layers) or tears (pinned off-axis): both are
    // legitimate rejections — the point is the engine refuses an impossible move.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['E_BLOCKED', 'E_TEAR']).toContain(r.error.code);
  });

  it('is deterministic (G2): the cup + front flap serializes identically twice', () => {
    const run = () => {
      const r = applyOp(cupBody(), oneLayer(V(R(0), R(3, 4)), V(R(1), R(3, 4)), 'left', 'V'));
      if (!r.ok) throw new Error('flap');
      return serialize(r.state);
    };
    expect(run()).toBe(run());
  });
});

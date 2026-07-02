import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { area } from '../src/geom/poly.js';
import { initialSquare, FoldedState } from '../src/state/state.js';
import { faceIsFront, foldedPoly } from '../src/state/face.js';
import { serialize } from '../src/state/serialize.js';
import { applyOp } from '../src/ops/apply.js';
import { PrecreaseOp, FoldOp, FlipOp } from '../src/ops/types.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });

function precreaseOp(a: Vec2, b: Vec2, side: 'left' | 'right'): PrecreaseOp {
  return { type: 'PRECREASE', axis: { a, b }, movingSide: side, direction: 'V' };
}
function foldOp(a: Vec2, b: Vec2, side: 'left' | 'right'): FoldOp {
  return { type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide: side, direction: 'V' };
}
function totalArea(s: FoldedState): Rat {
  let acc = Rat.ZERO;
  for (const f of s.faces.values()) acc = acc.add(area(f.srcPoly));
  return acc;
}

describe('PRECREASE (golden #4: annotation-only, mark remains, geometry unchanged)', () => {
  it('does NOT split faces — the mark is a pending crease, not an edge', () => {
    const s0 = initialSquare();
    const r = applyOp(s0, precreaseOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.ok).toBe(true);
    // v1.1: annotation-only ⇒ face/spot count does NOT rise (was 2, now 1)
    expect(r.state.faces.size).toBe(1);
    expect(r.state.spots.size).toBe(1);
    for (const f of r.state.faces.values()) expect(faceIsFront(f)).toBe(true);
    expect(totalArea(r.state).eq(Rat.ONE)).toBe(true);
    // the crease lives in pendingCreases, and there are NO crease edges yet
    expect(r.state.pendingCreases.length).toBe(1);
    const creaseEdges = [...r.state.edges.values()].filter((e) => e.kind === 'CREASE');
    expect(creaseEdges.length).toBe(0);
    // Edge.folded no longer exists on the interface
    for (const e of r.state.edges.values()) expect('folded' in e).toBe(false);
  });

  it('the precreased state folds cleanly along the mark', () => {
    const s0 = initialSquare();
    const pc = applyOp(s0, precreaseOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right'));
    if (!pc.ok) throw new Error('precrease');
    const f = applyOp(pc.state, foldOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right'));
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.report.ok).toBe(true);
    expect(f.state.spots.size).toBe(1); // folded onto one spot
  });

  it('UNFOLD_LAST reverts a precrease to the pristine square', () => {
    const s0 = initialSquare();
    const pc = applyOp(s0, precreaseOp(V(R(1, 3), R(0)), V(R(1, 3), R(1)), 'left'));
    if (!pc.ok) throw new Error('precrease');
    const u = applyOp(pc.state, { type: 'UNFOLD_LAST' });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(serialize(u.state)).toBe(serialize(s0));
  });

  it('a precrease that would tear/blocked propagates the FOLD error', () => {
    // axis outside the paper → the equivalent fold has no moving set
    const s0 = initialSquare();
    const r = applyOp(s0, precreaseOp(V(R(2), R(0)), V(R(2), R(1)), 'right'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('E_EMPTY_MOVE');
  });
});

describe('golden #3: flips + one-layer folds interacting (hat/boat flavor)', () => {
  const oneLayer = (a: Vec2, b: Vec2, side: 'left' | 'right'): FoldOp => ({
    type: 'FOLD',
    mode: 'ONE_LAYER',
    axis: { a, b },
    movingSide: side,
    direction: 'V',
  });

  it('fold → flip → one-layer stays valid at every step and is deterministic', () => {
    const run = () => {
      let s = initialSquare();
      const steps: Array<FoldOp | FlipOp> = [
        foldOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right'), // fold in half
        { type: 'FLIP' }, // turn the model over
        oneLayer(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left'), // fold top flap only
      ];
      for (const op of steps) {
        const r = applyOp(s, op);
        if (!r.ok) throw new Error(`op ${op.type} failed: ${JSON.stringify(r.error)}`);
        expect(r.report.ok).toBe(true);
        s = r.state;
      }
      return serialize(s);
    };
    expect(run()).toBe(run());
  });
});

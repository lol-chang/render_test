import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { initialSquare } from '../src/state/state.js';
import { applyOp } from '../src/ops/apply.js';
import { checkState } from '../src/check/checker.js';
import { Op } from '../src/ops/types.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });
const fa = (a: Vec2, b: Vec2, s: 'left' | 'right', d: 'V' | 'M'): Op =>
  ({ type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide: s, direction: d });
const rev = (a: Vec2, b: Vec2, s: 'left' | 'right', d: 'V' | 'M'): Op =>
  ({ type: 'INSIDE_REVERSE_FOLD', axis: { a, b }, movingSide: s, direction: d });

function diamond() {
  let s = initialSquare();
  for (const op of [
    fa(V(R(1, 2), R(1)), V(R(0), R(1, 2)), 'right', 'V'),
    fa(V(R(1, 2), R(1)), V(R(1), R(1, 2)), 'left', 'V'),
    fa(V(R(0), R(1, 2)), V(R(1, 2), R(0)), 'left', 'V'),
    fa(V(R(1), R(1, 2)), V(R(1, 2), R(0)), 'right', 'V'),
  ]) { const r = applyOp(s, op); if (!r.ok) throw new Error(JSON.stringify(r.error)); s = r.state; }
  return s;
}

describe('INSIDE_REVERSE_FOLD (§3.3)', () => {
  it('reverses a flap tip and yields a checker-valid nested state', () => {
    // fold square in half -> 2-layer rectangle over [0,½]×[0,1]
    const half = applyOp(initialSquare(), fa(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'));
    expect(half.ok).toBe(true);
    if (!half.ok) return;
    const r = applyOp(half.state, rev(V(R(0), R(3, 4)), V(R(1), R(3, 4)), 'left', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checkState(r.state).ok).toBe(true);
    // area is conserved (I2) and the reversed movers are still present
    expect(r.state.faces.size).toBeGreaterThan(half.state.faces.size);
  });

  it('makes a frog leg on the diamond base — valid, layers nested (>4 spots)', () => {
    const d = diamond();
    const r = applyOp(d, rev(V(R(0), R(-3, 4)), V(R(1), R(-3, 4)), 'right', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rep = checkState(r.state);
    expect(rep.ok).toBe(true);
    // reverse fold nests the tip -> more spots than the plain 4-spot diamond
    expect(r.state.spots.size).toBeGreaterThan(d.spots.size);
  });

  it('rejects an axis that misses the paper with E_EMPTY_MOVE', () => {
    const d = diamond();
    const r = applyOp(d, rev(V(R(0), R(5)), V(R(1), R(5)), 'right', 'V'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_EMPTY_MOVE');
  });
});

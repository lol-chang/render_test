import { describe, expect, it } from 'vitest';
import { Rat, initialSquare, applyOp, type Op, type Vec2 } from '../src/index.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });

const axis = (ax: Rat, ay: Rat, bx: Rat, by: Rat) => ({ a: V(ax, ay), b: V(bx, by) });

describe('applyOp always answers with a Result', () => {
  const cases: Array<[string, Op]> = [
    ['degenerate axis (a == b)', {
      type: 'FOLD', mode: 'ALL', axis: axis(R(1, 2), R(0), R(1, 2), R(0)),
      movingSide: 'right', direction: 'V',
    }],
    ['axis off the paper', {
      type: 'FOLD', mode: 'ALL', axis: axis(R(5), R(0), R(5), R(1)),
      movingSide: 'right', direction: 'V',
    }],
    ['axis on the border, nothing to move', {
      type: 'FOLD', mode: 'ALL', axis: axis(R(0), R(0), R(0), R(1)),
      movingSide: 'left', direction: 'V',
    }],
    ['one-layer fold on a single sheet', {
      type: 'FOLD', mode: 'ONE_LAYER', axis: axis(R(1, 2), R(0), R(1, 2), R(1)),
      movingSide: 'right', direction: 'V',
    }],
    ['reverse fold with nothing to reverse', {
      type: 'INSIDE_REVERSE_FOLD', axis: axis(R(1, 2), R(0), R(1, 2), R(1)),
      movingSide: 'right', direction: 'V',
    }],
    ['unfold with no history', { type: 'UNFOLD_LAST' }],
    ['unfold a negative count', { type: 'UNFOLD_LAST', count: -3 }],
    ['precrease on a degenerate axis', {
      type: 'PRECREASE', axis: axis(R(1, 3), R(1, 3), R(1, 3), R(1, 3)),
      movingSide: 'left', direction: 'M',
    }],
  ];

  for (const [label, op] of cases) {
    it(label, () => {
      const r = applyOp(initialSquare(), op);
      expect(typeof r.ok).toBe('boolean');
      if (!r.ok) expect(typeof r.error.code).toBe('string');
    });
  }

  it('a long random walk never throws and never leaves an invalid state', () => {
    let s = initialSquare();
    let applied = 0;
    const denoms = [2, 3, 4, 5, 8];
    for (let i = 0; i < 120 && applied < 7; i++) {
      const d = denoms[i % denoms.length]!;
      const n = 1 + (i % (d - 1));
      const vertical = i % 2 === 0;
      const op: Op = {
        type: 'FOLD',
        mode: i % 3 === 0 ? 'ONE_LAYER' : 'ALL',
        axis: vertical
          ? axis(R(n, d), R(0), R(n, d), R(1))
          : axis(R(0), R(n, d), R(1), R(n, d)),
        movingSide: i % 4 < 2 ? 'left' : 'right',
        direction: i % 5 === 0 ? 'M' : 'V',
      };
      const r = applyOp(s, op);
      if (r.ok) {
        expect(r.report.ok, `invalid state after ${applied} folds`).toBe(true);
        s = r.state;
        applied++;
      }
    }
    expect(applied).toBeGreaterThan(0);
  });
});

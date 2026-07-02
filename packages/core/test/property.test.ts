import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { area } from '../src/geom/poly.js';
import { initialSquare, FoldedState } from '../src/state/state.js';
import { applyOp } from '../src/ops/apply.js';
import { Op, FoldOp } from '../src/ops/types.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const AXES: Array<[Vec2, Vec2]> = [
  [V(R(1, 2), R(0)), V(R(1, 2), R(1))],
  [V(R(0), R(1, 2)), V(R(1), R(1, 2))],
  [V(R(1, 3), R(0)), V(R(1, 3), R(1))],
  [V(R(2, 3), R(0)), V(R(2, 3), R(1))],
  [V(R(0), R(1, 4)), V(R(1), R(1, 4))],
  [V(R(0), R(0)), V(R(1), R(1))],
];

// G1 sweep parameters (reported per v1.1 requirement 5):
//   seeds      = 24  (deterministic LCG, one sequence each)
//   length     = 14  ops attempted per sequence
//   op mix     ≈ FOLD 90% (½ ALL, ½ ONE_LAYER) · FLIP 5% · PRECREASE 5%,
//                each FOLD/PRECREASE with uniform axis ∈ AXES (6 rational lines),
//                movingSide ∈ {left,right}, direction ∈ {V,M}
// Rejected ops (E_TEAR/E_BLOCKED/E_EMPTY_MOVE/…) are skipped — closure only asserts
// that every ACCEPTED op yields a state passing the full checker I1–I6.
const SEEDS = [3, 17, 42, 99, 128, 200, 256, 333, 512, 777, 1000, 1234, 1500, 2024,
  2718, 3141, 4096, 5000, 6789, 8192, 9001, 12345, 31337, 65535];
const LENGTH = 14;

function randomOp(rng: () => number): Op {
  const [a, b] = AXES[Math.floor(rng() * AXES.length)]!;
  const movingSide = rng() < 0.5 ? 'left' : 'right';
  const direction = rng() < 0.5 ? 'V' : 'M';
  const roll = rng();
  if (roll < 0.05) return { type: 'FLIP' };
  if (roll < 0.1) return { type: 'PRECREASE', axis: { a, b }, movingSide, direction };
  const mode = rng() < 0.5 ? 'ALL' : 'ONE_LAYER';
  const op: FoldOp = { type: 'FOLD', mode, axis: { a, b }, movingSide, direction };
  return op;
}

function totalArea(s: FoldedState): Rat {
  let acc = Rat.ZERO;
  for (const f of s.faces.values()) acc = acc.add(area(f.srcPoly));
  return acc;
}

describe('G1 closure: accepted ops always yield a fully-valid state', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: random accepted sequence (len ${LENGTH}) stays green`, () => {
      const rng = lcg(seed);
      let s = initialSquare();
      let accepted = 0;
      for (let i = 0; i < LENGTH; i++) {
        const r = applyOp(s, randomOp(rng));
        if (!r.ok) continue; // rejected ops don't count against closure
        // every accepted op must produce a state passing ALL invariants
        expect(r.report.ok).toBe(true);
        expect(totalArea(r.state).eq(Rat.ONE)).toBe(true);
        s = r.state;
        accepted++;
      }
      expect(accepted).toBeGreaterThan(0); // sanity: some ops were accepted
    });
  }
});

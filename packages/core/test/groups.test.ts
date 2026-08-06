import { describe, expect, it } from 'vitest';
import {
  Rat, initialSquare, applyOp, foldGroups,
  type FoldedState, type Op, type Vec2, type FaceId,
} from '../src/index.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });
const vline = (n: number, d: number) => ({ a: V(R(n, d), R(0)), b: V(R(n, d), R(1)) });
const foldAll = (n: number, d: number, side: 'left' | 'right'): Op => ({
  type: 'FOLD', mode: 'ALL', axis: vline(n, d), movingSide: side, direction: 'V',
});

function build(...ops: Op[]): FoldedState {
  let s = initialSquare();
  for (const op of ops) {
    const r = applyOp(s, op);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    s = r.state;
  }
  return s;
}

function depth(s: FoldedState): number {
  let d = 1;
  for (const sp of s.spots.values()) d = Math.max(d, sp.stack.length);
  return d;
}

describe('foldGroups says which layers can move, and which must move together', () => {
  it('a single flat sheet offers exactly one group: the whole side', () => {
    const s = initialSquare();
    const { groups } = foldGroups(s, vline(1, 2), 'right', 'V');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bonded).toBe(false);
    expect(groups[0]!.foldable).toBe(true);
  });

  it('a degenerate axis is refused, not guessed at', () => {
    const s = initialSquare();
    const r = foldGroups(s, { a: V(R(1, 2), R(0)), b: V(R(1, 2), R(0)) }, 'right', 'V');
    expect(r.error?.code).toBe('E_AXIS_DEGENERATE');
    expect(r.groups).toHaveLength(0);
  });

  it('on a folded-in-half sheet, the top layer peels alone and the pair goes together', () => {
    const s = build(foldAll(1, 2, 'right'));
    expect(depth(s)).toBe(2);
    const { groups } = foldGroups(s, vline(1, 4), 'left', 'V');
    expect(groups.length).toBeGreaterThanOrEqual(2);

    const one = groups.find((g) => g.faces.length === 1);
    expect(one, 'a one-layer group must be offered').toBeDefined();
    expect(one!.bonded).toBe(false);
    expect(one!.foldable).toBe(true);

    const both = groups.find((g) => g.faces.length === 2);
    expect(both, 'a two-layer group must be offered').toBeDefined();
    expect(both!.foldable).toBe(true);
  });

  it('every group it calls foldable really folds, and every group it refuses really fails', () => {
    const s = build(foldAll(1, 2, 'right'), foldAll(1, 4, 'right'));
    expect(depth(s)).toBe(4);
    const { groups } = foldGroups(s, vline(1, 8), 'right', 'V');
    expect(groups.length).toBeGreaterThan(0);

    for (const g of groups) {
      const op: Op = {
        type: 'FOLD', mode: 'ONE_LAYER', axis: vline(1, 8),
        movingSide: 'right', direction: 'V', seedFaceIds: g.faces as FaceId[],
      };
      const r = applyOp(s, op);
      if (g.foldable) {
        expect(r.ok, `group of ${g.faces.length} was called foldable but ${JSON.stringify(r.ok ? '' : r.error)}`).toBe(true);
      } else {
        expect(r.ok, `group of ${g.faces.length} was refused but folded anyway`).toBe(false);
      }
    }
  });

  it('a bonded group names the layers it drags along', () => {
    const s = build(foldAll(1, 2, 'right'), foldAll(1, 4, 'right'));
    const { groups } = foldGroups(s, vline(1, 8), 'right', 'V');
    for (const g of groups) {
      expect(g.bonded).toBe(g.bondedTo.length > 0);
      for (const id of g.bondedTo) expect(g.faces).toContain(id);
    }
    const bonded = groups.filter((g) => g.bonded);
    expect(bonded.length, 'a four-layer stack must have at least one bonded group').toBeGreaterThan(0);
  });

  it('reports, per spot, which stack indices move and how deep that is', () => {
    const s = build(foldAll(1, 2, 'right'));
    const { groups } = foldGroups(s, vline(1, 4), 'left', 'V');
    for (const g of groups) {
      expect(g.layers.length).toBeGreaterThan(0);
      for (const l of g.layers) {
        expect(l.indices.length).toBeGreaterThan(0);
        expect(l.depth).toBeGreaterThanOrEqual(l.indices.length);
        expect(l.stackSize).toBeGreaterThanOrEqual(l.indices.length);
        for (const i of l.indices) expect(i).toBeLessThan(l.stackSize);
      }
    }
  });

  it('a mountain fold peels from the bottom, a valley from the top', () => {
    const s = build(foldAll(1, 2, 'right'));
    const v = foldGroups(s, vline(1, 4), 'left', 'V').groups.find((g) => g.faces.length === 1);
    const m = foldGroups(s, vline(1, 4), 'left', 'M').groups.find((g) => g.faces.length === 1);
    expect(v).toBeDefined();
    expect(m).toBeDefined();
    expect(v!.seed).not.toBe(m!.seed);
  });
});

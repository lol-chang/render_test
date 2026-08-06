import { describe, expect, it } from 'vitest';
import {
  Rat, initialSquare, applyOp, foldGroups,
  type FoldedState, type Op, type Vec2, type FaceId, type FoldGroup,
} from '@origami/core';
import { describeGroup, groupHolds, groupKeyOf, pickGroup, reasonText } from '../src/groupui.js';

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

const fake = (g: Partial<FoldGroup>): FoldGroup => ({
  seed: 'f0' as FaceId,
  faces: [],
  layers: [],
  bonded: false,
  bondedTo: [],
  foldable: true,
  reason: undefined,
  ...g,
});

/**
 * The panel must not paraphrase the engine. Everything a row claims — how many layers
 * lift, whether they are stuck together, why one is refused — has to come from the
 * FoldGroup, because the engine is the only thing that actually knows.
 */
describe('describeGroup turns a FoldGroup into a row a person can read', () => {
  const four = build(foldAll(1, 2, 'right'), foldAll(1, 4, 'right'));

  it('names the end the layers peel from, so V and M never read alike', () => {
    const g = fake({ faces: ['a'] as FaceId[], layers: [{ spot: 's', depth: 1, indices: [3], stackSize: 4 }] });
    expect(describeGroup(g, 'V').title).toBe('top layer');
    expect(describeGroup(g, 'M').title).toBe('bottom layer');
  });

  it('counts the layers that move, not the faces, since one layer can be many faces', () => {
    const g = fake({
      faces: ['a', 'b', 'c'] as FaceId[],
      layers: [
        { spot: 's1', depth: 2, indices: [2, 3], stackSize: 4 },
        { spot: 's2', depth: 1, indices: [0], stackSize: 1 },
      ],
    });
    const view = describeGroup(g, 'V');
    expect(view.title).toBe('top 2 layers');
    expect(view.note).toContain('3 faces');
    expect(view.note).toContain('2 of 4');
  });

  it('says out loud when the closure dragged layers in, because the user cannot undo that', () => {
    const g = fake({
      faces: ['a', 'b'] as FaceId[],
      bonded: true,
      bondedTo: ['b'] as FaceId[],
      layers: [{ spot: 's', depth: 2, indices: [0, 1], stackSize: 2 }],
    });
    expect(describeGroup(g, 'V').note).toContain('cannot be separated');
    expect(describeGroup(g, 'V').note).toContain('+1');
  });

  it('gives a refused group a why, and a foldable group none', () => {
    const bad = fake({
      faces: ['a'] as FaceId[],
      foldable: false,
      reason: { code: 'E_BLOCKED', spot: 's' as never, pair: ['x', 'y'] as never },
    });
    expect(describeGroup(bad, 'V').why).toContain('E_BLOCKED');
    expect(describeGroup(bad, 'V').why).toContain('x vs y');
    expect(describeGroup(fake({ faces: ['a'] as FaceId[] }), 'V').why).toBe('');
  });

  it('describes every group of a real four-layer stack without producing empty text', () => {
    const { groups } = foldGroups(four, vline(1, 8), 'right', 'V');
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      const view = describeGroup(g, 'V');
      expect(view.title).toMatch(/^top( \d+)? layers?$/);
      expect(view.note.length).toBeGreaterThan(0);
      expect(view.why === '').toBe(g.foldable);
    }
  });
});

/**
 * A row is only worth clicking if it folds. The engine already ruled on that
 * (core/test/groups.test.ts pins it), so the panel never dry-runs — it just refuses to
 * preselect a group the engine refused, and never hands a refused group to applyOp.
 */
describe('pickGroup keeps the selection honest as the axis and the click change', () => {
  const half = build(foldAll(1, 2, 'right'));

  it('falls to the first foldable group when nothing is chosen yet', () => {
    const groups = [fake({ faces: ['a'] as FaceId[], foldable: false }), fake({ faces: ['b'] as FaceId[] })];
    expect(pickGroup(groups, null, null)).toBe(1);
  });

  it('reports -1 rather than a refused group when none can fold', () => {
    const groups = [fake({ faces: ['a'] as FaceId[], foldable: false })];
    expect(pickGroup(groups, null, null)).toBe(-1);
  });

  it('keeps an explicitly clicked row across a rebuild of the same list', () => {
    const groups = [fake({ faces: ['a'] as FaceId[] }), fake({ faces: ['b', 'c'] as FaceId[] })];
    expect(pickGroup(groups, groupKeyOf(groups[1]!), null)).toBe(1);
  });

  it('drops a kept key that the new axis no longer offers, instead of pointing nowhere', () => {
    const groups = [fake({ faces: ['a'] as FaceId[] })];
    expect(pickGroup(groups, 'gone|missing', null)).toBe(0);
  });

  it('a picked face selects the smallest foldable group holding it', () => {
    const groups = [
      fake({ faces: ['a'] as FaceId[], foldable: false }),
      fake({ faces: ['a', 'b'] as FaceId[] }),
      fake({ faces: ['a', 'b', 'c'] as FaceId[] }),
    ];
    expect(pickGroup(groups, null, 'a' as FaceId)).toBe(1);
  });

  it('still selects a refused group holding the face, so the user is told why not', () => {
    const groups = [fake({ faces: ['a'] as FaceId[], foldable: false }), fake({ faces: ['z'] as FaceId[] })];
    expect(pickGroup(groups, null, 'a' as FaceId)).toBe(0);
  });

  it('matches a face against the pieces the axis split it into', () => {
    const g = fake({ faces: ['f3:L', 'f3:R'] as FaceId[] });
    expect(groupHolds(g, 'f3' as FaceId)).toBe(true);
    expect(groupHolds(g, 'f3x' as FaceId)).toBe(false);
    expect(pickGroup([g], null, 'f3' as FaceId)).toBe(0);
  });

  it('every face of a real state resolves to a group whose seeds applyOp accepts', () => {
    const axis = vline(1, 4);
    const { groups } = foldGroups(half, axis, 'left', 'V');
    const picked = groups[pickGroup(groups, null, null)];
    expect(picked).toBeDefined();
    const r = applyOp(half, {
      type: 'FOLD', mode: 'ONE_LAYER', axis, movingSide: 'left', direction: 'V',
      seedFaceIds: [...picked!.faces],
    });
    expect(r.ok).toBe(true);
  });
});

describe('reasonText explains a refusal in words, never a bare code', () => {
  it('turns each OpError into something a person can act on', () => {
    expect(reasonText({ code: 'E_BLOCKED', spot: 's' as never, pair: ['x', 'y'] as never })).toContain('in the way');
    expect(reasonText({ code: 'E_TEAR', edges: [] })).toBe('would tear the paper');
    expect(reasonText({ code: 'E_TEAR', edges: ['e1'] as never })).toBe('would tear 1 edge');
    expect(reasonText({ code: 'E_TEAR', edges: ['e1', 'e2'] as never })).toBe('would tear 2 edges');
    expect(reasonText({ code: 'E_EMPTY_MOVE' })).toContain('moving side');
    expect(reasonText({ code: 'E_AXIS_DEGENERATE' })).toContain('point');
    expect(reasonText({ code: 'E_INVARIANT', invariant: 'I4', witness: null })).toContain('I4');
    expect(reasonText({ code: 'E_UNSUPPORTED', detail: 'no such op' })).toBe('no such op');
  });
});

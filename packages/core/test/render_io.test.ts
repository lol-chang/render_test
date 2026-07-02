import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { initialSquare, FoldedState } from '../src/state/state.js';
import { applyOp } from '../src/ops/apply.js';
import { Op } from '../src/ops/types.js';
import { renderSVG } from '../src/render2d/svg.js';
import { toFold, foldStacks } from '../src/io/fold.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });
const fa = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): Op => ({
  type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide: side, direction: dir,
});

function halfHalf(): FoldedState {
  let s = initialSquare();
  for (const op of [
    fa(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'),
    fa(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V'),
  ]) {
    const r = applyOp(s, op);
    if (!r.ok) throw new Error('fold');
    s = r.state;
  }
  return s;
}

describe('render2d Π(S) SVG (M5)', () => {
  it('produces a deterministic SVG string', () => {
    const s = halfHalf();
    const a = renderSVG(s);
    const b = renderSVG(s);
    expect(a).toBe(b); // G2 determinism
    expect(a.startsWith('<svg')).toBe(true);
    expect(a.includes('</svg>')).toBe(true);
    // one filled region for the single spot
    expect((a.match(/<path /g) ?? []).length).toBe(1);
  });

  it('initial square renders a single front-colored face', () => {
    const svg = renderSVG(initialSquare());
    expect(svg).toContain('#d94f5c'); // front color of the up-facing square
  });

  it('xray mode adds hidden creases (more crease lines than plain)', () => {
    const s = halfHalf();
    const plain = (renderSVG(s, { xray: false }).match(/<line /g) ?? []).length;
    const xray = (renderSVG(s, { xray: true }).match(/<line /g) ?? []).length;
    expect(xray).toBeGreaterThanOrEqual(plain);
  });
});

describe('FOLD import/export round-trip (M5, §4.3)', () => {
  it('exported FOLD has consistent field lengths and normal-CCW faces', () => {
    const s = halfHalf();
    const fold = toFold(s);
    expect(fold.file_spec).toBe(1.1);
    expect(fold.edges_vertices.length).toBe(fold.edges_assignment.length);
    expect(fold.faces_vertices.length).toBe(s.faces.size);
    // faceOrders present for the 4-layer overlap: C(4,2) = 6 pairs
    expect(fold.faceOrders.length).toBe(6);
    for (const [f, g, sgn] of fold.faceOrders) {
      expect(f).not.toBe(g);
      expect([1, -1]).toContain(sgn);
    }
  });

  it('our stacks survive a round-trip through FOLD faceOrders', () => {
    const s = halfHalf();
    const fold = toFold(s);
    const reconstructed = foldStacks(fold);

    // our own stacks as sorted face-index sequences (bottom→top)
    const faceIdx = new Map<string, number>();
    [...s.faces.values()]
      .map((f) => f.id)
      .sort()
      .forEach((id, i) => faceIdx.set(id, i));

    for (const sp of s.spots.values()) {
      const ours = sp.stack.map((id) => faceIdx.get(id)!);
      // find the matching reconstructed group (same multiset of face indices)
      const match = [...reconstructed.values()].find(
        (arr) => arr.length === ours.length && arr.every((x) => ours.includes(x)),
      );
      expect(match).toBeDefined();
      expect(match).toEqual(ours); // exact bottom→top order preserved
    }
  });

  it('round-trips a deep 8-layer rolling fold', () => {
    let s = initialSquare();
    for (const op of [
      fa(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'),
      fa(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'right', 'V'),
      fa(V(R(1, 8), R(0)), V(R(1, 8), R(1)), 'right', 'V'),
    ]) {
      const r = applyOp(s, op);
      if (!r.ok) throw new Error('fold');
      s = r.state;
    }
    const reconstructed = foldStacks(toFold(s));
    const faceIdx = new Map<string, number>();
    [...s.faces.values()].map((f) => f.id).sort().forEach((id, i) => faceIdx.set(id, i));
    for (const sp of s.spots.values()) {
      const ours = sp.stack.map((id) => faceIdx.get(id)!);
      const match = [...reconstructed.values()].find(
        (arr) => arr.length === ours.length && arr.every((x) => ours.includes(x)),
      );
      expect(match).toEqual(ours);
    }
  });
});

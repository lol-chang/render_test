/**
 * NO LAYER IS DRAWN THROUGH ANOTHER. A layer poking through the one over it shows on screen as
 * the wrong colour striped across the paper — the one defect a viewer cannot un-see — and two
 * surfaces crossing is exactly a mesh self-intersection. So this hunts intersecting triangle
 * pairs (excluding pairs that share a vertex: in this one-surface mesh, legitimate contact is
 * always through shared vertices) and bounds their total crossing length.
 *
 * The bound is zero for most demos. What residue remains sits in CORNER KNOTS: material corners
 * where several fold lines meet (the cup's rim corners, the frog's centre), where layers at
 * every level converge within a band width and the blended fields genuinely have no room. Those
 * crossings are a couple of gaps across and sit inside the pile. The budgets below are the
 * measured residue with headroom — they are ratchets, meant to be lowered, never raised.
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { buildModel, type BuildOptions } from '../src/build3d.js';
import { demos } from '../src/demos.js';
import type { FoldedState } from '@origami/core';

const PAPER: BuildOptions = { epsilon: 0.006 };

/** Accepted corner-knot residue, in ε of total crossing length. Everything else must be clean. */
const BUDGET: Record<string, number> = {
  'Traditional cup': 85,
  'Rabbit-ish (band + ears + flip)': 2,
  'Frog (base: house → sides to centre)': 11,
};

interface Sheet {
  pos: Float32Array;
  index: ArrayLike<number>;
  tris: number;
}

function sheetOf(state: FoldedState, opts: BuildOptions): Sheet {
  const built = buildModel(state, opts);
  const meshes: THREE.Mesh[] = [];
  built.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const g = meshes[0]!.geometry;
  return {
    pos: g.getAttribute('position').array as Float32Array,
    index: g.getIndex()!.array,
    tris: g.getIndex()!.count / 3,
  };
}

type V3 = [number, number, number];

/** Signed distances of t's vertices to the plane of (a,b,c), and that plane's unit normal. */
function planeDists(a: V3, b: V3, c: V3, t: V3[]): { n: V3; d: number[] } {
  const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(n[0], n[1], n[2]) || 1;
  n[0] /= L; n[1] /= L; n[2] /= L;
  const off = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
  return { n, d: t.map((p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - off) };
}

/**
 * Length of the intersection segment of two triangles, 0 if they do not cross. Near-coplanar
 * pairs return 0 — layers drawn a gap apart are never coplanar unless they already touch.
 */
function triTriCross(t1: V3[], t2: V3[], eps: number): number {
  const { d: d1 } = planeDists(t2[0]!, t2[1]!, t2[2]!, t1);
  if (d1.every((x) => x > eps) || d1.every((x) => x < -eps)) return 0;
  const { d: d2 } = planeDists(t1[0]!, t1[1]!, t1[2]!, t2);
  if (d2.every((x) => x > eps) || d2.every((x) => x < -eps)) return 0;
  if (d1.every((x) => Math.abs(x) <= eps) || d2.every((x) => Math.abs(x) <= eps)) return 0;
  const { n: n1 } = planeDists(t1[0]!, t1[1]!, t1[2]!, t1);
  const { n: n2 } = planeDists(t2[0]!, t2[1]!, t2[2]!, t2);
  const dir: V3 = [
    n1[1] * n2[2] - n1[2] * n2[1],
    n1[2] * n2[0] - n1[0] * n2[2],
    n1[0] * n2[1] - n1[1] * n2[0],
  ];
  const dl = Math.hypot(dir[0], dir[1], dir[2]);
  if (dl < 1e-12) return 0;
  dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
  const interval = (t: V3[], d: number[]): [number, number] | null => {
    const pts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const di = d[i]!, dj = d[j]!;
      if ((di > eps && dj < -eps) || (di < -eps && dj > eps)) {
        const s = di / (di - dj);
        const p: V3 = [
          t[i]![0] + s * (t[j]![0] - t[i]![0]),
          t[i]![1] + s * (t[j]![1] - t[i]![1]),
          t[i]![2] + s * (t[j]![2] - t[i]![2]),
        ];
        pts.push(dir[0] * p[0] + dir[1] * p[1] + dir[2] * p[2]);
      } else if (Math.abs(di) <= eps) {
        pts.push(dir[0] * t[i]![0] + dir[1] * t[i]![1] + dir[2] * t[i]![2]);
      }
    }
    if (pts.length < 2) return null;
    return [Math.min(...pts), Math.max(...pts)];
  };
  const i1 = interval(t1, d1), i2 = interval(t2, d2);
  if (!i1 || !i2) return 0;
  return Math.max(0, Math.min(i1[1], i2[1]) - Math.max(i1[0], i2[0]));
}

describe('no layer is drawn through another', () => {
  for (const demo of demos()) {
    it(demo.name, () => {
      const state = demo.states[demo.states.length - 1]!;
      const s = sheetOf(state, PAPER);

      // spatial hash over drawn xy; each candidate pair is handled once, in the grid cell that
      // holds the low corner of its bbox overlap
      const CELL = 0.02;
      const buckets = new Map<string, number[]>();
      const bbox: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }[] = [];
      for (let t = 0; t < s.tris; t++) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let e = 0; e < 3; e++) {
          const v = s.index[3 * t + e]!;
          x0 = Math.min(x0, s.pos[3 * v]!); x1 = Math.max(x1, s.pos[3 * v]!);
          y0 = Math.min(y0, s.pos[3 * v + 1]!); y1 = Math.max(y1, s.pos[3 * v + 1]!);
          z0 = Math.min(z0, s.pos[3 * v + 2]!); z1 = Math.max(z1, s.pos[3 * v + 2]!);
        }
        bbox.push({ x0, x1, y0, y1, z0, z1 });
        for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
          for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
            const k = `${gx},${gy}`;
            (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(t);
          }
        }
      }

      const EPS = 1e-9;
      const MINLEN = 1e-6;
      let total = 0, worstAt = '';
      for (const [ck, list] of buckets) {
        const [cgx, cgy] = ck.split(',').map(Number) as [number, number];
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!, b = list[j]!;
            const ba = bbox[a]!, bb = bbox[b]!;
            if (ba.x0 > bb.x1 || bb.x0 > ba.x1 || ba.y0 > bb.y1 || bb.y0 > ba.y1) continue;
            if (ba.z0 > bb.z1 + 1e-9 || bb.z0 > ba.z1 + 1e-9) continue;
            if (Math.floor(Math.max(ba.x0, bb.x0) / CELL) !== cgx) continue;
            if (Math.floor(Math.max(ba.y0, bb.y0) / CELL) !== cgy) continue;
            const va = [s.index[3 * a]!, s.index[3 * a + 1]!, s.index[3 * a + 2]!];
            const vb = [s.index[3 * b]!, s.index[3 * b + 1]!, s.index[3 * b + 2]!];
            if (va.some((v) => vb.includes(v))) continue;
            const tri = (t: number): V3[] => [0, 1, 2].map((e) => {
              const v = s.index[3 * t + e]!;
              return [s.pos[3 * v]!, s.pos[3 * v + 1]!, s.pos[3 * v + 2]!] as V3;
            });
            const len = triTriCross(tri(a), tri(b), EPS);
            if (len <= MINLEN) continue;
            total += len;
            if (!worstAt) {
              const v0 = s.index[3 * a]!;
              worstAt = `(${s.pos[3 * v0]!.toFixed(3)},${s.pos[3 * v0 + 1]!.toFixed(3)},` +
                `${(s.pos[3 * v0 + 2]! / PAPER.epsilon).toFixed(1)}ε)`;
            }
          }
        }
      }
      const budget = BUDGET[demo.name] ?? 1;
      expect(total / PAPER.epsilon, `layers cross for ${(total / PAPER.epsilon).toFixed(2)}ε ` +
        `in total (budget ${budget}ε), first near ${worstAt}`).toBeLessThan(budget);
    }, 120000);
  }
});

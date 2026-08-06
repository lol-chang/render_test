/**
 * A DRAPE FALLS IN ONE MOTION.
 *
 * Where a sheet crosses the edge of the pile beneath it, the paper leaves the upper plate,
 * bends once, and settles onto the lower one. Its cross section is therefore a single S: flat
 * where it meets each plate, steepest somewhere in between, and never flat again in the middle.
 *
 * Getting that wrong does not break any of the other contracts — the plates stay exact, no
 * layer crosses another, nothing hangs past the outline — but it is the defect a viewer sees.
 * An earlier build gave each half of the drape its own profile, flat at the plate AND flat at
 * the split line; a skewed drape then came out as a TERRACE, a shelf at the fold with a cliff
 * beside it, and the eye reads a terrace on a folded sheet as a wrinkle. The two halves are
 * joined with a shared slope now (see `stepW`), so the fall is one curve.
 *
 * The test walks the drawn top surface across each split and demands the slope rise to one peak
 * and fall away — no interior slack. Measured on the terraced build the cup's worst drape
 * slackened to 0.03 of its peak in the middle; it now holds above 0.5.
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { buildModel, type BuildOptions } from '../src/build3d.js';
import { demos } from '../src/demos.js';
import type { FaceId, FoldedState } from '@origami/core';

const PAPER: BuildOptions = { epsilon: 0.006 };

interface Surface {
  pos: Float32Array;
  index: ArrayLike<number>;
  tris: number;
}

function surfaceOf(state: FoldedState, opts: BuildOptions): Surface {
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

/** Height of the highest paper over (x, y), or null if the model does not cover it. */
function topAt(s: Surface, x: number, y: number): number | null {
  let top = -Infinity;
  for (let t = 0; t < s.tris; t++) {
    const a = s.index[3 * t]!, b = s.index[3 * t + 1]!, c = s.index[3 * t + 2]!;
    const ax = s.pos[3 * a]!, ay = s.pos[3 * a + 1]!;
    const bx = s.pos[3 * b]!, by = s.pos[3 * b + 1]!;
    const cx = s.pos[3 * c]!, cy = s.pos[3 * c + 1]!;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-16) continue;
    const w1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const w2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
    const z = w1 * s.pos[3 * a + 2]! + w2 * s.pos[3 * b + 2]! + w3 * s.pos[3 * c + 2]!;
    if (z > top) top = z;
  }
  return top === -Infinity ? null : top;
}

describe('a drape falls in one motion', () => {
  for (const demo of demos()) {
    it(demo.name, () => {
      const state = demo.states[demo.states.length - 1]!;
      const s = surfaceOf(state, PAPER);
      const level = new Map<FaceId, number>();
      for (const sp of state.spots.values()) sp.stack.forEach((id, i) => level.set(id, i * PAPER.epsilon));

      const REACH = 0.05;      // past the widest band a drape may claim
      const N = 40;
      const slack: string[] = [];
      for (const e of state.edges.values()) {
        const [fa, fb] = e.faces;
        if (fb === null || e.kind !== 'SPLIT') continue;
        const la = level.get(fa) ?? 0, lb = level.get(fb) ?? 0;
        if (Math.abs(la - lb) < 1e-12) continue;
        const f = state.faces.get(fa)!;
        const fold = (x: number, y: number) => ({
          x: f.T.m[0][0].toNumber() * x + f.T.m[0][1].toNumber() * y + f.T.t.x.toNumber(),
          y: f.T.m[1][0].toNumber() * x + f.T.m[1][1].toNumber() * y + f.T.t.y.toNumber(),
        });
        const A = fold(e.srcSeg[0].x.toNumber(), e.srcSeg[0].y.toNumber());
        const B = fold(e.srcSeg[1].x.toNumber(), e.srcSeg[1].y.toNumber());
        const len = Math.hypot(B.x - A.x, B.y - A.y);
        if (len < 1e-9) continue;
        const nx = -(B.y - A.y) / len, ny = (B.x - A.x) / len;

        // sample where the split is RUNNING: its ends meet other folds, and the profile there
        // belongs to the junction, not to this drape
        for (const frac of [0.4, 0.5, 0.6]) {
          const mx = A.x + (B.x - A.x) * frac, my = A.y + (B.y - A.y) * frac;
          const z: number[] = [];
          let ok = true;
          for (let i = 0; i <= N && ok; i++) {
            const u = -REACH + (2 * REACH * i) / N;
            const h = topAt(s, mx + u * nx, my + u * ny);
            if (h === null) ok = false; else z.push(h);
          }
          if (!ok) continue;
          const drop = Math.abs(z[z.length - 1]! - z[0]!);
          if (drop < 1.5 * PAPER.epsilon) continue;      // too shallow to judge
          // ONE motion means the fall speeds up to a single peak and slows again — the slope
          // profile is unimodal. A terrace shows as a SECOND hump: walking away from the peak,
          // the fall slackens into the shelf and then picks up again. How far it picks back up
          // is the defect's size, so that is what is measured.
          const sign = Math.sign(z[z.length - 1]! - z[0]!);
          const rise = z.slice(1).map((v, i) => (v - z[i]!) * sign);
          const peak = Math.max(...rise);
          if (peak <= 0) continue;
          const iPeak = rise.indexOf(peak);
          let hump = 0;
          for (const dir of [-1, 1]) {
            let m = peak;
            for (let i = iPeak + dir; i >= 0 && i < rise.length; i += dir) {
              m = Math.min(m, rise[i]!);
              hump = Math.max(hump, rise[i]! - m);
            }
          }
          if (hump > 0.2 * peak) {
            slack.push(`drape ${(drop / PAPER.epsilon).toFixed(1)}ε at ` +
              `(${mx.toFixed(3)},${my.toFixed(3)}) falls in two: second hump is ` +
              `${((hump / peak) * 100).toFixed(0)}% of the peak`);
          }
        }
      }
      expect(slack.slice(0, 4)).toEqual([]);
    }, 120000);
  }
});

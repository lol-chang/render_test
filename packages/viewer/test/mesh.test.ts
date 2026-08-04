/**
 * What the renderer has to get right, measured rather than eyeballed.
 *
 * The contract is sharp now, because the renderer no longer simulates anything: the ENGINE
 * places the paper and the renderer only rounds off the joins. So:
 *
 *   1. THE RENDER IS THE VERIFIED STATE. Every point of paper more than a join's width from a
 *      join sits at exactly `T(p)` horizontally and exactly `level × ε` vertically — not
 *      approximately, to the last decimal float32 can hold. The previous, physically simulated
 *      build could never have passed this: there the layers drifted from where the engine put
 *      them, the drift accumulated fold over fold, and pinning it broke something else.
 *   2. THE SHEET IS UNBROKEN. One mesh, so a hole is impossible by construction, but refinement
 *      could still split one triangle and not its neighbour and leave a vertex hanging in the
 *      middle of an edge. Interior edges must be used by exactly two triangles; an edge used
 *      once has to be on the square's outline, which the uv attribute settles exactly.
 *   3. THE ROUNDING STAYS LOCAL. A join's curve may only move paper about as far as the join is
 *      deep. This is what stops a "pretty" curve from quietly becoming the model.
 *
 * Inside a band the paper does stretch — a curve is longer than the chord it replaces, and the
 * band has to reach from the plate out to a rim sitting on the fold line. That is the trade this
 * design makes deliberately, in exchange for (1); it is bounded, not hidden.
 */
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { buildModel, type BuildOptions } from '../src/build3d.js';
import { demos } from '../src/demos.js';
import type { Face, FaceId, FoldedState } from '@origami/core';

const PAPER: BuildOptions = { epsilon: 0.006 };
const THIN: BuildOptions = { epsilon: 0.002 };
/**
 * What the Explode preset actually hands the renderer (see `epsFor` in main.ts): the layer gap
 * is chosen to bound the WHOLE stack, not just the gap, because one sheet can run from level 0
 * to level 6 and every layer of separation is a wall that sheet has to climb.
 */
const explodedFor = (state: FoldedState): BuildOptions => {
  let depth = 1;
  for (const sp of state.spots.values()) depth = Math.max(depth, sp.stack.length - 1);
  return { epsilon: Math.min(0.03, 0.12 / depth) };
};

interface Sheet {
  pos: Float32Array;    // as drawn, 3 per vertex
  uv: Float32Array;     // material position, 2 per vertex
  settled: Uint8Array;  // 1 where the renderer claims the engine's exact position
  index: ArrayLike<number>;
  tris: number;
  V: number;
}
function sheetOf(state: FoldedState, opts: BuildOptions): Sheet {
  const built = buildModel(state, opts);
  const meshes: THREE.Mesh[] = [];
  built.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const g = meshes[0]!.geometry;
  const pos = g.getAttribute('position').array as Float32Array;
  return {
    pos,
    uv: g.getAttribute('uv').array as Float32Array,
    settled: built.settled,
    index: g.getIndex()!.array,
    tris: g.getIndex()!.count / 3,
    V: pos.length / 3,
  };
}

/** Edge use counts, keyed by the vertex pair. */
function edgeUse(s: Sheet): Map<number, { a: number; b: number; n: number }> {
  const use = new Map<number, { a: number; b: number; n: number }>();
  for (let t = 0; t < s.tris; t++) {
    for (let e = 0; e < 3; e++) {
      const a = s.index[3 * t + e]!, b = s.index[3 * t + ((e + 1) % 3)]!;
      const k = Math.min(a, b) * 1e7 + Math.max(a, b);
      const rec = use.get(k);
      if (rec) rec.n++; else use.set(k, { a, b, n: 1 });
    }
  }
  return use;
}

/**
 * How far a join's curve can reach into the paper: a U-turn takes π·Δz/4 of material from each
 * side, a drape three times its own drop, and the deepest either can be is the whole stack.
 */
function bandOf(state: FoldedState, opts: BuildOptions): number {
  let stack = 1;
  for (const sp of state.spots.values()) stack = Math.max(stack, sp.stack.length);
  return 3 * stack * opts.epsilon + 0.01;
}

/** Where the ENGINE says a material point goes: its face's isometry, and its stack index × ε. */
function exactPlacer(state: FoldedState, eps: number) {
  const level = new Map<string, number>();
  for (const sp of state.spots.values()) sp.stack.forEach((id, i) => level.set(id, i));
  const faces = [...state.faces.values()].map((f: Face) => ({
    m: [f.T.m[0][0].toNumber(), f.T.m[0][1].toNumber(), f.T.m[1][0].toNumber(), f.T.m[1][1].toNumber()],
    t: [f.T.t.x.toNumber(), f.T.t.y.toNumber()],
    poly: f.srcPoly.map((p) => ({ x: p.x.toNumber(), y: p.y.toNumber() })),
    z: (level.get(f.id) ?? 0) * eps,
  }));
  return (x: number, y: number): { x: number; y: number; z: number } | null => {
    for (const { m, t, poly, z } of faces) {
      let pos = false, neg = false;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        const s = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
        if (s > 1e-9) pos = true; else if (s < -1e-9) neg = true;
      }
      if (pos && neg) continue;
      return { x: m[0]! * x + m[1]! * y + t[0]!, y: m[2]! * x + m[3]! * y + t[1]!, z };
    }
    return null;
  };
}

describe('the render IS the verified state', () => {
  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['exploded', explodedFor], ['thin', () => THIN]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state = demo.states[demo.states.length - 1]!;
        const opts = pick(state);
        const s = sheetOf(state, opts);
        const exact = exactPlacer(state, opts.epsilon);
        let worst = 0, at = '', checked = 0;
        for (let v = 0; v < s.V; v++) {
          const mx = s.uv[2 * v]!, my = s.uv[2 * v + 1]!;
          if (!s.settled[v]) continue;             // inside a join's band: the rounding lives here
          const e = exact(mx, my);
          if (!e) continue;
          checked++;
          const off = Math.hypot(s.pos[3 * v]! - e.x, s.pos[3 * v + 1]! - e.y, s.pos[3 * v + 2]! - e.z);
          if (off > worst) { worst = off; at = `(${mx.toFixed(3)},${my.toFixed(3)})`; }
        }
        expect(checked, 'nothing was far enough from a join to check').toBeGreaterThan(10);
        // float32 positions: a millionth of the paper is the storage, not the placement
        expect(worst, `off the engine's position by ${worst.toExponential(2)} at ${at}`).toBeLessThan(1e-6);
      });
    }
  }
});

describe('the sheet is one unbroken surface', () => {
  for (const demo of demos()) {
    it(demo.name, () => {
      const s = sheetOf(demo.states[demo.states.length - 1]!, PAPER);
      const onOutline = (v: number): boolean => {
        const x = s.uv[2 * v]!, y = s.uv[2 * v + 1]!;
        return Math.abs(x) < 1e-6 || Math.abs(x - 1) < 1e-6 || Math.abs(y) < 1e-6 || Math.abs(y - 1) < 1e-6;
      };
      const bad: string[] = [];
      for (const { a, b, n } of edgeUse(s).values()) {
        if (n === 2) continue;
        if (n > 2) { bad.push(`edge used ${n}×`); continue; }
        if (!onOutline(a) || !onOutline(b)) {
          bad.push(`T-junction at (${s.uv[2 * a]!.toFixed(4)},${s.uv[2 * a + 1]!.toFixed(4)})–` +
            `(${s.uv[2 * b]!.toFixed(4)},${s.uv[2 * b + 1]!.toFixed(4)})`);
        }
      }
      expect(bad.slice(0, 6)).toEqual([]);
    });
  }
});

describe('every layer is drawn at the height the engine assigns it', () => {
  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['exploded', explodedFor]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state = demo.states[demo.states.length - 1]!;
        const opts = pick(state);
        const built = buildModel(state, opts);
        const wrong: string[] = [];
        for (const spot of state.spots.values()) {
          spot.stack.forEach((id, i) => {
            const h = built.heights.get(id);
            if (h === undefined) return;           // face entirely inside a join's band
            const drawn = h / opts.epsilon;
            if (Math.abs(drawn - i) > 1e-4) wrong.push(`${id}: engine ${i}ε, drawn ${drawn.toFixed(4)}ε`);
          });
        }
        expect(wrong.slice(0, 6)).toEqual([]);
      });
    }
  }
});

describe('paper away from a join is not stretched', () => {
  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['exploded', explodedFor], ['thin', () => THIN]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state = demo.states[demo.states.length - 1]!;
        const s = sheetOf(state, pick(state));
        let worst = 0, at = '';
        for (const { a, b } of edgeUse(s).values()) {
          if (!s.settled[a] || !s.settled[b]) continue;
          const rest = Math.hypot(s.uv[2 * a]! - s.uv[2 * b]!, s.uv[2 * a + 1]! - s.uv[2 * b + 1]!);
          if (rest < 1e-9) continue;
          const now = Math.hypot(
            s.pos[3 * a]! - s.pos[3 * b]!,
            s.pos[3 * a + 1]! - s.pos[3 * b + 1]!,
            s.pos[3 * a + 2]! - s.pos[3 * b + 2]!,
          );
          const strain = Math.abs(now - rest) / rest;
          if (strain > worst) { worst = strain; at = `(${s.uv[2 * a]!.toFixed(3)},${s.uv[2 * a + 1]!.toFixed(3)})`; }
        }
        expect(worst, `strain ${(worst * 100).toFixed(4)}% at ${at}`).toBeLessThan(1e-4);
      });
    }
  }
});

/**
 * THE PAPER MUST NOT CRUMPLE. Origami paper is stiff: a triangle's area on screen should be the
 * area it had on the flat square. Length alone does not catch this — a triangle can keep all
 * three edge lengths and still be sheared into a spike.
 *
 * Stretch is what shows: paper pulled thin reads as a rip. Compression does not — the surface a
 * compressed band draws is the same clean curve, just sampled more densely. So this bounds
 * stretch, and bounds how much of the sheet may carry any.
 *
 * It was the check that found the two real defects in this construction: per-face height
 * corrections that disagreed across a shared crease (118× on the cup — the paper visibly
 * ripping at every crease crossing), and a smoothstep height profile that stalls at the crease
 * and crushed the paper into the fold by 300×.
 *
 * Not at the Explode preset. There the layers are deliberately far enough apart that a join has
 * to stretch to span the gap — that is the exaggeration, not a defect. What must still hold at
 * Explode is that the PLATES keep their shape, and two tests that do run there say so: every
 * settled vertex is at the engine's exact position, and paper outside a join is unstretched.
 */
describe('the paper does not crumple', () => {
  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['thin', () => THIN]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state0 = demo.states[demo.states.length - 1]!;
        const s = sheetOf(state0, pick(state0));
        let worst = 0, at = '', stretchedArea = 0, total = 0;
        for (let t = 0; t < s.tris; t++) {
          const a = s.index[3 * t]!, b = s.index[3 * t + 1]!, c = s.index[3 * t + 2]!;
          const ax = s.uv[2 * a]!, ay = s.uv[2 * a + 1]!;
          const rest = Math.abs((s.uv[2 * b]! - ax) * (s.uv[2 * c + 1]! - ay)
            - (s.uv[2 * b + 1]! - ay) * (s.uv[2 * c]! - ax)) / 2;
          if (rest < 1e-12) continue;
          const u = [0, 1, 2].map((k) => s.pos[3 * b + k]! - s.pos[3 * a + k]!);
          const v = [0, 1, 2].map((k) => s.pos[3 * c + k]! - s.pos[3 * a + k]!);
          const now = Math.hypot(
            u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!,
          ) / 2;
          const r = now / rest;
          total += rest;
          if (r > 1.5) stretchedArea += rest;
          if (r > worst) { worst = r; at = `(${ax.toFixed(3)},${ay.toFixed(3)})`; }
        }
        // the residue sits where two creases cross, in a patch a fraction of a millimetre across
        expect(worst, `stretched ${worst.toFixed(1)}× at ${at}`).toBeLessThan(8);
        expect(stretchedArea / total, 'share of the sheet stretched past 1.5×').toBeLessThan(0.002);
      });
    }
  }
});

/**
 * THE FOLDED EDGE IS WHERE THE ENGINE PUT IT. The plates being exact says nothing about the
 * folded edges BETWEEN them, and those are what a folded model is mostly made of: seen from
 * above, the whole silhouette is fold rims. A turn drawn round a centre one band-width in from
 * the fold line puts every rim short of that line, by a different amount per layer — the edges
 * of a folded flap and the sheet under it visibly fail to meet — and being short is an outward
 * push, so where a crease runs out at the sheet's border it flicks the corner past that border
 * and hangs a sliver of paper off the model. Centring each turn one OWN radius in fixes both:
 * the rim lands on the line, and no part of the band reaches past it.
 *
 * So: no paper anywhere may be drawn outside the outline the engine computed. The residue is
 * the smooth tail of a join's fade at a corner, well under one layer gap.
 */
describe('no paper hangs past the outline the engine computed', () => {
  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['exploded', explodedFor], ['thin', () => THIN]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state = demo.states[demo.states.length - 1]!;
        const opts = pick(state);
        const s = sheetOf(state, opts);
        const polys = [...state.faces.values()].map((f: Face) => f.srcPoly.map((p) => {
          const x = p.x.toNumber(), y = p.y.toNumber();
          return {
            x: f.T.m[0][0].toNumber() * x + f.T.m[0][1].toNumber() * y + f.T.t.x.toNumber(),
            y: f.T.m[1][0].toNumber() * x + f.T.m[1][1].toNumber() * y + f.T.t.y.toNumber(),
          };
        }));
        /** How far (x, y) lies outside every face's exact folded polygon; 0 if inside one. */
        const outside = (x: number, y: number): number => {
          let best = Infinity;
          for (const poly of polys) {
            let pos = false, neg = false, d = Infinity;
            for (let i = 0; i < poly.length; i++) {
              const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
              const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
              if (cross > 1e-9) pos = true; else if (cross < -1e-9) neg = true;
              const ex = b.x - a.x, ey = b.y - a.y, ee = ex * ex + ey * ey;
              let t = ee > 1e-30 ? ((x - a.x) * ex + (y - a.y) * ey) / ee : 0;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              d = Math.min(d, Math.hypot(x - (a.x + t * ex), y - (a.y + t * ey)));
            }
            if (!(pos && neg)) return 0;
            best = Math.min(best, d);
          }
          return best;
        };
        let worst = 0, at = '';
        for (let v = 0; v < s.V; v++) {
          const d = outside(s.pos[3 * v]!, s.pos[3 * v + 1]!);
          if (d > worst) { worst = d; at = `(${s.pos[3 * v]!.toFixed(3)},${s.pos[3 * v + 1]!.toFixed(3)})`; }
        }
        expect(worst / opts.epsilon, `${(worst / opts.epsilon).toFixed(2)} layer gaps past the outline at ${at}`)
          .toBeLessThan(0.25);

        // ...and none of it falls SHORT either. A fold rim drawn inside the line is the same
        // defect from the other side, and on a model whose silhouette is mostly rims it is the
        // one you see: the flap and the sheet under it stop at different places.
        const ext = [Infinity, -Infinity, Infinity, -Infinity];    // exact  x0 x1 y0 y1
        const got = [Infinity, -Infinity, Infinity, -Infinity];    // drawn
        for (const poly of polys) for (const p of poly) {
          ext[0] = Math.min(ext[0]!, p.x); ext[1] = Math.max(ext[1]!, p.x);
          ext[2] = Math.min(ext[2]!, p.y); ext[3] = Math.max(ext[3]!, p.y);
        }
        for (let v = 0; v < s.V; v++) {
          const x = s.pos[3 * v]!, y = s.pos[3 * v + 1]!;
          got[0] = Math.min(got[0]!, x); got[1] = Math.max(got[1]!, x);
          got[2] = Math.min(got[2]!, y); got[3] = Math.max(got[3]!, y);
        }
        const short = Math.max(got[0]! - ext[0]!, ext[1]! - got[1]!, got[2]! - ext[2]!, ext[3]! - got[3]!);
        expect(short / opts.epsilon, `drawn ${(short / opts.epsilon).toFixed(2)} layer gaps short of ` +
          `[${ext.map((v) => v.toFixed(3)).join(', ')}]`).toBeLessThan(0.25);
      });
    }
  }
});

/**
 * EVERY FOLD RIM LANDS ON ITS FOLD LINE. The rim of a turn — how far the paper actually reaches
 * round the outside of the bend — is what a folded model shows from above, and the plates being
 * exact says nothing about it. The engine says the paper ends at the fold line, so that is where
 * every turn's rim belongs, whatever else is folded at the same line.
 *
 * Two ways to pull a rim off that line, both of which show:
 *
 *  · centre the turn at the far side of its band. Then every rim is short by δ − r, a different
 *    amount per layer, so a flap and the sheet under it stop at visibly different places — and
 *    short is an outward push, so a crease running out at the sheet's border flicks the corner
 *    past it.
 *  · centre a turn on the widest turn ENCLOSING it. The layers come out concentric, which is
 *    truer to real paper, but it sets each inner rim back by the difference of the radii — 3ε on
 *    the cup — and reads as the outer layer wrapping round the side of the stack while the inner
 *    fold stops short of the line. This build does not do it (see `joinsOf`).
 *
 * So: every turn's rim reaches its fold line, nested or not; and along a fold that runs border to
 * border the rim does not move, since a fold's cross section at the sheet's border is the same
 * cross section as in the middle.
 */
describe('every fold rim lands on its fold line', () => {
  interface Turn { key: string; r: number; lo: number; hi: number; rim: number[]; open: boolean }

  const turnsOf = (state: FoldedState, opts: BuildOptions): Turn[] => {
    const s = sheetOf(state, opts);
    const level = new Map<FaceId, number>();
    for (const sp of state.spots.values()) sp.stack.forEach((id, i) => level.set(id, i));
    const BINS = 8;
    const out: Turn[] = [];
    for (const e of state.edges.values()) {
      const [ida, idb] = e.faces;
      if (e.kind !== 'CREASE' || idb === null) continue;
      const za = (level.get(ida) ?? 0) * opts.epsilon, zb = (level.get(idb) ?? 0) * opts.epsilon;
      if (Math.abs(za - zb) < 1e-12) continue;
      const f = state.faces.get(ida)!;
      const at = (x: number, y: number) => ({
        x: f.T.m[0][0].toNumber() * x + f.T.m[0][1].toNumber() * y + f.T.t.x.toNumber(),
        y: f.T.m[1][0].toNumber() * x + f.T.m[1][1].toNumber() * y + f.T.t.y.toNumber(),
      });
      const a = { x: e.srcSeg[0].x.toNumber(), y: e.srcSeg[0].y.toNumber() };
      const b = { x: e.srcSeg[1].x.toNumber(), y: e.srcSeg[1].y.toNumber() };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      // the crease's folded image, and which side of it holds the paper
      const la = at(a.x, a.y), lb = at(b.x, b.y);
      let nx = -(lb.y - la.y), ny = lb.x - la.x;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      const c = nx * la.x + ny * la.y;
      let cx = 0, cy = 0;
      for (const p of f.srcPoly) { cx += p.x.toNumber(); cy += p.y.toNumber(); }
      const mid = at(cx / f.srcPoly.length, cy / f.srcPoly.length);
      const sgn = nx * mid.x + ny * mid.y - c >= 0 ? 1 : -1;

      const rim = new Array<number>(BINS).fill(Infinity);
      for (let v = 0; v < s.V; v++) {
        const mx = s.uv[2 * v]!, my = s.uv[2 * v + 1]!;
        const t = (mx - a.x) * dx + (my - a.y) * dy;
        if (t < 0 || t > len) continue;
        if (Math.abs((mx - a.x) * -dy + (my - a.y) * dx) > 1e-4) continue;   // material ON the crease
        const k = Math.min(BINS - 1, Math.floor((t / len) * BINS));
        rim[k] = Math.min(rim[k]!, sgn * (nx * s.pos[3 * v]! + ny * s.pos[3 * v + 1]! - c));
      }
      const onEdge = (p: { x: number; y: number }): boolean =>
        Math.abs(p.x) < 1e-9 || Math.abs(p.x - 1) < 1e-9 || Math.abs(p.y) < 1e-9 || Math.abs(p.y - 1) < 1e-9;
      out.push({
        key: `${rnd(nx)},${rnd(ny)},${rnd(c)}`,
        r: Math.abs(za - zb) / 2,
        lo: Math.min(za, zb), hi: Math.max(za, zb),
        rim: rim.filter((v) => v !== Infinity),
        // a fold that runs border to border meets nothing, so nothing may vary along it
        open: onEdge(a) && onEdge(b),
      });
    }
    return out;
  };
  const rnd = (v: number): number => Math.round(v * 1e6) / 1e6;

  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['exploded', explodedFor], ['thin', () => THIN]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state = demo.states[demo.states.length - 1]!;
        const opts = pick(state);
        const turns = turnsOf(state, opts).filter((t) => t.rim.length > 0);
        const tol = 0.05 * opts.epsilon;
        const wrong: string[] = [];
        // compare rims where the fold is RUNNING: a crease that ends inside the paper is faded
        // out over its last band-width by design (that is what keeps a crossing from tearing),
        // and those end bins say nothing about how the turns nest.
        const running = (t: Turn): number[] => {
          const m = t.rim.slice(Math.floor(t.rim.length / 4), Math.ceil((3 * t.rim.length) / 4));
          return m.length ? m : t.rim;
        };
        for (const t of turns) {
          const inner = Math.min(...running(t)), outer = Math.max(...t.rim);
          // its rim IS the fold line — whether or not another turn on the same line encloses it
          if (inner > tol) {
            const nested = turns.some((o) =>
              o !== t && o.key === t.key && o.lo <= t.lo + 1e-12 && o.hi >= t.hi - 1e-12 && o.r > t.r + 1e-12);
            wrong.push(`${nested ? 'nested' : 'free'} turn r=${(t.r / opts.epsilon).toFixed(1)}ε sits ` +
              `${(inner / opts.epsilon).toFixed(2)}ε inside the line`);
          }
          // a fold that runs right across the sheet keeps one rim the whole way
          if (t.open && outer - inner > tol) {
            wrong.push(`rim of r=${(t.r / opts.epsilon).toFixed(1)}ε wanders ${((outer - inner) / opts.epsilon).toFixed(2)}ε along an open fold`);
          }
        }
        expect(wrong.slice(0, 6)).toEqual([]);
      });
    }
  }
});

/**
 * THE PAPER IS NOT DRAWN INSIDE OUT. The sheet carries a front skin and a back skin — the source
 * square's +z side is red, its other side is white — and which one a viewer sees is decided by
 * the triangle's own orientation. So a triangle whose orientation disagrees with its material's,
 * once the face's own mirror flag is accounted for, is drawn wrong side out: a red speck sitting
 * on the white back of the paper, and the first thing anyone notices in a screenshot.
 *
 * They come from the sideways lean. Two crossing joins both reach the paper between them, each
 * pushing in its own direction, and each one's weight ramps 0 → 1 over a band width along its own
 * crease. Where one band is saturated and the other is mid-ramp, the shear that leaves can turn
 * the local map over. Measured, that is where every one of them sits, at 45° crossings.
 *
 * Leaning by the AVERAGE rather than the sum removed 40% of them (and lowered the crumple with
 * it). The rest need a longer fade ramp, which trades directly against stretch — 2.75 band widths
 * clears them and puts the cup's crumple exactly on its own limit — so this bounds the residue
 * instead of claiming zero, and stops it growing back.
 */
describe('the paper is not drawn inside out', () => {
  for (const demo of demos()) {
    for (const [label, pick] of [['paper', () => PAPER], ['thin', () => THIN]] as const) {
      it(`${demo.name} — ${label}`, () => {
        const state = demo.states[demo.states.length - 1]!;
        const opts = pick(state);
        const s = sheetOf(state, opts);
        // each face's mirror flag, by material point: a face folded over draws its back to +z
        const faces = [...state.faces.values()].map((f: Face) => ({
          poly: f.srcPoly.map((p) => ({ x: p.x.toNumber(), y: p.y.toNumber() })),
          det: f.T.m[0][0].toNumber() * f.T.m[1][1].toNumber()
            - f.T.m[0][1].toNumber() * f.T.m[1][0].toNumber(),
        }));
        const detAt = (x: number, y: number): number => {
          for (const { poly, det } of faces) {
            let pos = false, neg = false;
            for (let i = 0; i < poly.length; i++) {
              const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
              const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
              if (c > 1e-9) pos = true; else if (c < -1e-9) neg = true;
            }
            if (!(pos && neg)) return det;
          }
          return 0;
        };
        let wrongArea = 0, total = 0, at = '';
        for (let t = 0; t < s.tris; t++) {
          const a = s.index[3 * t]!, b = s.index[3 * t + 1]!, c = s.index[3 * t + 2]!;
          const ax = s.uv[2 * a]!, ay = s.uv[2 * a + 1]!;
          const bx = s.uv[2 * b]!, by = s.uv[2 * b + 1]!;
          const cx = s.uv[2 * c]!, cy = s.uv[2 * c + 1]!;
          const rest = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
          if (Math.abs(rest) < 1e-14) continue;
          total += Math.abs(rest);
          const u = [0, 1, 2].map((k) => s.pos[3 * b + k]! - s.pos[3 * a + k]!);
          const v = [0, 1, 2].map((k) => s.pos[3 * c + k]! - s.pos[3 * a + k]!);
          const nz = u[0]! * v[1]! - u[1]! * v[0]!;
          const area = Math.hypot(
            u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
          // paper standing on edge inside a turn is genuinely vertical; only judge what faces up
          if (area <= 1e-18 || Math.abs(nz) / area <= 0.2) continue;
          const det = detAt((ax + bx + cx) / 3, (ay + by + cy) / 3);
          if (det !== 0 && Math.sign(nz) !== Math.sign(rest) * Math.sign(det)) {
            wrongArea += Math.abs(rest);
            if (!at) at = `(${((ax + bx + cx) / 3).toFixed(3)},${((ay + by + cy) / 3).toFixed(3)})`;
          }
        }
        expect(wrongArea / total * 1e6, `${(wrongArea / total * 1e6).toFixed(1)} ppm of the sheet ` +
          `drawn inside out${at ? `, from ${at}` : ''}`).toBeLessThan(40);
      });
    }
  }
});

describe('the rounding stays local', () => {
  for (const demo of demos()) {
    it(demo.name, () => {
      const state = demo.states[demo.states.length - 1]!;
      const s = sheetOf(state, PAPER);
      const exact = exactPlacer(state, PAPER.epsilon);
      const band = bandOf(state, PAPER);
      let worst = 0, at = '';
      for (let v = 0; v < s.V; v++) {
        const e = exact(s.uv[2 * v]!, s.uv[2 * v + 1]!);
        if (!e) continue;
        const off = Math.hypot(s.pos[3 * v]! - e.x, s.pos[3 * v + 1]! - e.y, s.pos[3 * v + 2]! - e.z);
        if (off > worst) { worst = off; at = `(${s.uv[2 * v]!.toFixed(3)},${s.uv[2 * v + 1]!.toFixed(3)})`; }
      }
      expect(worst / band, `moved ${(worst / band).toFixed(2)}× the join depth at ${at}`).toBeLessThan(1);
    });
  }
});

describe('the fold animates onto the committed state', () => {
  for (const demo of demos()) {
    it(demo.name, () => {
      const state = demo.states[demo.states.length - 1]!;
      const built = buildModel(state, PAPER);
      if (!built.animatable) return;
      const meshes: THREE.Mesh[] = [];
      built.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      const attr = meshes[0]!.geometry.getAttribute('position');
      const still = Float32Array.from(attr.array as Float32Array);
      for (const t of [0, 0.3, 0.7]) {
        built.setProgress(t);
        for (const x of attr.array as Float32Array) expect(Number.isFinite(x)).toBe(true);
      }
      // t = 1 reproduces the committed build exactly — nothing is left to snap to
      built.setProgress(1);
      const end = attr.array as Float32Array;
      let worst = 0;
      for (let i = 0; i < still.length; i++) worst = Math.max(worst, Math.abs(end[i]! - still[i]!));
      expect(worst).toBeLessThan(1e-6);
    });
  }
});

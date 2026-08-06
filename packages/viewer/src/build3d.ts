import * as THREE from 'three';
import type { FoldedState, Face, FaceId, Iso, Vec2 } from '@origami/core';
import { compose, invert, isoEq } from '@origami/core';

export const FRONT_COLOR = 0xd94f5c;
export const BACK_COLOR = 0xf3f1ea;
const LINE_COLOR = 0x2b2f36;
const PENDING_COLOR = 0x2d6cdf;

export interface BuildOptions {
  epsilon: number;
}

export interface Built {
  object: THREE.Group;
  center: THREE.Vector3;
  extent: number;
  heights: Map<FaceId, number>;
  settled: Uint8Array;
  animatable: boolean;
  setProgress(t: number): void;
}

interface P2 { x: number; y: number }
interface Line2 { nx: number; ny: number; c: number }

const MAX_CELLS = 1200;
const MAX_VERTS = 90000;
const REFINE_ROUNDS = 7;
const DRAPE_REACH = 3;
const JOIN_CAP = 0.04;
const FADE_RAMP = 3;

const rnd9 = (v: number): number => Math.round(v * 1e9) / 1e9;
const numOf = (v: Vec2): P2 => ({ x: v.x.toNumber(), y: v.y.toNumber() });
const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function polyArea(p: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]!;
    s += p[i]!.x * q.y - q.x * p[i]!.y;
  }
  return s / 2;
}

function inConvex(poly: readonly P2[], x: number, y: number): boolean {
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const s = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (s > 1e-9) pos = true; else if (s < -1e-9) neg = true;
  }
  return !(pos && neg);
}

function cutConvex(poly: readonly P2[], nx: number, ny: number, c: number): P2[][] {
  const EPS = 1e-9;
  const s = poly.map((p) => nx * p.x + ny * p.y - c);
  if (s.every((v) => v >= -EPS) || s.every((v) => v <= EPS)) return [[...poly]];
  const hi: P2[] = [], lo: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length, si = s[i]!, sj = s[j]!;
    if (si >= -EPS) hi.push(poly[i]!);
    if (si <= EPS) lo.push(poly[i]!);
    if ((si > EPS && sj < -EPS) || (si < -EPS && sj > EPS)) {
      const t = si / (si - sj);
      const p: P2 = {
        x: rnd9(poly[i]!.x + t * (poly[j]!.x - poly[i]!.x)),
        y: rnd9(poly[i]!.y + t * (poly[j]!.y - poly[i]!.y)),
      };
      hi.push(p); lo.push(p);
    }
  }
  return [hi, lo].filter((p) => p.length >= 3 && Math.abs(polyArea(p)) > 1e-12);
}

function exitAlong(poly: readonly P2[], ox: number, oy: number, dx: number, dy: number): number {
  let far = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x, ey = b.y - a.y;
    const cross = ex * dy - ey * dx;
    if (cross >= -1e-12) continue;
    far = Math.min(far, -(ex * (oy - a.y) - ey * (ox - a.x)) / cross);
  }
  return far === Infinity ? 0 : Math.max(0, far);
}

function distSeg(px: number, py: number, a: P2, b: P2): number {
  const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy;
  let t = dd > 1e-30 ? ((px - a.x) * dx + (py - a.y) * dy) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function foldPoint(T: Iso, x: number, y: number): P2 {
  return {
    x: T.m[0][0].toNumber() * x + T.m[0][1].toNumber() * y + T.t.x.toNumber(),
    y: T.m[1][0].toNumber() * x + T.m[1][1].toNumber() * y + T.t.y.toNumber(),
  };
}

function reflectionLine(refl: Iso): Line2 {
  const a = refl.m[0][0].toNumber(), b = refl.m[0][1].toNumber();
  const tx = refl.t.x.toNumber(), ty = refl.t.y.toNumber();
  let nx = -b, ny = a + 1;
  if (Math.hypot(nx, ny) < 1e-9) { nx = 1; ny = 0; }
  const L = Math.hypot(nx, ny);
  nx /= L; ny /= L;
  return { nx, ny, c: (nx * tx + ny * ty) / 2 };
}

interface MeshData {
  V: number;
  mx: Float64Array;
  my: Float64Array;
  cellOf: Int32Array;
  tris: Int32Array;
  triCell: Int32Array;
  cells: P2[][];
}

function lineOf(a: P2, b: P2): Line2 | null {
  let nx = -(b.y - a.y), ny = b.x - a.x;
  const L = Math.hypot(nx, ny);
  if (L < 1e-12) return null;
  nx /= L; ny /= L;
  let c = nx * a.x + ny * a.y;
  if (nx < -1e-12 || (Math.abs(nx) <= 1e-12 && ny < 0)) { nx = -nx; ny = -ny; c = -c; }
  return { nx: rnd9(nx), ny: rnd9(ny), c: rnd9(c) };
}

function arrangement(states: readonly FoldedState[]): P2[][] {
  const lines = new Map<string, Line2>();
  for (const st of states) {
    for (const f of st.faces.values()) {
      const poly = f.srcPoly.map(numOf);
      for (let i = 0; i < poly.length; i++) {
        const l = lineOf(poly[i]!, poly[(i + 1) % poly.length]!);
        if (l) lines.set(`${l.nx},${l.ny},${l.c}`, l);
      }
    }
  }
  let cells: P2[][] = [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]];
  for (const l of lines.values()) {
    const next: P2[][] = [];
    for (const cell of cells) next.push(...cutConvex(cell, l.nx, l.ny, l.c));
    cells = next;
    if (cells.length > MAX_CELLS) break;
  }
  return cells;
}

function bendSegs(states: readonly FoldedState[]): [P2, P2][] {
  const seen = new Map<string, [P2, P2]>();
  for (const st of states) {
    const level = new Map<FaceId, number>();
    for (const sp of st.spots.values()) sp.stack.forEach((id, i) => level.set(id, i));
    for (const e of st.edges.values()) {
      const [fa, fb] = e.faces;
      const step = fb !== null && e.kind === 'SPLIT' && level.get(fa) !== level.get(fb);
      if (e.kind !== 'CREASE' && !step) continue;
      const a = numOf(e.srcSeg[0]), b = numOf(e.srcSeg[1]);
      seen.set(`${rnd9(a.x)},${rnd9(a.y)},${rnd9(b.x)},${rnd9(b.y)}`, [a, b]);
    }
  }
  return [...seen.values()];
}

function tessellate(cells: P2[][], bends: [P2, P2][], fine: number): MeshData {
  const xs: number[] = [], ys: number[] = [], cellOf: number[] = [];
  const key2id = new Map<string, number>();
  const vid = (x: number, y: number, cell: number): number => {
    const k = `${Math.round(x * 1e7)}_${Math.round(y * 1e7)}`;
    let id = key2id.get(k);
    if (id === undefined) { id = xs.length; xs.push(x); ys.push(y); cellOf.push(cell); key2id.set(k, id); }
    return id;
  };

  let tris: number[][] = [];
  cells.forEach((raw, ci) => {
    const poly = polyArea(raw) < 0 ? [...raw].reverse() : raw;
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p.x; cy += p.y; }
    const c = vid(cx / poly.length, cy / poly.length, ci);
    for (let i = 0; i < poly.length; i++) {
      const a = vid(poly[i]!.x, poly[i]!.y, ci);
      const b = vid(poly[(i + 1) % poly.length]!.x, poly[(i + 1) % poly.length]!.y, ci);
      if (a !== b) tris.push([a, b, c, ci]);
    }
  });

  const coarse = 0.11;
  const target = (x: number, y: number): number => {
    let d = Infinity;
    for (const s of bends) { const v = distSeg(x, y, s[0], s[1]); if (v < d) d = v; }
    return Math.min(coarse, fine + 0.45 * d);
  };
  const midCache = new Map<number, number>();
  const mid = (i: number, j: number, cell: number): number => {
    const k = Math.min(i, j) * 1e7 + Math.max(i, j);
    let id = midCache.get(k);
    if (id === undefined) {
      id = vid((xs[i]! + xs[j]!) / 2, (ys[i]! + ys[j]!) / 2, cell);
      midCache.set(k, id);
    }
    return id;
  };
  const ekey = (i: number, j: number): number => Math.min(i, j) * 1e7 + Math.max(i, j);

  for (let round = 0; round < REFINE_ROUNDS && xs.length < MAX_VERTS; round++) {
    const marked = new Set<number>();
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const i = t[e]!, j = t[(e + 1) % 3]!;
        const len = Math.hypot(xs[i]! - xs[j]!, ys[i]! - ys[j]!);
        if (len > target((xs[i]! + xs[j]!) / 2, (ys[i]! + ys[j]!) / 2) * 1.15) marked.add(ekey(i, j));
      }
    }
    if (!marked.size) break;
    const out: number[][] = [];
    for (const t of tris) {
      const [a, b, c, cell] = t as [number, number, number, number];
      const m: boolean[] = [marked.has(ekey(a, b)), marked.has(ekey(b, c)), marked.has(ekey(c, a))];
      const n = (m[0] ? 1 : 0) + (m[1] ? 1 : 0) + (m[2] ? 1 : 0);
      if (n === 0) { out.push(t); continue; }
      if (n === 3) {
        const p = mid(a, b, cell), q = mid(b, c, cell), r = mid(c, a, cell);
        out.push([a, p, r, cell], [p, b, q, cell], [r, q, c, cell], [p, q, r, cell]);
        continue;
      }

      let v: [number, number, number] = [a, b, c];
      for (let k = 0; k < 3; k++) {
        if (n === 1 ? m[0] : m[0] && m[1]) break;
        v = [v[1], v[2], v[0]];
        m.push(m.shift()!);
      }
      const [A, B, C] = v;
      if (n === 1) {
        const p = mid(A, B, cell);
        out.push([A, p, C, cell], [p, B, C, cell]);
      } else {
        const p = mid(A, B, cell), q = mid(B, C, cell);
        out.push([p, B, q, cell], [A, p, q, cell], [A, q, C, cell]);
      }
    }
    tris = out;
  }

  const V = xs.length;
  const data: MeshData = {
    V,
    mx: Float64Array.from(xs),
    my: Float64Array.from(ys),
    cellOf: Int32Array.from(cellOf),
    tris: new Int32Array(tris.length * 3),
    triCell: new Int32Array(tris.length),
    cells,
  };
  tris.forEach((t, i) => {
    data.tris[3 * i] = t[0]!; data.tris[3 * i + 1] = t[1]!; data.tris[3 * i + 2] = t[2]!;
    data.triCell[i] = t[3]!;
  });
  return data;
}

function facesOfCells(state: FoldedState, cells: readonly P2[][]): (Face | null)[] {
  const faces = [...state.faces.values()].map((f) => ({ f, poly: f.srcPoly.map(numOf) }));
  return cells.map((cell) => {
    let cx = 0, cy = 0;
    for (const p of cell) { cx += p.x; cy += p.y; }
    cx /= cell.length; cy /= cell.length;
    for (const { f, poly } of faces) if (inConvex(poly, cx, cy)) return f;
    return null;
  });
}

interface Join {
  kind: 'hinge' | 'step';
  lo: FaceId; hi: FaceId;
  zLo: number; zHi: number;
  delta: number;
  ma: P2; mb: P2;
  len: number;
  fadeA: boolean; fadeB: boolean;
  bulge: number;
  axis: number;
  arc: number;
  nx: number; ny: number;
  la: P2; lb: P2;
  beta: number;
  yieldA: number; yieldB: number;
  sides: { poly: P2[]; ax: number; ay: number }[];
}

const SHARP_MIN = 0.32;
function joinWeight(j: Join, x: number, y: number): { u: number; w: number; t: number; s: number } {
  const dx = (j.mb.x - j.ma.x) / j.len, dy = (j.mb.y - j.ma.y) / j.len;
  const t = (x - j.ma.x) * dx + (y - j.ma.y) * dy;
  const u = Math.abs((x - j.ma.x) * -dy + (y - j.ma.y) * dx);
  const fadeLen = Math.min(FADE_RAMP * j.delta, j.len / 2);
  let g = 1;
  if (j.fadeA) g = Math.min(g, t / fadeLen);
  if (j.fadeB) g = Math.min(g, (j.len - t) / fadeLen);
  const s = SHARP_MIN + (1 - SHARP_MIN) * smoothstep(g < 0 ? 0 : g > 1 ? 1 : g);
  let w = 1;
  if (j.fadeA && t < 0) w = 1 + t / (2 * j.delta * s);
  if (j.fadeB && t > j.len) w = 1 - (t - j.len) / (2 * j.delta * s);
  return { u, w: w <= 0 ? 0 : w >= 1 ? 1 : smoothstep(w), t, s };
}

function roomOf(j: Join, t: number): number {
  const s = Math.max(0, Math.min(j.len, t)) / j.len;
  const ox = j.ma.x + (j.mb.x - j.ma.x) * s, oy = j.ma.y + (j.mb.y - j.ma.y) * s;
  let room = Infinity;
  for (const side of j.sides) room = Math.min(room, exitAlong(side.poly, ox, oy, side.ax, side.ay));
  return room;
}

function holdBelow(a: number, room: number): number {
  if (a <= 0) return a;
  if (room <= 1e-12) return 0;
  const x = a / room;
  return x <= 0.5 ? a : room * (1 - 0.25 / x);
}

function levelsOf(state: FoldedState, eps: number): Map<FaceId, number> {
  const z = new Map<FaceId, number>();
  for (const sp of state.spots.values()) sp.stack.forEach((id, i) => z.set(id, i * eps));
  return z;
}

function joinsOf(state: FoldedState, eps: number, z: ReadonlyMap<FaceId, number>): Join[] {
  interface Raw { e: Join; reach: number }
  const onOutline = (p: P2): boolean =>
    Math.abs(p.x) < 1e-9 || Math.abs(p.x - 1) < 1e-9 || Math.abs(p.y) < 1e-9 || Math.abs(p.y - 1) < 1e-9;
  const ends = (a: P2, b: P2): { len: number; fadeA: boolean; fadeB: boolean } =>
    ({ len: Math.hypot(b.x - a.x, b.y - a.y), fadeA: !onOutline(a), fadeB: !onOutline(b) });
  const raws: Raw[] = [];
  for (const e of state.edges.values()) {
    const [a, b] = e.faces;
    if (b === null) continue;
    const fa = state.faces.get(a), fb = state.faces.get(b);
    if (!fa || !fb) continue;
    const za = z.get(a) ?? 0, zb = z.get(b) ?? 0;
    if (Math.abs(za - zb) < 1e-12) continue;
    const lo = za < zb ? fa : fb, hi = za < zb ? fb : fa;
    const ma = numOf(e.srcSeg[0]), mb = numOf(e.srcSeg[1]);

    let reach = Infinity;
    for (const f of [fa, fb]) {
      let far = 0;
      for (const p of f.srcPoly) far = Math.max(far, distSeg(p.x.toNumber(), p.y.toNumber(), ma, mb));
      reach = Math.min(reach, far);
    }
    const dz = Math.abs(za - zb);

    const seg = { x: mb.x - ma.x, y: mb.y - ma.y };
    const segLen = Math.hypot(seg.x, seg.y) || 1;
    const sides = [fa, fb].map((f) => {
      const raw = f.srcPoly.map(numOf);
      const poly = polyArea(raw) < 0 ? [...raw].reverse() : raw;
      let cx = 0, cy = 0;
      for (const p of poly) { cx += p.x; cy += p.y; }
      cx = cx / poly.length - ma.x; cy = cy / poly.length - ma.y;
      const s = (cx * -seg.y + cy * seg.x) >= 0 ? 1 : -1;
      return { poly, ax: (s * -seg.y) / segLen, ay: (s * seg.x) / segLen };
    });
    if (e.kind === 'CREASE') {
      const la = foldPoint(fa.T, ma.x, ma.y), lb = foldPoint(fa.T, mb.x, mb.y);
      const l = lineOf(la, lb);
      if (!l) continue;
      let cx = 0, cy = 0;
      for (const p of fa.srcPoly) { cx += p.x.toNumber(); cy += p.y.toNumber(); }
      const g = foldPoint(fa.T, cx / fa.srcPoly.length, cy / fa.srcPoly.length);
      const sgn = l.nx * g.x + l.ny * g.y - l.c >= 0 ? 1 : -1;
      raws.push({
        e: {
          kind: 'hinge', lo: lo.id, hi: hi.id, zLo: Math.min(za, zb), zHi: Math.max(za, zb),
          delta: Math.min(Math.PI * dz / 4, JOIN_CAP, 0.3 * reach), bulge: dz / 2,
          axis: dz / 2, arc: 0, sides, la, lb, beta: 1, yieldA: 0, yieldB: 0,
          ma, mb, ...ends(ma, mb), nx: sgn * l.nx, ny: sgn * l.ny,
        },
        reach,
      });
    } else {
      raws.push({
        e: {
          kind: 'step', lo: lo.id, hi: hi.id, zLo: Math.min(za, zb), zHi: Math.max(za, zb),
          delta: Math.min(DRAPE_REACH * dz, JOIN_CAP, 0.3 * reach), bulge: 0,
          axis: 0, arc: Math.min(DRAPE_REACH * dz, JOIN_CAP, 0.3 * reach), sides,
          la: foldPoint(fa.T, ma.x, ma.y), lb: foldPoint(fa.T, mb.x, mb.y), beta: 1, yieldA: 0, yieldB: 0,
          ma, mb, ...ends(ma, mb), nx: 0, ny: 0,
        },
        reach,
      });
    }
  }

  const lineKey = (j: Join): string =>
    `${rnd9(j.nx)},${rnd9(j.ny)},${rnd9(j.nx * j.la.x + j.ny * j.la.y)}`;
  const byLine = new Map<string, Raw[]>();
  for (const r of raws) {
    if (r.e.kind !== 'hinge') continue;
    const k = lineKey(r.e);
    (byLine.get(k) ?? byLine.set(k, []).get(k)!).push(r);
  }

  const spanOf = (j: Join): [number, number] => {
    const dx = -j.ny, dy = j.nx;
    const ta = dx * j.la.x + dy * j.la.y, tb = dx * j.lb.x + dy * j.lb.y;
    return [Math.min(ta, tb), Math.max(ta, tb)];
  };
  for (const r of raws) {
    if (r.e.kind !== 'hinge') continue;
    const R = (r.e.zHi - r.e.zLo) / 2;
    const [t0, t1] = spanOf(r.e);

    let Renc = R;
    for (const s of byLine.get(lineKey(r.e)) ?? []) {
      if (s === r || s.e.kind !== 'hinge') continue;
      if (s.e.zLo <= r.e.zLo && s.e.zHi >= r.e.zHi) {
        const [s0, s1] = spanOf(s.e);
        if (Math.min(t1, s1) - Math.max(t0, s0) <= 1e-9) continue;
        const Rs = (s.e.zHi - s.e.zLo) / 2;
        if (Rs > Renc) Renc = Rs;
      }
    }

    const d = Math.min(Math.max(Math.PI * Renc / 2, Renc), JOIN_CAP, 0.3 * r.reach);
    const scaleEnc = Math.min(1, Renc > 1e-12 ? d / Renc : 1);
    r.e.delta = d;
    r.e.bulge = R * scaleEnc;
    r.e.axis = Renc * scaleEnc;

    const flat = r.e.delta - r.e.axis;
    const round = Math.PI * r.e.bulge / 2;
    r.e.arc = round + flat > 1e-12 ? r.e.delta * round / (round + flat) : r.e.delta;
  }

  const foldedPoly = new Map<FaceId, P2[]>();
  for (const f of state.faces.values()) {
    foldedPoly.set(f.id, f.srcPoly.map((p) => foldPoint(f.T, p.x.toNumber(), p.y.toNumber())));
  }
  for (const r of raws) {
    const j = r.e;
    if (j.kind !== 'step') continue;
    const l = lineOf(j.la, j.lb);
    if (!l) continue;
    const hiPoly = foldedPoly.get(j.hi)!;
    let hx = 0, hy = 0;
    for (const p of hiPoly) { hx += p.x; hy += p.y; }
    const sHi = l.nx * (hx / hiPoly.length) + l.ny * (hy / hiPoly.length) - l.c >= 0 ? 1 : -1;

    const segLen = Math.hypot(j.lb.x - j.la.x, j.lb.y - j.la.y) || 1;
    const trim = Math.min(j.delta, 0.25 * segLen);
    const ux = (j.lb.x - j.la.x) / segLen, uy = (j.lb.y - j.la.y) / segLen;
    const ta2 = { x: j.la.x + trim * ux, y: j.la.y + trim * uy };
    const tb2 = { x: j.lb.x - trim * ux, y: j.lb.y - trim * uy };
    let a = j.zLo, b = j.zHi;
    for (const [id, lvl] of z) {
      if (lvl <= j.zLo + eps / 2 || lvl >= j.zHi - eps / 2) continue;
      if (id === j.lo || id === j.hi) continue;
      const poly = foldedPoly.get(id)!;
      let near = Infinity, cx = 0, cy = 0;
      for (const p of poly) { near = Math.min(near, distSeg(p.x, p.y, ta2, tb2)); cx += p.x; cy += p.y; }
      for (let i = 0; i < poly.length; i++) {
        const q = poly[(i + 1) % poly.length]!;
        near = Math.min(near, distSeg((poly[i]!.x + q.x) / 2, (poly[i]!.y + q.y) / 2, ta2, tb2));
      }
      if (near > j.delta) continue;
      const side = (l.nx * (cx / poly.length) + l.ny * (cy / poly.length) - l.c) * sHi;
      if (side >= -1e-9) a = Math.max(a, lvl);
      if (side <= 1e-9) b = Math.min(b, lvl);
    }
    let z0 = (a + b) / 2;
    if (a > b + 1e-12) {
      const k = Math.round(z0 / eps);
      if (Math.abs(z0 - k * eps) < 0.25 * eps) z0 = (k + 0.5) * eps;
      j.delta = Math.min(j.delta, Math.max(2 * eps, 2.0 * (z0 - j.zLo)));
      j.arc = j.delta;
    }
    z0 = Math.min(Math.max(z0, j.zLo + eps / 4), j.zHi - eps / 4);
    j.beta = (z0 - j.zLo) / (j.zHi - z0);

    const atCorner = (p: P2): number => {
      let s = 0;
      for (const h of raws) {
        if (h.e.kind !== 'hinge') continue;
        for (const q of [h.e.ma, h.e.mb]) {
          if (Math.hypot(p.x - q.x, p.y - q.y) < 1e-7) s = Math.max(s, h.e.delta);
        }
      }
      return s;
    };
    j.yieldA = atCorner(j.ma);
    j.yieldB = atCorner(j.mb);
  }
  return raws.map((r) => r.e).filter((j) => j.delta > 1e-9);
}

function layout(
  state: FoldedState,
  mesh: MeshData,
  faceOf: (Face | null)[],
  eps: number,
): { pos: Float64Array; settled: Uint8Array; z: Map<FaceId, number>; joins: Join[] } {
  const z = levelsOf(state, eps);
  const joins = joinsOf(state, eps, z);
  const byFace = new Map<FaceId, Join[]>();
  for (const j of joins) {
    for (const id of [j.lo, j.hi]) (byFace.get(id) ?? byFace.set(id, []).get(id)!).push(j);
  }

  const sources = [...state.faces.values()].map((f) => ({
    id: f.id,
    poly: f.srcPoly.map(numOf),
    level: z.get(f.id) ?? 0,
    joins: byFace.get(f.id) ?? [],
  }));

  const stepW = (j: Join, srcIsHi: boolean, d: number, mx: number, my: number): number => {
    let beta = j.beta;
    if (beta !== 1 && (j.yieldA > 0 || j.yieldB > 0)) {
      const dxs = (j.mb.x - j.ma.x) / j.len, dys = (j.mb.y - j.ma.y) / j.len;
      const t = (mx - j.ma.x) * dxs + (my - j.ma.y) * dys;
      let f = 1;
      if (j.yieldA > 0) f = Math.min(f, smoothstep(t / (FADE_RAMP * j.yieldA)));
      if (j.yieldB > 0) f = Math.min(f, smoothstep((j.len - t) / (FADE_RAMP * j.yieldB)));
      beta = 1 + (beta - 1) * f;
    }
    const dz = j.zHi - j.zLo;
    const z0 = j.zLo + dz * beta / (1 + beta);
    const a = Math.max(j.arc, 1e-12);
    const pLo = z0 - j.zLo, pHi = j.zHi - z0;
    const p = srcIsHi ? pLo : pHi;
    if (p <= 1e-12) return 0;
    const g = 2 * (srcIsHi ? pHi : pLo) / Math.max(pLo + pHi, 1e-12);
    const u = Math.min(1, d / a);
    const f = g * u + (3 - 2 * g) * u * u + (g - 2) * u * u * u;
    const zp = srcIsHi ? z0 - p * f : z0 + p * f;
    return srcIsHi
      ? (zp - j.zLo) / Math.max(j.zHi - zp, 1e-9)
      : (j.zHi - zp) / Math.max(zp - j.zLo, 1e-9);
  };
  const stepPartner = new Map<FaceId, Set<FaceId>>();
  for (const j of joins) {
    if (j.kind !== 'step') continue;
    (stepPartner.get(j.lo) ?? stepPartner.set(j.lo, new Set()).get(j.lo)!).add(j.hi);
    (stepPartner.get(j.hi) ?? stepPartner.set(j.hi, new Set()).get(j.hi)!).add(j.lo);
  }

  const weigh = (d: number, reach: number): number => {
    if (d >= reach) return 0;
    const s = Math.sin(Math.PI * d / (2 * reach));
    return (1 - s) / (1 + s);
  };
  const distToFace = (poly: P2[], x: number, y: number): number => {
    if (inConvex(poly, x, y)) return 0;
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const v = distSeg(x, y, poly[i]!, poly[(i + 1) % poly.length]!);
      if (v < d) d = v;
    }
    return d;
  };

  const polyOfFace = new Map<FaceId, P2[]>();
  for (const s of sources) polyOfFace.set(s.id, s.poly);
  const ownSide = (j: Join, x: number, y: number): number => {
    const dLo = distToFace(polyOfFace.get(j.lo)!, x, y);
    if (dLo <= 0) return 1;
    const d = Math.min(dLo, distToFace(polyOfFace.get(j.hi)!, x, y));
    return d <= 0 ? 1 : weigh(d, Math.min(j.arc, 1.5 * eps));
  };

  interface Wrap {
    j: Join; nx: number; ny: number; c: number; dx: number; dy: number;
    t0: number; t1: number; mid: number; rz: number; key: string;
  }
  const foldedKey = (j: Join): string =>
    `${rnd9(j.nx)},${rnd9(j.ny)},${rnd9(j.nx * j.la.x + j.ny * j.la.y)}`;
  const wraps: Wrap[] = [];
  for (const j of joins) {
    if (j.kind !== 'hinge' || j.zHi - j.zLo < 1.5 * eps) continue;
    const c = j.nx * j.la.x + j.ny * j.la.y;
    const dx = -j.ny, dy = j.nx;
    const ta = dx * j.la.x + dy * j.la.y, tb = dx * j.lb.x + dy * j.lb.y;
    wraps.push({
      j, nx: j.nx, ny: j.ny, c, dx, dy,
      t0: Math.min(ta, tb), t1: Math.max(ta, tb),
      mid: (j.zLo + j.zHi) / 2, rz: (j.zHi - j.zLo) / 2, key: foldedKey(j),
    });
  }
  const hingeLines = new Map<FaceId, Set<string>>();
  for (const j of joins) {
    if (j.kind !== 'hinge') continue;
    for (const id of [j.lo, j.hi]) {
      (hingeLines.get(id) ?? hingeLines.set(id, new Set()).get(id)!).add(foldedKey(j));
    }
  }
  const TUCK_GAP = 0.25 * eps;

  const pos = new Float64Array(3 * mesh.V);
  const settled = new Uint8Array(mesh.V);
  for (let v = 0; v < mesh.V; v++) {
    const f = faceOf[mesh.cellOf[v]!];
    if (!f) continue;
    const mx = mesh.mx[v]!, my = mesh.my[v]!;
    const p = foldPoint(f.T, mx, my);

    let zSum = 0, wSum = 0, blended = false;
    for (const src of sources) {
      let w = 0;

      if (src.id === f.id) w = 1;
      else if (!stepPartner.get(f.id)?.has(src.id) && distToFace(src.poly, mx, my) === 0) w = 1;
      else {
        for (const j of src.joins) {
          let q: number;
          if (j.kind === 'step') {
            q = stepW(j, src.id === j.hi, distSeg(mx, my, j.ma, j.mb), mx, my);
          } else {
            const jw = joinWeight(j, mx, my);
            q = jw.w * weigh(jw.u, j.arc * jw.s);
          }
          if (q <= w) continue;
          q *= ownSide(j, mx, my);
          if (q > w) w = q;
        }
      }
      if (w <= 0) continue;
      if (src.id !== f.id) blended = true;
      zSum += w * src.level; wSum += w;
    }

    let dx = 0, dy = 0, lean = 0, bent = false;
    for (const j of byFace.get(f.id) ?? []) {
      if (j.kind !== 'hinge') continue;
      const { u, w, t, s } = joinWeight(j, mx, my);
      const deltaS = j.delta * s;
      if (u >= deltaS || w <= 0) continue;
      bent = true;

      const arcS = j.arc * s, axisS = j.axis * s, bulgeS = j.bulge * s;
      const n = u <= arcS
        ? axisS - bulgeS * Math.cos((Math.PI / 2) * (u / arcS))
        : axisS + (u - arcS) * (deltaS - axisS) / (deltaS - arcS);

      const across = holdBelow(n - u, roomOf(j, t) - u);
      dx += w * across * j.nx;
      dy += w * across * j.ny;
      lean += w;
    }

    if (lean > 1) { dx /= lean; dy /= lean; }

    let px = p.x + dx, py = p.y + dy;
    const pz = wSum > 0 ? zSum / wSum : (z.get(f.id) ?? 0);

    let tuck = 0, tx = 0, ty = 0;
    for (const wr of wraps) {
      const j = wr.j;
      if (f.id === j.lo || f.id === j.hi) continue;
      if (pz <= j.zLo + 0.25 * eps || pz >= j.zHi - 0.25 * eps) continue;
      if (hingeLines.get(f.id)?.has(wr.key)) continue;
      const u = wr.nx * px + wr.ny * py - wr.c;
      if (u < -1e-9) continue;
      const t = wr.dx * px + wr.dy * py;
      const fadeLen = Math.min(FADE_RAMP * j.delta, j.len / 2);
      let w = 1;
      if (t < wr.t0) w = j.fadeA ? 0 : 1 - (wr.t0 - t) / j.delta;
      else if (t > wr.t1) w = j.fadeB ? 0 : 1 - (t - wr.t1) / j.delta;
      else {
        if (j.fadeA) w = Math.min(w, (t - wr.t0) / fadeLen);
        if (j.fadeB) w = Math.min(w, (wr.t1 - t) / fadeLen);
      }
      if (w <= 0) continue;
      w = smoothstep(w);
      const s = (pz - wr.mid) / wr.rz;
      const need = j.axis - j.bulge * Math.sqrt(Math.max(0, 1 - s * s)) + TUCK_GAP;
      const push = w * (need - u);
      if (push > tuck) { tuck = push; tx = wr.nx; ty = wr.ny; }
    }
    if (tuck > 1e-12) {
      px += tuck * tx; py += tuck * ty;
      bent = true;
    }

    pos[3 * v] = px;
    pos[3 * v + 1] = py;
    pos[3 * v + 2] = pz;
    if (!bent && !blended) settled[v] = 1;
  }
  return { pos, settled, z, joins };
}

function untangle(
  mesh: MeshData,
  faceOf: (Face | null)[],
  pos: Float64Array,
  settled: Uint8Array,
  eps: number,
  z: ReadonlyMap<FaceId, number>,
  joins: readonly Join[],
): void {
  const GAP = 0.05 * eps;

  const MINSEP = 0.35 * eps;
  const DAMP = 0.6;
  const ROUNDS = 10;
  const CELL = 0.02;
  const nTri = mesh.triCell.length;

  const joined = new Set<string>();
  for (const j of joins) {
    joined.add(j.lo < j.hi ? `${j.lo}|${j.hi}` : `${j.hi}|${j.lo}`);
  }

  interface Tri { ok: boolean; still: boolean; lvl: number; fid: FaceId | null }
  const tris: Tri[] = new Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const f = faceOf[mesh.triCell[t]!];
    const a = mesh.tris[3 * t]!, b = mesh.tris[3 * t + 1]!, c = mesh.tris[3 * t + 2]!;
    tris[t] = {
      ok: !!f,
      still: !!(settled[a] && settled[b] && settled[c]),
      lvl: f ? (z.get(f.id) ?? 0) : 0,
      fid: f ? f.id : null,
    };
  }

  const step = new Float64Array(mesh.V).fill(0.5 * eps);
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.tris[3 * t + e]!, b = mesh.tris[3 * t + ((e + 1) % 3)]!;
      const L = Math.hypot(mesh.mx[a]! - mesh.mx[b]!, mesh.my[a]! - mesh.my[b]!) * 0.4;
      if (L < step[a]!) step[a] = L;
      if (L < step[b]!) step[b] = L;
    }
  }

  const AREA_LIM = 6.5;
  const fan = new Map<number, { b: number; c: number; rest2: number }[]>();
  for (let t = 0; t < nTri; t++) {
    const a = mesh.tris[3 * t]!, b = mesh.tris[3 * t + 1]!, c = mesh.tris[3 * t + 2]!;
    const rest2 = Math.abs(
      (mesh.mx[b]! - mesh.mx[a]!) * (mesh.my[c]! - mesh.my[a]!)
      - (mesh.my[b]! - mesh.my[a]!) * (mesh.mx[c]! - mesh.mx[a]!));
    if (rest2 < 1e-16) continue;
    (fan.get(a) ?? fan.set(a, []).get(a)!).push({ b, c, rest2 });
    (fan.get(b) ?? fan.set(b, []).get(b)!).push({ b: c, c: a, rest2 });
    (fan.get(c) ?? fan.set(c, []).get(c)!).push({ b: a, c: b, rest2 });
  }
  const stretchOK = (v: number, dx2: number, dy2: number, dz2: number): number => {
    let a2 = 1;
    for (const { b, c, rest2 } of fan.get(v) ?? []) {
      const e1x = pos[3 * b]! - pos[3 * c]!, e1y = pos[3 * b + 1]! - pos[3 * c + 1]!, e1z = pos[3 * b + 2]! - pos[3 * c + 2]!;
      const vx = pos[3 * v]! - pos[3 * c]!, vy = pos[3 * v + 1]! - pos[3 * c + 1]!, vz = pos[3 * v + 2]! - pos[3 * c + 2]!;
      const n0 = Math.hypot(vy * e1z - vz * e1y, vz * e1x - vx * e1z, vx * e1y - vy * e1x);
      const g2 = Math.hypot(dy2 * e1z - dz2 * e1y, dz2 * e1x - dx2 * e1z, dx2 * e1y - dy2 * e1x);
      if (g2 < 1e-18) continue;
      const room = AREA_LIM * rest2 - n0;
      if (room <= 0) return 0;
      if (g2 > room) a2 = Math.min(a2, room / g2);
    }
    return a2;
  };

  const bbox = new Float64Array(6 * nTri);
  const push = new Float64Array(3 * mesh.V);
  const pushMag = new Float64Array(mesh.V);
  const colSum = new Float64Array(mesh.V);
  const colW = new Float64Array(mesh.V);
  const moved = new Uint8Array(mesh.V);
  const spent = new Float64Array(mesh.V);
  const pos0 = Float64Array.from(pos);
  const COL = 0.004;
  const colCells = new Set<number>();
  let best: Float64Array | null = null;
  let bestLen = Infinity;
  let firstLen = 0;

  let region: Set<number> | null = null;
  let nextRegion = new Set<number>();

  for (let round = 0; round <= ROUNDS; round++) {
    const buckets = new Map<number, number[]>();
    for (let t = 0; t < nTri; t++) {
      if (!tris[t]!.ok) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let e = 0; e < 3; e++) {
        const v = mesh.tris[3 * t + e]!;
        x0 = Math.min(x0, pos[3 * v]!); x1 = Math.max(x1, pos[3 * v]!);
        y0 = Math.min(y0, pos[3 * v + 1]!); y1 = Math.max(y1, pos[3 * v + 1]!);
        z0 = Math.min(z0, pos[3 * v + 2]!); z1 = Math.max(z1, pos[3 * v + 2]!);
      }
      bbox[6 * t] = x0; bbox[6 * t + 1] = x1; bbox[6 * t + 2] = y0;
      bbox[6 * t + 3] = y1; bbox[6 * t + 4] = z0; bbox[6 * t + 5] = z1;
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const k = gx * 65536 + gy;
          if (region && !region.has(k)) continue;
          (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(t);
        }
      }
    }

    push.fill(0); pushMag.fill(0); colSum.fill(0); colW.fill(0); colCells.clear();
    nextRegion = new Set<number>();
    let found = 0, roundLen = 0, stick = 0;
    for (const [ck, list] of buckets) {
      const cgx = Math.floor(ck / 65536), cgy = ck - cgx * 65536;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i]!, B = list[j]!;
          if (tris[A]!.still && tris[B]!.still) continue;
          if (bbox[6 * A]! > bbox[6 * B + 1]! || bbox[6 * B]! > bbox[6 * A + 1]!) continue;
          if (bbox[6 * A + 2]! > bbox[6 * B + 3]! || bbox[6 * B + 2]! > bbox[6 * A + 3]!) continue;
          if (bbox[6 * A + 4]! > bbox[6 * B + 5]! + MINSEP || bbox[6 * B + 4]! > bbox[6 * A + 5]! + MINSEP) continue;

          if (Math.floor(Math.max(bbox[6 * A]!, bbox[6 * B]!) / CELL) !== cgx) continue;
          if (Math.floor(Math.max(bbox[6 * A + 2]!, bbox[6 * B + 2]!) / CELL) !== cgy) continue;
          const va = [mesh.tris[3 * A]!, mesh.tris[3 * A + 1]!, mesh.tris[3 * A + 2]!];
          const vb = [mesh.tris[3 * B]!, mesh.tris[3 * B + 1]!, mesh.tris[3 * B + 2]!];
          if (va.some((v) => vb.includes(v))) continue;

          const P = (v: number): [number, number, number] => [pos[3 * v]!, pos[3 * v + 1]!, pos[3 * v + 2]!];
          const pa = va.map(P), pb = vb.map(P);
          const nrm = (p: [number, number, number][]): [number, number, number] | null => {
            const u = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]];
            const w = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]];
            const n: [number, number, number] = [
              u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!,
            ];
            const L = Math.hypot(n[0], n[1], n[2]);
            return L < 1e-18 ? null : [n[0] / L, n[1] / L, n[2] / L];
          };
          const nA = nrm(pa), nB = nrm(pb);
          if (!nA || !nB) continue;
          const dist = (n: [number, number, number], o: [number, number, number], p: [number, number, number][]): number[] =>
            p.map((q) => n[0] * (q[0] - o[0]) + n[1] * (q[1] - o[1]) + n[2] * (q[2] - o[2]));
          const dA = dist(nB, pb[0]!, pa);
          const dB = dist(nA, pa[0]!, pb);
          const E = 1e-12;
          const flatA = Math.abs(nA[2]) > 0.4, flatB = Math.abs(nB[2]) > 0.4;
          const lvlGap = Math.abs(tris[A]!.lvl - tris[B]!.lvl) > 0.5 * eps;
          const noCross =
            dA.every((x) => x > E) || dA.every((x) => x < -E)
            || dB.every((x) => x > E) || dB.every((x) => x < -E)
            || dA.every((x) => Math.abs(x) <= E) || dB.every((x) => Math.abs(x) <= E);
          if (noCross) {
            if (!flatA || !flatB || !lvlGap) continue;
            const fa2 = tris[A]!.fid!, fb2 = tris[B]!.fid!;
            if (joined.has(fa2 < fb2 ? `${fa2}|${fb2}` : `${fb2}|${fa2}`)) continue;
            const inXY = (x: number, y: number, p: [number, number, number][]): boolean => {
              const den = (p[1]![1] - p[2]![1]) * (p[0]![0] - p[2]![0]) + (p[2]![0] - p[1]![0]) * (p[0]![1] - p[2]![1]);
              if (Math.abs(den) < 1e-16) return false;
              const w1 = ((p[1]![1] - p[2]![1]) * (x - p[2]![0]) + (p[2]![0] - p[1]![0]) * (y - p[2]![1])) / den;
              const w2 = ((p[2]![1] - p[0]![1]) * (x - p[2]![0]) + (p[0]![0] - p[2]![0]) * (y - p[2]![1])) / den;
              return w1 >= -1e-6 && w2 >= -1e-6 && 1 - w1 - w2 >= -1e-6;
            };

            const mark = (p: [number, number, number][], other: [number, number, number][], d: number[]): void => {
              for (let e = 0; e < 3; e++) {
                const de = d[e]!;
                if (Math.abs(de) >= MINSEP) continue;
                if (!inXY(p[e]![0], p[e]![1], other)) continue;
                stick += MINSEP - Math.abs(de);
                found++;
                const kx = Math.floor(p[e]![0] / COL), ky = Math.floor(p[e]![1] / COL);
                for (let gx = kx - 1; gx <= kx + 1; gx++) {
                  for (let gy = ky - 1; gy <= ky + 1; gy++) colCells.add(gx * 262144 + gy);
                }
                for (let gx = cgx - 1; gx <= cgx + 1; gx++) {
                  for (let gy = cgy - 1; gy <= cgy + 1; gy++) nextRegion.add(gx * 65536 + gy);
                }
              }
            };
            mark(pa, pb, dA);
            mark(pb, pa, dB);
            continue;
          }
          const dir: [number, number, number] = [
            nA[1] * nB[2] - nA[2] * nB[1], nA[2] * nB[0] - nA[0] * nB[2], nA[0] * nB[1] - nA[1] * nB[0],
          ];
          const dl = Math.hypot(dir[0], dir[1], dir[2]);
          if (dl < 1e-12) continue;
          const interval = (p: [number, number, number][], d: number[]): [number, number] | null => {
            const pts: number[] = [];
            for (let e = 0; e < 3; e++) {
              const f2 = (e + 1) % 3;
              const de = d[e]!, df = d[f2]!;
              if ((de > E && df < -E) || (de < -E && df > E)) {
                const s = de / (de - df);
                pts.push(
                  (dir[0] * (p[e]![0] + s * (p[f2]![0] - p[e]![0]))
                    + dir[1] * (p[e]![1] + s * (p[f2]![1] - p[e]![1]))
                    + dir[2] * (p[e]![2] + s * (p[f2]![2] - p[e]![2]))) / dl,
                );
              } else if (Math.abs(de) <= E) {
                pts.push((dir[0] * p[e]![0] + dir[1] * p[e]![1] + dir[2] * p[e]![2]) / dl);
              }
            }
            if (pts.length < 2) return null;
            return [Math.min(...pts), Math.max(...pts)];
          };
          const iA = interval(pa, dA), iB = interval(pb, dB);
          if (!iA || !iB) continue;
          const crossLen = Math.min(iA[1], iB[1]) - Math.max(iA[0], iB[0]);
          if (crossLen <= 1e-9) continue;
          found++;
          roundLen += crossLen;
          for (let gx = cgx - 1; gx <= cgx + 1; gx++) {
            for (let gy = cgy - 1; gy <= cgy + 1; gy++) nextRegion.add(gx * 65536 + gy);
          }

          const dLvl = tris[A]!.lvl - tris[B]!.lvl;
          const belowA: boolean | null = flatA && flatB && lvlGap ? dLvl < 0 : null;
          const repair = (verts: number[], d: number[], n: [number, number, number], below: boolean | null): void => {
            let neg = 0, pnt = 0;
            for (const x of d) { if (x < -E) neg++; else if (x > E) pnt++; }
            if (neg === 0 || pnt === 0) return;
            const keepSign = below === null
              ? (neg <= pnt ? 1 : -1)
              : (below ? -Math.sign(n[2]) : Math.sign(n[2]));
            for (let e = 0; e < 3; e++) {
              const de = d[e]!;
              if (Math.sign(de) === keepSign) continue;
              const v = verts[e]!;
              if (settled[v]) continue;
              const want = keepSign * GAP - de;
              if (Math.abs(want) <= pushMag[v]!) continue;
              pushMag[v] = Math.abs(want);
              if (below !== null) {
                push[3 * v] = 0;
                push[3 * v + 1] = 0;
                push[3 * v + 2] = want / n[2];
              } else {
                push[3 * v] = want * n[0];
                push[3 * v + 1] = want * n[1];
                push[3 * v + 2] = want * n[2];
              }
            }
          };
          repair(va, dA, nB, belowA);
          repair(vb, dB, nA, belowA === null ? null : !belowA);
        }
      }
    }

    for (const key of colCells) {
      const gx = Math.floor(key / 262144), gy = key - gx * 262144;
      const x = (gx + 0.5) * COL, y = (gy + 0.5) * COL;
      const list = buckets.get(Math.floor(x / CELL) * 65536 + Math.floor(y / CELL));
      if (!list) continue;
      interface Entry { z: number; t: number; fid: FaceId; pinned: boolean; b: [number, number, number] }
      const entries: Entry[] = [];
      for (const t of list) {
        if (x < bbox[6 * t]! || x > bbox[6 * t + 1]! || y < bbox[6 * t + 2]! || y > bbox[6 * t + 3]!) continue;
        const a = mesh.tris[3 * t]!, b = mesh.tris[3 * t + 1]!, c = mesh.tris[3 * t + 2]!;
        const ax = pos[3 * a]!, ay = pos[3 * a + 1]!;
        const bx2 = pos[3 * b]!, by2 = pos[3 * b + 1]!;
        const cx2 = pos[3 * c]!, cy2 = pos[3 * c + 1]!;
        const den = (by2 - cy2) * (ax - cx2) + (cx2 - bx2) * (ay - cy2);
        if (Math.abs(den) < 1e-16) continue;
        const w1 = ((by2 - cy2) * (x - cx2) + (cx2 - bx2) * (y - cy2)) / den;
        const w2 = ((cy2 - ay) * (x - cx2) + (ax - cx2) * (y - cy2)) / den;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;

        const ux = bx2 - ax, uy = by2 - ay, uz = pos[3 * b + 2]! - pos[3 * a + 2]!;
        const vx = cx2 - ax, vy = cy2 - ay, vz = pos[3 * c + 2]! - pos[3 * a + 2]!;
        const nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
        const nl = Math.hypot(nx2, ny2, nz2);
        if (nl < 1e-18 || Math.abs(nz2) / nl < 0.4) continue;
        entries.push({
          z: w1 * pos[3 * a + 2]! + w2 * pos[3 * b + 2]! + w3 * pos[3 * c + 2]!,
          t, fid: tris[t]!.fid!,
          pinned: !!(settled[a] && settled[b] && settled[c]),
          b: [w1, w2, w3],
        });
      }
      if (entries.length < 2) continue;
      entries.sort((p, q) => p.z - q.z);
      const off: number[] = [0];
      for (let i = 1; i < entries.length; i++) {
        const gap = entries[i]!.fid === entries[i - 1]!.fid
          || joined.has(entries[i]!.fid < entries[i - 1]!.fid
            ? `${entries[i]!.fid}|${entries[i - 1]!.fid}` : `${entries[i - 1]!.fid}|${entries[i]!.fid}`)
          ? 0 : MINSEP;
        off.push(off[i - 1]! + gap);
      }
      const PIN = 1e6;
      const poolV: number[] = [], poolW: number[] = [], poolN: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        let v2 = entries[i]!.z - off[i]!, w2 = entries[i]!.pinned ? PIN : 1, n2 = 1;
        while (poolV.length && poolV[poolV.length - 1]! > v2 + 1e-15) {
          const pv = poolV.pop()!, pw = poolW.pop()!, pn = poolN.pop()!;
          v2 = (v2 * w2 + pv * pw) / (w2 + pw); w2 += pw; n2 += pn;
        }
        poolV.push(v2); poolW.push(w2); poolN.push(n2);
      }
      let idx = 0;
      for (let p = 0; p < poolV.length; p++) {
        for (let r = 0; r < poolN[p]!; r++, idx++) {
          const e2 = entries[idx]!;
          const delta = poolV[p]! + off[idx]! - e2.z;
          if (Math.abs(delta) < 1e-12) continue;
          for (let k = 0; k < 3; k++) {
            const v = mesh.tris[3 * e2.t + k]!;
            if (settled[v]) continue;
            colSum[v] += delta * e2.b[k]!;
            colW[v] += e2.b[k]!;
          }
        }
      }
    }

    if ((globalThis as { __untangleDebug?: boolean }).__untangleDebug) {
      console.log(`  untangle round ${round}: pairs=${found} len=${(roundLen / eps).toFixed(2)}ε stick=${(stick / eps).toFixed(2)}ε cols=${colCells.size}`);
    }

    if (round === 0) firstLen = roundLen;
    const score = roundLen + stick;
    if (roundLen <= firstLen + 2 * eps && score < bestLen) {
      bestLen = score;
      best = Float64Array.from(pos);
    }
    if (!found || round === ROUNDS) break;
    region = nextRegion;
    for (let v = 0; v < mesh.V; v++) {
      const m = pushMag[v]!;
      if (m > 0) {
        const cap = Math.min(step[v]!, Math.max(0, 0.6 * eps - spent[v]!));
        if (cap > 0) {
          let s2 = DAMP * (m > cap ? cap / m : 1);
          s2 *= stretchOK(v, push[3 * v]! * s2, push[3 * v + 1]! * s2, push[3 * v + 2]! * s2);
          if (s2 > 0) {
            pos[3 * v] += push[3 * v]! * s2;
            pos[3 * v + 1] += push[3 * v + 1]! * s2;
            pos[3 * v + 2] += push[3 * v + 2]! * s2;
            spent[v] += m * s2;
            moved[v] = 1;
          }
        }
      }
      if (colW[v]! > 1e-9) {
        let dz = DAMP * colSum[v]! / colW[v]!;
        const cap = step[v]!;
        if (dz > cap) dz = cap; else if (dz < -cap) dz = -cap;
        const s3 = stretchOK(v, 0, 0, dz);
        if (s3 > 0) {
          pos[3 * v + 2] += dz * s3;
          moved[v] = 1;
        }
      }
    }
    for (let t = 0; t < nTri; t++) {
      if (!tris[t]!.still) continue;
      const a = mesh.tris[3 * t]!, b = mesh.tris[3 * t + 1]!, c = mesh.tris[3 * t + 2]!;
      tris[t]!.still = !(moved[a] || moved[b] || moved[c]) && tris[t]!.still;
    }
  }

  if (best && bestLen < Infinity) pos.set(best);
  for (let v = 0; v < mesh.V; v++) {
    if (pos[3 * v] !== pos0[3 * v] || pos[3 * v + 1] !== pos0[3 * v + 1] || pos[3 * v + 2] !== pos0[3 * v + 2]) {
      settled[v] = 0;
    }
  }
}

interface Motion { move: Uint8Array; ex: number; ey: number; ax: number; ay: number; h: number; sign: 1 | -1 }

function motionOf(
  post: FoldedState,
  mesh: MeshData,
  preFace: (Face | null)[],
  postFace: (Face | null)[],
  zPre: ReadonlyMap<FaceId, number>,
  zPost: ReadonlyMap<FaceId, number>,
): Motion | null {
  const n = mesh.cells.length;
  const moved = new Uint8Array(n);
  let refl: Iso | null = null, count = 0, papered = 0, seed = -1;
  for (let i = 0; i < n; i++) {
    const a = preFace[i], b = postFace[i];
    if (!a || !b) continue;
    papered++;
    if (isoEq(a.T, b.T)) continue;
    moved[i] = 1; count++;
    if (seed < 0) { seed = i; refl = compose(b.T, invert(a.T)); }
  }
  if (!refl || count === 0 || count === papered) return null;
  const line = reflectionLine(refl);
  const cell = mesh.cells[seed]!;
  let cx = 0, cy = 0;
  for (const p of cell) { cx += p.x; cy += p.y; }
  const u = foldPoint(preFace[seed]!.T, cx / cell.length, cy / cell.length);
  const sgn = line.nx * u.x + line.ny * u.y - line.c >= 0 ? 1 : -1;

  let hSum = 0, hN = 0;
  for (let i = 0; i < n; i++) {
    if (!moved[i]) continue;
    const za = zPre.get(preFace[i]!.id), zb = zPost.get(postFace[i]!.id);
    if (za === undefined || zb === undefined) continue;
    hSum += (za + zb) / 2; hN++;
  }
  const move = new Uint8Array(mesh.V);
  for (let v = 0; v < mesh.V; v++) move[v] = moved[mesh.cellOf[v]!]!;
  const op = post.lastOp;
  return {
    move,
    ex: sgn * line.nx, ey: sgn * line.ny,
    ax: line.nx * line.c, ay: line.ny * line.c,
    h: hN ? hSum / hN : 0,
    sign: op && 'direction' in op && op.direction === 'M' ? -1 : 1,
  };
}

function paperMat(color: number, side: THREE.Side): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0, side,

    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

export function buildModel(state: FoldedState, opts: BuildOptions): Built {
  const eps = Math.max(1e-5, opts.epsilon);
  const pre = state.prev;
  const states = pre ? [state, pre] : [state];

  const fine = Math.min(0.01, Math.max(0.0012, eps * 0.5 * Math.PI / 4));
  const cells = arrangement(states);
  const mesh = tessellate(cells, bendSegs(states), fine);

  const faceOfCell = facesOfCells(state, mesh.cells);
  const built = layout(state, mesh, faceOfCell, eps);
  untangle(mesh, faceOfCell, built.pos, built.settled, eps, built.z, built.joins);
  const q = built.pos;

  let motion: Motion | null = null;
  let posPre: Float64Array | null = null;
  if (pre) {
    const preCells = facesOfCells(pre, mesh.cells);
    const lp = layout(pre, mesh, preCells, eps);
    untangle(mesh, preCells, lp.pos, lp.settled, eps, lp.z, lp.joins);
    motion = motionOf(state, mesh, preCells, faceOfCell, lp.z, built.z);
    if (motion) posPre = lp.pos;
  }

  let lift = 0;
  if (motion && posPre) {
    let err = 0;
    for (let v = 0; v < mesh.V; v++) {
      if (!motion.move[v]) continue;
      err = Math.max(err, Math.abs(q[3 * v + 2]! - (2 * motion.h - posPre[3 * v + 2]!)));
    }
    lift = err + 2 * eps;
  }

  const nTri = mesh.triCell.length;
  const order = [...Array(nTri).keys()].sort((a, b) => {
    const fa = faceOfCell[mesh.triCell[a]!]?.id ?? '';
    const fb = faceOfCell[mesh.triCell[b]!]?.id ?? '';
    return fa < fb ? -1 : fa > fb ? 1 : a - b;
  });
  const index = new Uint32Array(nTri * 3);
  const faceIds: string[] = [];
  const fragIds: string[] = [];
  const groups: { start: number; count: number }[] = [];
  let run = '', runStart = 0;
  order.forEach((t, k) => {
    index[3 * k] = mesh.tris[3 * t]!;
    index[3 * k + 1] = mesh.tris[3 * t + 1]!;
    index[3 * k + 2] = mesh.tris[3 * t + 2]!;
    const id = faceOfCell[mesh.triCell[t]!]?.id ?? '';
    faceIds.push(id);
    if (k === 0) { run = id; runStart = 0; }
    else if (id !== run) { groups.push({ start: runStart * 3, count: (k - runStart) * 3 }); fragIds.push(run); run = id; runStart = k; }
    if (k === nTri - 1) { groups.push({ start: runStart * 3, count: (k + 1 - runStart) * 3 }); fragIds.push(run); }
  });

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(3 * mesh.V), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);

  const uv = new Float32Array(2 * mesh.V);
  for (let v = 0; v < mesh.V; v++) { uv[2 * v] = mesh.mx[v]!; uv[2 * v + 1] = mesh.my[v]!; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));

  const frontMats = fragIds.map(() => paperMat(FRONT_COLOR, THREE.FrontSide));
  const backMats = fragIds.map(() => paperMat(BACK_COLOR, THREE.BackSide));
  const meshF = new THREE.Mesh(geo, frontMats);
  const meshB = new THREE.Mesh(geo, backMats);
  meshF.userData.faceIds = faceIds; meshF.userData.fragIds = fragIds;
  meshB.userData.faceIds = faceIds; meshB.userData.fragIds = fragIds;

  const object = new THREE.Group();
  object.add(meshF, meshB);

  const solid = edgeOverlay(mesh, [...state.edges.values()]
    .filter((e) => e.kind === 'BOUNDARY' || e.kind === 'CREASE')
    .map((e) => [numOf(e.srcSeg[0]), numOf(e.srcSeg[1])] as [P2, P2]));
  const dashed = edgeOverlay(mesh, state.pendingCreases.map((p) => [numOf(p.seg[0]), numOf(p.seg[1])] as [P2, P2]));

  const solidGeo = new THREE.BufferGeometry();
  solidGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(solid.length * 3), 3));
  const dashGeo = new THREE.BufferGeometry();
  dashGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dashed.length * 3), 3));
  const lines = new THREE.LineSegments(solidGeo, new THREE.LineBasicMaterial({ color: LINE_COLOR }));
  const dashLines = new THREE.LineSegments(
    dashGeo, new THREE.LineDashedMaterial({ color: PENDING_COLOR, dashSize: 0.03, gapSize: 0.02 }),
  );
  if (solid.length) object.add(lines);
  if (dashed.length) object.add(dashLines);

  const live = new Float64Array(q);
  const publish = (): void => {
    const arr = posAttr.array as Float32Array;
    for (let v = 0; v < mesh.V; v++) {
      arr[3 * v] = live[3 * v]!; arr[3 * v + 1] = live[3 * v + 1]!; arr[3 * v + 2] = live[3 * v + 2]!;
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    writeOverlay(solidGeo, solid, live);
    writeOverlay(dashGeo, dashed, live);
    lines.computeLineDistances(); dashLines.computeLineDistances();
  };
  publish();

  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (let v = 0; v < mesh.V; v++) box.expandByPoint(tmp.set(q[3 * v]!, q[3 * v + 1]!, q[3 * v + 2]!));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const heights = new Map<FaceId, number>();
  {
    const acc = new Map<FaceId, number[]>();
    for (let v = 0; v < mesh.V; v++) {
      const f = faceOfCell[mesh.cellOf[v]!];
      if (!f || !built.settled[v]) continue;
      (acc.get(f.id) ?? acc.set(f.id, []).get(f.id)!).push(q[3 * v + 2]!);
    }
    for (const [id, list] of acc) heights.set(id, Math.min(...list));
  }

  const setProgress = (t: number): void => {
    if (!motion || !posPre) return;
    const tt = Math.max(0, Math.min(1, t));
    const th = Math.PI * tt * motion.sign;
    const cos = Math.cos(th), sin = Math.sin(th);
    const { ex, ey, ax, ay, h, move } = motion;
    for (let v = 0; v < mesh.V; v++) {
      const x0 = posPre[3 * v]!, y0 = posPre[3 * v + 1]!, z0 = posPre[3 * v + 2]!;
      let x = x0, y = y0, z = z0, ex1 = x0, ey1 = y0, ez1 = z0;
      if (move[v]) {
        const s = ex * (x0 - ax) + ey * (y0 - ay), zz = z0 - h;
        const bx = x0 - s * ex, by = y0 - s * ey;
        const rot = (c: number, sn: number): [number, number, number] =>
          [bx + ex * (s * c - zz * sn), by + ey * (s * c - zz * sn), h + zz * c + s * sn];
        [x, y, z] = rot(cos, sin);
        [ex1, ey1, ez1] = rot(Math.cos(Math.PI * motion.sign), Math.sin(Math.PI * motion.sign));

        z += lift * sin * Math.abs(sin) * smoothstep(Math.min(1, s / 0.08));
      }

      live[3 * v] = x + tt * (q[3 * v]! - ex1);
      live[3 * v + 1] = y + tt * (q[3 * v + 1]! - ey1);
      live[3 * v + 2] = z + tt * (q[3 * v + 2]! - ez1);
    }
    publish();
  };

  return {
    object, center, extent: Math.max(size.x, size.y, size.z) || 1,
    heights, settled: built.settled, animatable: !!motion, setProgress,
  };
}

function edgeOverlay(mesh: MeshData, segs: [P2, P2][]): number[] {
  if (!segs.length) return [];
  const on: (number[] | undefined)[] = new Array(mesh.V);
  for (let v = 0; v < mesh.V; v++) {
    const x = mesh.mx[v]!, y = mesh.my[v]!;
    let list: number[] | undefined;
    segs.forEach((s, i) => { if (distSeg(x, y, s[0], s[1]) < 1e-7) (list ??= []).push(i); });
    on[v] = list;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (let t = 0; t < mesh.triCell.length; t++) {
    for (let e = 0; e < 3; e++) {
      const i = mesh.tris[3 * t + e]!, j = mesh.tris[3 * t + ((e + 1) % 3)]!;
      const a = on[i], b = on[j];
      if (!a || !b || !a.some((k) => b.includes(k))) continue;
      const key = Math.min(i, j) * 1e7 + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i, j);
    }
  }
  return out;
}

function writeOverlay(geo: THREE.BufferGeometry, idx: readonly number[], q: Float64Array): void {
  const attr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!attr) return;
  const arr = attr.array as Float32Array;
  idx.forEach((v, i) => {
    arr[3 * i] = q[3 * v]!; arr[3 * i + 1] = q[3 * v + 1]!; arr[3 * i + 2] = q[3 * v + 2]!;
  });
  attr.needsUpdate = true;
  geo.computeBoundingSphere();
}

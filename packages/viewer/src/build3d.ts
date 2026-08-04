/**
 * FoldedState → three.js (spec §8.1): THE ENGINE PLACES THE PAPER, THE RENDERER ONLY ROUNDS
 * OFF THE JOINS.
 *
 * The layer model is flat plates: a face lies at its exact folded polygon, at the height its
 * index in its own spot's stack gives it. That IS the verified state, and it is what this
 * renderer draws — every point of paper more than a join's width from a join sits at exactly
 * `applyIso(T, p)` and exactly `level × ε`, to the last decimal. Nothing is simulated, nothing
 * accumulates, and the top view is Π(S) by construction rather than by luck.
 *
 * What the renderer adds is the part flat plates cannot show: where two faces are JOINED, real
 * paper turns instead of stopping. So a narrow band of material either side of each join is
 * lifted onto a curve:
 *
 *   · a CREASE joins two layers that the fold turned back on each other. Both lie on the same
 *     side of the crease line, Δz apart, so the paper makes a U-TURN: a semicircle of radius
 *     Δz/2 whose ends leave both layers tangentially, centred one radius in from the fold line
 *     so its rim lands exactly on it. Every turn is centred on its OWN radius, so folds sharing
 *     a line all reach that line rather than tucking in behind the widest of them.
 *   · a SPLIT with a level change is one sheet crossing the edge of the pile beneath it, so the
 *     paper DRAPES: it stays flat on the pile right up to the cut and falls away beyond it on
 *     an S-curve that leaves both levels flat.
 *
 * The band's material is simply reparametrised onto the curve. It does NOT preserve length, and
 * that is the point: an earlier build tried to fold the sheet the way paper actually folds —
 * arcs consuming material, layers ending short by what they spent going round — and every
 * quantity then depended on every other. Layers drifted from where the engine put them, the
 * drift accumulated fold over fold, flat paper strained at corners, and pinning any one of them
 * broke another, because a stack of layers with THICKNESS genuinely cannot fold flat: the
 * material does not add up. Letting a few millimetres of paper stretch inside a bend buys all
 * of it back, and nothing outside the bend can tell.
 *
 * The mesh is ONE surface — a tessellation of the source square, conforming by construction, so
 * there are no parts to stitch and no seams, T-junctions or hollow hinges to chase. Picking and
 * the dry-run tint work off geometry groups inside that one geometry.
 *
 * Animation (§8.2) rotates the last fold's movers about its hinge from 0 → π and blends into
 * the committed layout, so the final frame IS this build and nothing snaps.
 */
import * as THREE from 'three';
import type { FoldedState, Face, FaceId, Iso, Vec2 } from '@origami/core';
import { compose, invert, isoEq } from '@origami/core';

export const FRONT_COLOR = 0xd94f5c; // colored paper front (the source square's +z side)
export const BACK_COLOR = 0xf3f1ea;  // white-ish paper back
const LINE_COLOR = 0x2b2f36;         // boundary + folded crease overlay
const PENDING_COLOR = 0x2d6cdf;      // unfolded precrease marks

export interface BuildOptions {
  /**
   * ε — the gap between one layer's surface and the next, and the only shape parameter there
   * is. A fold's turn follows from it: layers Δz apart are joined by a semicircle of radius
   * Δz/2, centred one radius in from the fold line. Explode just makes ε bigger.
   */
  epsilon: number;
}

export interface Built {
  object: THREE.Group;
  center: THREE.Vector3;
  extent: number;
  /** Height of every face — its stack index × ε, measured back off the built geometry. */
  heights: Map<FaceId, number>;
  /**
   * Per vertex of the geometry: 1 where the renderer left the paper exactly where the ENGINE
   * put it, 0 inside a join's band where it was bent onto a curve. The renderer's whole claim
   * is that the first kind is exact, so it says which vertices those are and lets the tests
   * check it rather than have them guess at band widths.
   */
  settled: Uint8Array;
  /** True when the last op was a fold, i.e. `setProgress` shows something. */
  animatable: boolean;
  /** Re-run the LAST fold at angle θ = π·t and update the mesh in place. */
  setProgress(t: number): void;
}

// ---------------------------------------------------------------- small numeric helpers

interface P2 { x: number; y: number }
/** A line as n·p = c with |n| = 1. */
interface Line2 { nx: number; ny: number; c: number }

const MAX_CELLS = 1200;
const MAX_VERTS = 90000;
const REFINE_ROUNDS = 7;
/** How far a drape's S-curve reaches for each layer it has to fall, as a multiple of Δz. */
const DRAPE_REACH = 3;
/**
 * The most of the paper any join may claim, as a fraction of the square. THE FLAT PLATES ARE
 * THE MODEL: a face has to read as a stiff, flat sheet at the height the engine gave it, and it
 * cannot if the rounding of its own edges has eaten it. Without this cap the bands grow with ε,
 * so Explode — which stretches ε until the layers are visibly apart — turned every face into
 * one continuous blob with no flat paper left anywhere. Capped, the plates stay flat and the
 * joins become the narrow stretched ribbons an exploded diagram wants.
 */
const JOIN_CAP = 0.04;
/**
 * How far a join's curve fades out towards an end INSIDE the paper, as a multiple of its band
 * width. The fade is what keeps two crossing joins from tearing the sheet between them; how LONG
 * it takes is what keeps the sheet from being drawn inside out. The weight climbs 0 → 1 over this
 * distance, so the shear it leaves peaks in the middle of the ramp and scales as 1/RAMP — and a
 * saturated band crossing a mid-ramp one is exactly where every inside-out triangle sat. Three
 * band widths clears them on every demo; two leaves 14 on the cup. See `joinWeight`.
 */
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

/** Is (x,y) inside the convex polygon (boundary counts)? */
function inConvex(poly: readonly P2[], x: number, y: number): boolean {
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const s = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (s > 1e-9) pos = true; else if (s < -1e-9) neg = true;
  }
  return !(pos && neg);
}

/** Split a convex polygon by n·p = c. Returns 1 piece (no straddle) or 2. */
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

/**
 * How far a ray from (ox, oy) along a unit (dx, dy) stays inside a CCW convex polygon. The start
 * has to be inside (or on the outline), which is how it is used: the origin sits on the join.
 */
function exitAlong(poly: readonly P2[], ox: number, oy: number, dx: number, dy: number): number {
  let far = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x, ey = b.y - a.y;
    const cross = ex * dy - ey * dx;                       // how fast the ray leaves this edge
    if (cross >= -1e-12) continue;                         // parallel or heading inward
    far = Math.min(far, -(ex * (oy - a.y) - ey * (ox - a.x)) / cross);
  }
  return far === Infinity ? 0 : Math.max(0, far);
}

/** Distance from a point to a segment. */
function distSeg(px: number, py: number, a: P2, b: P2): number {
  const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy;
  let t = dd > 1e-30 ? ((px - a.x) * dx + (py - a.y) * dy) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** A source point through a face's exact isometry, in floats. */
function foldPoint(T: Iso, x: number, y: number): P2 {
  return {
    x: T.m[0][0].toNumber() * x + T.m[0][1].toNumber() * y + T.t.x.toNumber(),
    y: T.m[1][0].toNumber() * x + T.m[1][1].toNumber() * y + T.t.y.toNumber(),
  };
}

/** The reflection an isometry change encodes, as a folded-space line. */
function reflectionLine(refl: Iso): Line2 {
  const a = refl.m[0][0].toNumber(), b = refl.m[0][1].toNumber();
  const tx = refl.t.x.toNumber(), ty = refl.t.y.toNumber();
  let nx = -b, ny = a + 1;
  if (Math.hypot(nx, ny) < 1e-9) { nx = 1; ny = 0; }
  const L = Math.hypot(nx, ny);
  nx /= L; ny /= L;
  return { nx, ny, c: (nx * tx + ny * ty) / 2 };
}

// ---------------------------------------------------------------- the source-space mesh

interface MeshData {
  V: number;
  mx: Float64Array;      // material x
  my: Float64Array;      // material y
  cellOf: Int32Array;    // the convex cell each vertex was created in
  tris: Int32Array;      // 3 vertex indices per triangle
  triCell: Int32Array;   // the cell each triangle belongs to
  cells: P2[][];
}

/** Canonical (n, c) for the line through a–b, sign-normalized so duplicates collapse. */
function lineOf(a: P2, b: P2): Line2 | null {
  let nx = -(b.y - a.y), ny = b.x - a.x;
  const L = Math.hypot(nx, ny);
  if (L < 1e-12) return null;
  nx /= L; ny /= L;
  let c = nx * a.x + ny * a.y;
  if (nx < -1e-12 || (Math.abs(nx) <= 1e-12 && ny < 0)) { nx = -nx; ny = -ny; c = -c; }
  return { nx: rnd9(nx), ny: rnd9(ny), c: rnd9(c) };
}

/**
 * Cut the source square by every face boundary of the states involved. Each cell is then wholly
 * inside one face of each, so a cell's face — and with it its exact position and height — is
 * well defined, and no triangle ever straddles a join.
 *
 * Cutting with the full LINE rather than the segment over-splits a little; that costs triangles
 * and nothing else, and it keeps every cell convex, which is what makes the split cheap.
 */
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

/** The material lines the paper curves along — where the mesh has to be fine. */
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

/**
 * Triangulate the cells, fine near the joins and coarse elsewhere. Refinement marks EDGES and
 * then splits every triangle by how many of its edges are marked (1 → 2, 2 → 3, 3 → 4), with a
 * shared midpoint cache. Splitting a triangle on its own instead would leave its neighbour's
 * edge with a vertex hanging in the middle — a T-junction, i.e. a crack in the sheet.
 */
function tessellate(cells: P2[][], bends: [P2, P2][], fine: number): MeshData {
  const xs: number[] = [], ys: number[] = [], cellOf: number[] = [];
  const key2id = new Map<string, number>();
  const vid = (x: number, y: number, cell: number): number => {
    const k = `${Math.round(x * 1e7)}_${Math.round(y * 1e7)}`;
    let id = key2id.get(k);
    if (id === undefined) { id = xs.length; xs.push(x); ys.push(y); cellOf.push(cell); key2id.set(k, id); }
    return id;
  };

  let tris: number[][] = []; // [a, b, c, cell]
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

  // Element size is GRADED: `fine` on a join, coarsening with distance from one. Flat paper is
  // placed by an exact isometry and needs no resolution at all, but a curve is only as round as
  // the chord across it. Grading keeps the triangle count near a join finite instead of filling
  // the whole band at curve size.
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
      // rotate so the marked edges come first; winding (a→b→c) is preserved
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

/** For each cell, the face of `state` that contains it (by the cell's centroid). */
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

// ---------------------------------------------------------------- the joins

/**
 * A band of material either side of a join, and the curve it is laid onto. `lo`/`hi` are the
 * faces below and above; `ma`–`mb` is the join in MATERIAL space, which is what a vertex's
 * distance to the band is measured against.
 */
interface Join {
  kind: 'hinge' | 'step';
  lo: FaceId; hi: FaceId;
  zLo: number; zHi: number;
  delta: number;                 // how far into each face the curve reaches
  ma: P2; mb: P2;                // the join in MATERIAL space
  len: number;                   // its length, and whether each end is inside the paper
  fadeA: boolean; fadeB: boolean;
  bulge: number;                 // hinge only: the radius the turn is DRAWN at (≤ Δz/2)
  axis: number;                  // hinge only: the turn's centre, as a distance from the fold line
  arc: number;                   // how much of the band is the turn itself (the rest runs flat)
  nx: number; ny: number;        // hinge only: unit normal, from the crease line INTO the paper
  /** Per face: its material outline (CCW) and the way OUT of the join, in material space. */
  sides: { poly: P2[]; ax: number; ay: number }[];
}

/**
 * How much of a join's curve applies at a material point: full in the middle of the join, fading
 * to nothing at an end that lies INSIDE the paper.
 *
 * Without the fade, two joins that cross tear the sheet apart between them. Their bands overlap,
 * and on each side of the crossing the paper belongs to a different pair of faces — so one side
 * is rounding a three-layer turn while the other rounds a one-layer turn, and the two disagree
 * by ε on the very edge they share. Measured on the cup, that ripped one triangle to 118× its
 * own area. Fading each curve out where its join ends leaves the crossing at the engine's exact
 * position, where every face agrees, at the price of the rounding flattening into a step over
 * the last band's width. Ends on the paper's OUTLINE are not faded: nothing crosses there, and
 * the fold has to stay round right to the edge of the sheet.
 */
function joinWeight(j: Join, x: number, y: number): { u: number; w: number; t: number } {
  const dx = (j.mb.x - j.ma.x) / j.len, dy = (j.mb.y - j.ma.y) / j.len;
  const t = (x - j.ma.x) * dx + (y - j.ma.y) * dy;
  const u = Math.abs((x - j.ma.x) * -dy + (y - j.ma.y) * dx);   // distance to the join's LINE
  const fadeLen = Math.min(FADE_RAMP * j.delta, j.len / 2);
  let w = 1;
  if (j.fadeA) w = Math.min(w, t / fadeLen);
  if (j.fadeB) w = Math.min(w, (j.len - t) / fadeLen);
  return { u, w: w <= 0 ? 0 : w >= 1 ? 1 : smoothstep(w), t };
}

/**
 * How deep the paper actually runs, out of the join and into the SHALLOWER of the two faces it
 * holds, at a point along the join. A turn leans its band outward, away from the fold line, and
 * that lean is only paid for where there is paper to pay with: run a crease into the sheet's
 * border at an angle and the wedge of paper by the corner is shallower than the lean, so the
 * lean carries the corner off the edge of the sheet and hangs a sliver past it.
 *
 * Measuring the room is what tells the two cases apart, and they must be told apart. A crease
 * that ends square against the border has a full plate's depth right up to its last point, and
 * fading the turn out there — which is the cheap way to stop the sliver — flares every rim back
 * to the fold line over the last band-width of the fold. That is an ear on the end of the model,
 * and no folded sheet has one: a fold's cross section at the border is the same cross section as
 * in the middle. Both faces are measured and the smaller wins, so the two sides of a crease
 * always agree on the answer and the sheet cannot part along it.
 */
function roomOf(j: Join, t: number): number {
  const s = Math.max(0, Math.min(j.len, t)) / j.len;
  const ox = j.ma.x + (j.mb.x - j.ma.x) * s, oy = j.ma.y + (j.mb.y - j.ma.y) * s;
  let room = Infinity;
  for (const side of j.sides) room = Math.min(room, exitAlong(side.poly, ox, oy, side.ax, side.ay));
  return room;
}

/** `a`, held below `room`: exact while there is twice the room, saturating smoothly at it. */
function holdBelow(a: number, room: number): number {
  if (a <= 0) return a;
  if (room <= 1e-12) return 0;
  const x = a / room;
  return x <= 0.5 ? a : room * (1 - 0.25 / x);
}

/** Height of every face: its index in its own spot's stack. This is the engine's own answer. */
function levelsOf(state: FoldedState, eps: number): Map<FaceId, number> {
  const z = new Map<FaceId, number>();
  for (const sp of state.spots.values()) sp.stack.forEach((id, i) => z.set(id, i * eps));
  return z;
}

/**
 * Every join in the state, with the band width its curve needs.
 *
 * A U-turn of radius r is π·r long, so it wants π·r/2 of material from each side; that is the
 * natural band width.
 *
 * WHERE a turn's centre sits is what decides the folded EDGE. Put it at the far side of the band
 * and the rim comes out δ − r short of the fold line: every folded edge is drawn inside the
 * outline the engine computed, no two layers' rims agree, and — because the rim being short is
 * an outward push on the paper — a crease that meets the sheet's border at an angle squirts the
 * corner out past that border, a spike the engine never placed. Put it one OWN RADIUS in instead
 * and the rim lands exactly ON the fold line, which is where the engine says the paper ends, and
 * no part of the band ever reaches past the plate's own outline.
 *
 * Every turn on a line gets its own centre — nothing is shared. An earlier build gave a turn the
 * centre of the widest turn ENCLOSING it, so the layers were concentric and the inner ones sat
 * tucked behind the outer, the way a real folded edge nests. That is truer to paper, but it
 * pulls an inner rim back from the fold line by the difference of the two radii — 3ε on the cup,
 * where a one-layer turn hides behind a seven-layer one — and what that reads as on screen is
 * the outer layer wrapping round the side of the stack while the inner fold stops short. On a
 * deep pile it is the dominant thing you see, and it made the fold look wrong rather than
 * nested. So each turn is centred on its own radius and every rim lands on the line.
 *
 * The cost is paid between the layers: an inner turn's rim now sits on the fold line at its own
 * height, which is outside the arc of the turn that used to enclose it, so on a nested crease the
 * inner fold can cross the outer one. Nothing leaves the engine's outline — the overlap is
 * strictly inside the pile, hidden by the paper around it — and the plates are untouched.
 *
 * The band is then wider than the turn needs, and the remainder simply runs FLAT from the
 * turn's tangent line out to where the plate resumes. Material is split between the two in
 * proportion to their lengths, so the whole band stretches by the one same factor rather than
 * kinking where the curve ends: 2(π−1)/π ≈ 1.36 for a turn drawn at full size. That stretch is
 * the price of putting the rim on the fold line, and it is a price this construction can pay —
 * a turn is only as long as its material if the plates retreat by π·r/2, and the plates staying
 * exactly where the engine put them is the one thing the renderer may not trade away.
 *
 * The band is also never allowed to swallow the faces it joins — a flap narrower than its own
 * turn would be all curve and no paper.
 */
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
    if (Math.abs(za - zb) < 1e-12) continue;             // same level: nothing to round off
    const lo = za < zb ? fa : fb, hi = za < zb ? fb : fa;
    const ma = numOf(e.srcSeg[0]), mb = numOf(e.srcSeg[1]);
    // how far the paper extends from the join on each side — a band may not exceed it
    let reach = Infinity;
    for (const f of [fa, fb]) {
      let far = 0;
      for (const p of f.srcPoly) far = Math.max(far, distSeg(p.x.toNumber(), p.y.toNumber(), ma, mb));
      reach = Math.min(reach, far);
    }
    const dz = Math.abs(za - zb);
    // each face's material outline and the direction that leads AWAY from the join into it —
    // which is how far the turn has to work with before it runs off the paper
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
      // the crease's folded image, and the side of it the two layers lie on
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
          axis: dz / 2, arc: 0, sides,
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
          ma, mb, ...ends(ma, mb), nx: 0, ny: 0,
        },
        reach,
      });
    }
  }
  // Every turn is centred one OWN radius in from the fold line, so every rim — not just the
  // widest one's — lands exactly on that line. The band has to be at least deep enough to hold
  // the centre, and each crease caps it with its own paper; where the cap bites (a big layer gap
  // in Explode) the turn is drawn at the reduced scale its own band can hold, as a narrow ribbon
  // that stays inside the band instead of a loop swinging out past the fold line.
  for (const r of raws) {
    if (r.e.kind !== 'hinge') continue;
    const R = (r.e.zHi - r.e.zLo) / 2;
    const d = Math.min(Math.max(Math.PI * R / 2, R), JOIN_CAP, 0.3 * r.reach);
    const scale = Math.min(1, R > 1e-12 ? d / R : 1);
    r.e.delta = d;
    r.e.bulge = R * scale;
    r.e.axis = R * scale;
    // material for the turn and for the flat run out to the plate, split by their lengths
    const flat = r.e.delta - r.e.axis;
    const round = Math.PI * r.e.bulge / 2;
    r.e.arc = round + flat > 1e-12 ? r.e.delta * round / (round + flat) : r.e.delta;
  }
  return raws.map((r) => r.e).filter((j) => j.delta > 1e-9);
}

/**
 * Where every vertex goes: horizontally its face's exact folded position plus the sideways lean
 * of any turn it is inside; vertically a single continuous HEIGHT FIELD over the material.
 *
 * Both parts are functions of the material point, which is what keeps the sheet whole: paper on
 * either side of a crease computes the same answer there, so nothing can tear along it.
 */
function layout(
  state: FoldedState,
  mesh: MeshData,
  faceOf: (Face | null)[],
  eps: number,
): { pos: Float64Array; settled: Uint8Array; z: Map<FaceId, number> } {
  const z = levelsOf(state, eps);
  const joins = joinsOf(state, eps, z);
  const byFace = new Map<FaceId, Join[]>();
  for (const j of joins) {
    for (const id of [j.lo, j.hi]) (byFace.get(id) ?? byFace.set(id, []).get(id)!).push(j);
  }

  // HEIGHT IS ONE FIELD OVER THE MATERIAL, not a sum of per-face corrections. Every face is a
  // source pulling the sheet toward its own level, with a reach of its deepest join, and the
  // height at a point is the weighted average of the faces that reach it. Deep inside a face
  // only that face reaches, so the height is exactly the engine's; at a crease the two sides
  // reach equally and it is their midpoint; where creases CROSS, all four faces reach at once
  // and the sheet spirals smoothly through their levels.
  //
  // Summing per-face corrections instead is what tore the paper apart. Two faces meeting at a
  // crease near a crossing correct toward DIFFERENT third faces — a three-layer turn on one
  // side, a one-layer turn on the other — so they disagree by ε on the very edge they share.
  // Measured on the cup, that ripped one triangle to 118× its own area. A field cannot disagree
  // with itself.
  // A face reaches out ONLY THROUGH ITS OWN JOINS, never in every direction. Reaching by plain
  // distance lets a face jump across a neighbour thinner than the band and drag its level into
  // paper it does not touch — with the layers spread apart, that turned every flat plate into a
  // wave. Through the joins, the reach follows the paper.
  const sources = [...state.faces.values()].map((f) => ({
    id: f.id,
    poly: f.srcPoly.map(numOf),
    level: z.get(f.id) ?? 0,
    joins: byFace.get(f.id) ?? [],
  }));
  // The weight is not free: for one crease on its own it has to reproduce the U-turn's own
  // height profile exactly, or the field and the sideways lean disagree about how fast the
  // paper is moving and the material piles up. Blending w and 1 gives height zLo + Δz·w/(1+w),
  // and the semicircle wants zLo + r(1 − sin(π·d/2δ)) — so w = (1−s)/(1+s), s = sin(π·d/2δ).
  // A smoothstep here instead leaves the map stationary at the crease and crushes the paper
  // into the fold by 300×; this one crosses it at unit speed.
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
      if (src.id === f.id || distToFace(src.poly, mx, my) === 0) w = 1;
      else {
        for (const j of src.joins) {
          const q = weigh(distSeg(mx, my, j.ma, j.mb), j.arc);
          if (q > w) w = q;
        }
      }
      if (w <= 0) continue;
      if (src.id !== f.id) blended = true;   // another face reaches here: not settled paper
      zSum += w * src.level; wSum += w;
    }

    // The turn's ROUNDNESS is a sideways push: paper within a crease's band is drawn round the
    // U-turn its two layers share, and then flat from the turn's tangent line back out to the
    // plate. Both layers use the SAME centre and the same profile, so they agree exactly on the
    // fold line. It fades out where the crease ends inside the paper, so at a crossing the fold
    // goes crisp rather than fighting the crease it meets.
    let dx = 0, dy = 0, lean = 0, bent = false;
    for (const j of byFace.get(f.id) ?? []) {
      if (j.kind !== 'hinge') continue;
      const { u, w, t } = joinWeight(j, mx, my);
      if (u >= j.delta || w <= 0) continue;
      bent = true;
      const n = u <= j.arc
        ? j.axis - j.bulge * Math.cos((Math.PI / 2) * (u / j.arc))
        : j.axis + (u - j.arc) * (j.delta - j.axis) / (j.delta - j.arc);
      // the room LEFT from here: the vertex already stands u of the way out along that ray
      const across = holdBelow(n - u, roomOf(j, t) - u);
      dx += w * across * j.nx;
      dy += w * across * j.ny;
      lean += w;
    }
    // The lean is a FIELD, exactly as the height above is, and for the same reason. Where two
    // creases cross, both bands reach the same paper and each proposes its own sideways push in
    // its own direction; SUMMING them lets the pushes stack. Each one's weight also ramps 0 → 1
    // over a band width along its own crease, so at a crossing one ramps in while the other is
    // saturated, and the shear that leaves can turn the map over: those triangles are drawn
    // inside out, and since the sheet carries a front and a back skin the front colour shows
    // through as a red speck on the back of the paper. Sharing the paper instead of both taking
    // it removes 40% of them and lowers the crumple with it (cup 1.81 → 1.63 per mille past
    // 1.5×). One band still gives exactly itself: a single weight never exceeds 1.
    if (lean > 1) { dx /= lean; dy /= lean; }

    pos[3 * v] = p.x + dx;
    pos[3 * v + 1] = p.y + dy;
    pos[3 * v + 2] = wSum > 0 ? zSum / wSum : (z.get(f.id) ?? 0);
    if (!bent && !blended) settled[v] = 1;
  }
  return { pos, settled, z };
}

/**
 * The last fold, as motion. The movers swing about the hinge from 0 to π; whatever the turn and
 * the drape then do to settle them is blended in over the same interval, so t = 0 is exactly the
 * previous state's layout and t = 1 is exactly this one's.
 */
interface Motion { move: Uint8Array; ex: number; ey: number; ax: number; ay: number; h: number; sign: 1 | -1 }

function motionOf(
  pre: FoldedState,
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
  if (!refl || count === 0 || count === papered) return null;   // nothing moved, or a whole flip
  const line = reflectionLine(refl);
  const cell = mesh.cells[seed]!;
  let cx = 0, cy = 0;
  for (const p of cell) { cx += p.x; cy += p.y; }
  const u = foldPoint(preFace[seed]!.T, cx / cell.length, cy / cell.length);
  const sgn = line.nx * u.x + line.ny * u.y - line.c >= 0 ? 1 : -1;

  // the axis sits half way between where the moving paper starts and where it ends
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

// ---------------------------------------------------------------- assembly

function paperMat(color: number, side: THREE.Side): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0, side,
    // the crease overlay is drawn AT the surface; push the surface back so it wins
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

export function buildModel(state: FoldedState, opts: BuildOptions): Built {
  const eps = Math.max(1e-5, opts.epsilon);
  const pre = state.prev;
  const states = pre ? [state, pre] : [state];

  // The tightest turn joins two neighbouring layers: radius ε/2, so its arc is π·ε/2 long and
  // wants a handful of elements across it.
  const fine = Math.min(0.01, Math.max(0.0012, eps * 0.5 * Math.PI / 4));
  const cells = arrangement(states);
  const mesh = tessellate(cells, bendSegs(states), fine);

  const faceOfCell = facesOfCells(state, mesh.cells);
  const built = layout(state, mesh, faceOfCell, eps);
  const q = built.pos;

  // ---- motion of the last fold, if there was one
  let motion: Motion | null = null;
  let posPre: Float64Array | null = null;
  if (pre) {
    const preCells = facesOfCells(pre, mesh.cells);
    const lp = layout(pre, mesh, preCells, eps);
    motion = motionOf(pre, state, mesh, preCells, faceOfCell, lp.z, built.z);
    if (motion) posPre = lp.pos;
  }

  // ---- geometry: one indexed mesh, triangles grouped by face so the dry-run can still tint
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
  // uv = the material coordinate of each vertex: where it started on the flat square, which is
  // the mesh's rest state and the natural place to paint the crease pattern from later.
  const uv = new Float32Array(2 * mesh.V);
  for (let v = 0; v < mesh.V; v++) { uv[2 * v] = mesh.mx[v]!; uv[2 * v + 1] = mesh.my[v]!; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));

  // One surface, two skins. The sheet's normal genuinely turns over where the paper does, so
  // FrontSide always shows the source square's +z side and BackSide always the other — the two
  // colours follow the paper around every fold with nothing to keep in sync.
  const frontMats = fragIds.map(() => paperMat(FRONT_COLOR, THREE.FrontSide));
  const backMats = fragIds.map(() => paperMat(BACK_COLOR, THREE.BackSide));
  const meshF = new THREE.Mesh(geo, frontMats);
  const meshB = new THREE.Mesh(geo, backMats);
  meshF.userData.faceIds = faceIds; meshF.userData.fragIds = fragIds;
  meshB.userData.faceIds = faceIds; meshB.userData.fragIds = fragIds;

  const object = new THREE.Group();
  object.add(meshF, meshB);

  // ---- crease / boundary overlay: mesh EDGES that lie along a real paper line, so the drawn
  // line is on the surface by construction and follows every curve it crosses.
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

  const live = new Float64Array(q);   // what is actually on screen (q at t = 1)
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

  // ---- the height each face is DRAWN at, read back off the geometry where the paper has
  // settled — i.e. away from every curve. That is the number to check the engine against.
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
      }
      // whatever the join curves and the settle still owe is paid in over the same interval
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

/**
 * The mesh edges that lie along one of the given source-space segments. Drawing the segment
 * itself would cut the corner of every curve it crosses; the mesh's own edges cannot.
 */
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

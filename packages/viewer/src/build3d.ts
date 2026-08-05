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
 *     so its rim lands exactly on it. A turn WRAPPED by a wider one on the same stretch of line
 *     shares the wider turn's centre instead and tucks in behind it, concentric, the way real
 *     layers nest inside a fold — an inner rim on the line would poke through the wrap.
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
  la: P2; lb: P2;                // the join in FOLDED space (both faces agree on it)
  /**
   * Step only: how the fall is SKEWED across the split line. The layers of the pile the sheet
   * is stepping off end at that line, each at a level the sheet has to pass on its way down —
   * and other paper may rise on the far side. β is chosen so the sheet crosses the line in the
   * middle of the free window between the two: weight β for the upper face's pull and 1/β for
   * the lower's puts the blend at the line exactly there. 1 = the plain symmetric S-curve.
   */
  beta: number;
  /**
   * Step only: how far from each end the skew has to give way (0 = it does not). Where the
   * split's line ends on a fold line, the corner belongs to the fold's turn — a skew held at
   * full strength there fights the turn's own profile over the same material and shears the
   * corner to shreds — so β ramps back to 1 over the fold's own band width.
   */
  yieldA: number; yieldB: number;
  /** Per face: its material outline (CCW) and the way OUT of the join, in material space. */
  sides: { poly: P2[]; ax: number; ay: number }[];
}

/**
 * How a join's curve ENDS where the join ends inside the paper: it SHARPENS, it does not fade.
 *
 * The turn's ellipse keeps its full height — the levels it connects are fixed — but its lateral
 * radius, band width and centre all shrink toward the end, down to SHARP_MIN of themselves, so
 * the fold tightens into the gather point the way real paper gathers at a corner where fold
 * lines meet. This is what an 8-layer rolling fold gets for free (its lines run border to
 * border and never end inside the sheet): every layer keeps its OWN level right up to the fold.
 * The earlier scheme faded the curve's WEIGHT to zero instead, which flattened every rim onto
 * the fold plane while the heights still blended — near a junction that squeezed layers from
 * every level into one mushy surface, and that is where the paper stuck together and the
 * colours bled. Ends on the paper's OUTLINE neither sharpen nor fade: a fold's cross section at
 * the border is the same as in the middle.
 *
 * Beyond an interior end the (narrowed) band dies out over its own width — a fold that has
 * ended pushes nothing — and that short ramp is the one place shear still concentrates.
 */
const SHARP_MIN = 0.32;
function joinWeight(j: Join, x: number, y: number): { u: number; w: number; t: number; s: number } {
  const dx = (j.mb.x - j.ma.x) / j.len, dy = (j.mb.y - j.ma.y) / j.len;
  const t = (x - j.ma.x) * dx + (y - j.ma.y) * dy;
  const u = Math.abs((x - j.ma.x) * -dy + (y - j.ma.y) * dx);   // distance to the join's LINE
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
 * A turn that is ENCLOSED — a wider turn on the same stretch of the same folded line whose
 * z-range contains its own — is centred on the widest encloser instead, so the layers come out
 * concentric and each inner rim tucks in behind the outer by the difference of the radii, the
 * way a real folded edge nests. The alternative — every rim on its own radius so all land on
 * the line — pokes each inner rim THROUGH the turns wrapping it, and that shows as the inner
 * layer's colour striped across the fold's rim, the defect a viewer sees first. The enclosure
 * test is taken in FOLDED space (key and span both): the same folded line collects creases
 * whose material segments differ per layer, and the same infinite line can equally carry
 * unrelated folds at disjoint stretches, which must NOT nest — nesting one pulls a rim off a
 * fold line that nothing wraps (Two-fold's 2-layer hinge at x∈[0,½] sat a full gap inside its
 * line because the base hinge at x∈[½,¾] happened to be collinear).
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
  // Rims sharing a fold line are NESTED, physically: the widest turn on a fold line encloses
  // every smaller turn there, so an inner rim's centre is set to the widest ENCLOSING turn's
  // centre while its own radius stays its own. That draws each rim as a semicircle of its own
  // Δz/2 sitting inside the outer rim, the way real paper folds — outer rim wraps the pile,
  // inner rims curl inside it, and no rim's outer arc crosses another's. The cost is that inner
  // rims stop `axis_encloser − axis_own` short of the fold line, so the outer rim reads as
  // wrapping around the edge of the pile while inner folds tuck in behind — which is exactly
  // how a folded edge looks. The alternative — every rim on its own radius so all lands on the
  // fold line — lets inner rims poke through outer ones, and that shows as red back-face
  // slivers where the paper should be one colour, which is what this build fixes.
  // Turns nest where their FOLDED images share a line — the material segments of one folded
  // crease line differ per layer (each is the line pulled back through its own isometry), so
  // the key and the overlap test both have to be taken in folded space.
  const lineKey = (j: Join): string =>
    `${rnd9(j.nx)},${rnd9(j.ny)},${rnd9(j.nx * j.la.x + j.ny * j.la.y)}`;
  const byLine = new Map<string, Raw[]>();
  for (const r of raws) {
    if (r.e.kind !== 'hinge') continue;
    const k = lineKey(r.e);
    (byLine.get(k) ?? byLine.set(k, []).get(k)!).push(r);
  }
  // A turn only encloses another where the two actually share a stretch of the line: the same
  // infinite line can carry unrelated folds at disjoint segments (Two-fold's base hinge at
  // x∈[½,¾] and its 2-layer hinge at x∈[0,½] are both on y=½), and nesting one inside the
  // other pulls a rim off a fold line that nothing wraps.
  const spanOf = (j: Join): [number, number] => {
    const dx = -j.ny, dy = j.nx;      // direction of the fold line, in folded space
    const ta = dx * j.la.x + dy * j.la.y, tb = dx * j.lb.x + dy * j.lb.y;
    return [Math.min(ta, tb), Math.max(ta, tb)];
  };
  for (const r of raws) {
    if (r.e.kind !== 'hinge') continue;
    const R = (r.e.zHi - r.e.zLo) / 2;
    const [t0, t1] = spanOf(r.e);
    // widest turn on the same line whose z-range CONTAINS this one's and whose segment
    // genuinely overlaps it along the line — the encloser
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
    // Band width scales with the encloser (the mesh has to hold the outermost centre), not with
    // this rim's own radius. Own bulge stays at own R so the curve is drawn true.
    const d = Math.min(Math.max(Math.PI * Renc / 2, Renc), JOIN_CAP, 0.3 * r.reach);
    const scaleEnc = Math.min(1, Renc > 1e-12 ? d / Renc : 1);
    r.e.delta = d;
    r.e.bulge = R * scaleEnc;
    r.e.axis = Renc * scaleEnc;
    // material for the turn and for the flat run out to the plate, split by their lengths
    const flat = r.e.delta - r.e.axis;
    const round = Math.PI * r.e.bulge / 2;
    r.e.arc = round + flat > 1e-12 ? r.e.delta * round / (round + flat) : r.e.delta;
  }
  // Skew every STEP through the free window at its split line. The pile the sheet steps off
  // ends there — every one of its layers at a level the fall has to pass — and other paper may
  // rise on the far side. Find the highest layer ending against the line on the pile's side
  // (a) and the lowest rising on the far side (b); the sheet crosses the line midway between
  // them. Nothing near → a = zLo, b = zHi → the plain symmetric S-curve, unchanged.
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
    // measure against the seam TRIMMED at both ends: a plate merely touching an endpoint of
    // the seam with a corner does not stand in the sheet's way along it
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
      if (side >= -1e-9) a = Math.max(a, lvl);      // under the sheet, on the pile's side
      if (side <= 1e-9) b = Math.min(b, lvl);       // in the fall zone, on the far side
    }
    let z0 = (a + b) / 2;
    if (a > b + 1e-12) {
      // INVERTED window: the sheet leaves one pile and dives under another butted against it,
      // so there is no free height anywhere — only the seam between the piles to fall through.
      // Squeeze the drape to the seam and thread it half a gap off any plate level, so the
      // plates it cannot avoid are met edge-on for the shortest possible stretch instead of
      // being sliced along the whole band. The cliff stays just wide enough for its steepest
      // slope (1.5× the mean, the S-profile's peak) to keep the local stretch under the 1.5×
      // the crumple budget counts.
      const k = Math.round(z0 / eps);
      if (Math.abs(z0 - k * eps) < 0.25 * eps) z0 = (k + 0.5) * eps;
      j.delta = Math.min(j.delta, Math.max(2 * eps, 2.0 * (z0 - j.zLo)));
      j.arc = j.delta;
    }
    z0 = Math.min(Math.max(z0, j.zLo + eps / 4), j.zHi - eps / 4);
    j.beta = (z0 - j.zLo) / (j.zHi - z0);
    // where the split's line ends on a fold line, the skew yields to the fold's turn
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
): { pos: Float64Array; settled: Uint8Array; z: Map<FaceId, number>; joins: Join[] } {
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
  // A STEP falls through the free window its split line leaves (see `joinsOf`, which sets β).
  // The weight is read off the PROFILE the fall should draw — z0 at the line (the window's
  // middle), the plate at the band's far edge, flat at both — rather than scaling the hinge
  // weight by β: a factor of β≫1 on a weight whose transition sits wherever β·w crosses 1
  // crammed the whole descent into a fraction of the band, and the shear tore the corner where
  // a deep step met a fold (14.8× stretch on the cup at (½,1)). Reading w from the wanted
  // curve keeps the slope at (z0−zLo)/δ, and both sides of the line agree at z0 by
  // construction (own-1 + partner-β from below, own-1 + partner-1/β from above).
  const stepW = (j: Join, srcIsHi: boolean, d: number, mx: number, my: number): number => {
    // near a corner shared with a fold line the skew gives way to the turn (β → 1)
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
    const s = smoothstep(Math.min(1, d / Math.max(j.arc, 1e-12)));
    const zp = srcIsHi ? j.zLo + (z0 - j.zLo) * (1 - s) : z0 + (j.zHi - z0) * s;
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
  // THE REACH FOLLOWS THE PAPER. Raw distance to a join's segment also reaches material that
  // is not the join's own — past the segment's end, or across a crease into the layer folded
  // against it — and the pull then drags paper that has nothing to do with the join. On the
  // cup, the corner where two steps and a crease meet put a neighbouring layer's material
  // within band distance of a step's endpoint, and its fall dragged that layer a whole gap
  // down out of its plate, straight through the fold above it. So a join's pull is confined
  // to the material of its OWN two faces, dying off over a band width outside them: material
  // at a crossing's shared corner is inside (or touching) the neighbour and still blends, and
  // every first-order blend across the join itself is on the join's own faces and unchanged.
  // Spill dies over about a layer gap — NOT over the join's own band width. A step skewed by β
  // carries weights up to β≫1, and with a band-wide spill that overweight bled into a hinge
  // band next to it and warped the U-turn's height a full gap out of its own curve.
  const polyOfFace = new Map<FaceId, P2[]>();
  for (const s of sources) polyOfFace.set(s.id, s.poly);
  const ownSide = (j: Join, x: number, y: number): number => {
    const dLo = distToFace(polyOfFace.get(j.lo)!, x, y);
    if (dLo <= 0) return 1;
    const d = Math.min(dLo, distToFace(polyOfFace.get(j.hi)!, x, y));
    return d <= 0 ? 1 : weigh(d, Math.min(j.arc, 1.5 * eps));
  };

  // NO LAYER POKES THROUGH A TURN THAT WRAPS IT. A hinge's curve sweeps from zLo to zHi inside
  // its band, and every layer sandwiched between those levels ends against the same fold line —
  // the engine puts their edges ON it, which with a real gap ε is INSIDE the wrapping curve.
  // Left there, each sandwiched plate's edge slices through the wrap and shows as its colour
  // striped across the fold's rim. Real paper tucks the inner pile behind the wrap, so this
  // does the same: a vertex sitting between a wrap's levels, closer to the fold line than the
  // wrap's curve at that height, is pushed in behind the curve (plus a small clearance). The
  // push fades where the wrap itself fades, and never applies to the wrap's own two faces or
  // to a rim nested on the same line, which the encloser rule already places.
  interface Wrap {
    j: Join; nx: number; ny: number; c: number; dx: number; dy: number;
    t0: number; t1: number; mid: number; rz: number; key: string;
  }
  const foldedKey = (j: Join): string =>
    `${rnd9(j.nx)},${rnd9(j.ny)},${rnd9(j.nx * j.la.x + j.ny * j.la.y)}`;
  const wraps: Wrap[] = [];
  for (const j of joins) {
    if (j.kind !== 'hinge' || j.zHi - j.zLo < 1.5 * eps) continue;   // nothing fits inside
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
      // On a step boundary the containment shortcut would put both sides at weight 1 and pull
      // the line back to the midpoint; the join's skewed weight is the intended value there.
      if (src.id === f.id) w = 1;
      else if (!stepPartner.get(f.id)?.has(src.id) && distToFace(src.poly, mx, my) === 0) w = 1;
      else {
        for (const j of src.joins) {
          let q: number;
          if (j.kind === 'step') {
            q = stepW(j, src.id === j.hi, distSeg(mx, my, j.ma, j.mb), mx, my);
          } else {
            // the height profile narrows with the turn (see joinWeight), and dies with it
            // beyond an interior end — each layer returns to its OWN level at a junction
            // instead of blending through everyone else's
            const jw = joinWeight(j, mx, my);
            q = jw.w * weigh(jw.u, j.arc * jw.s);
          }
          if (q <= w) continue;
          q *= ownSide(j, mx, my);
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
      const { u, w, t, s } = joinWeight(j, mx, my);
      const deltaS = j.delta * s;
      if (u >= deltaS || w <= 0) continue;
      bent = true;
      // the turn, SHARPENED toward an interior end (see joinWeight): lateral radius, centre
      // and band all scale by s, the vertical span stays — the fold tightens, the rim stays
      // on its line, and the layers beside it keep their own levels
      const arcS = j.arc * s, axisS = j.axis * s, bulgeS = j.bulge * s;
      const n = u <= arcS
        ? axisS - bulgeS * Math.cos((Math.PI / 2) * (u / arcS))
        : axisS + (u - arcS) * (deltaS - axisS) / (deltaS - arcS);
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

    let px = p.x + dx, py = p.y + dy;
    const pz = wSum > 0 ? zSum / wSum : (z.get(f.id) ?? 0);

    // tuck behind any turn that wraps this vertex's level (see `wraps` above)
    let tuck = 0, tx = 0, ty = 0;
    for (const wr of wraps) {
      const j = wr.j;
      if (f.id === j.lo || f.id === j.hi) continue;
      if (pz <= j.zLo + 0.25 * eps || pz >= j.zHi - 0.25 * eps) continue;
      if (hingeLines.get(f.id)?.has(wr.key)) continue;   // its own rim nests there instead
      const u = wr.nx * px + wr.ny * py - wr.c;
      if (u < -1e-9) continue;                            // not on the wrap's side at all
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

/**
 * NO PAPER IS DRAWN THROUGH PAPER — enforced, not hoped for. The blended fields above get the
 * sheet within a whisker of correct everywhere, but where several fold lines meet, the blends
 * can still leave hairline interpenetrations (measured: layer order inverted by ~0.1ε at the
 * cup's junctions), and a hair is all it takes for the paper's red inside to show through the
 * white. So the layout is finished the way cloth solvers finish a frame: find every pair of
 * triangles that actually intersect, and walk the offending vertices back to just past the
 * other surface, until nothing intersects. Only vertices the joins already bent may move —
 * settled paper is the engine's exact answer and stays put — and each push is capped, so the
 * repair stays a local nudge of the bands rather than a new simulation. The result is the
 * physical invariant the whole renderer owes: one sheet of paper never passes through itself.
 */
function untangle(
  mesh: MeshData,
  faceOf: (Face | null)[],
  pos: Float64Array,
  settled: Uint8Array,
  eps: number,
  z: ReadonlyMap<FaceId, number>,
  joins: readonly Join[],
): void {
  const GAP = 0.05 * eps;                // separation to leave once a crossing is undone
  /**
   * LAYERS DO NOT STICK TOGETHER, either. Distinct layers a hair apart are the same defect as
   * layers a hair through each other — they merge into one surface on screen and flicker —
   * and the junction blends squeeze unrelated paper to exactly that. So paper of different
   * levels that is not joined by any fold is held at least this far apart, each side keeping
   * the side it is on. Half a gap is the most the design can ask for (a step's fall threads
   * pile edges at ε/2 by construction), so a third of a gap is enforced.
   */
  const MINSEP = 0.35 * eps;
  const DAMP = 0.6;                      // relaxation: part of the correction per round
  const ROUNDS = 10;
  const CELL = 0.02;
  const nTri = mesh.triCell.length;
  // paper JOINED by a fold legitimately converges at it — its two sides meet at the rim
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

  // a vertex may never be pushed further than a fraction of its own mesh cell in one round —
  // the knots sit where the mesh is finest, and a push longer than the triangles there spears
  // them through their neighbours and multiplies the crossings instead of removing them
  const step = new Float64Array(mesh.V).fill(0.5 * eps);
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.tris[3 * t + e]!, b = mesh.tris[3 * t + ((e + 1) % 3)]!;
      const L = Math.hypot(mesh.mx[a]! - mesh.mx[b]!, mesh.my[a]! - mesh.my[b]!) * 0.4;
      if (L < step[a]!) step[a] = L;
      if (L < step[b]!) step[b] = L;
    }
  }
  // ...and never so far that a triangle's AREA stretches past what the crumple contract
  // allows: the repair may not turn a hidden hairline crossing into a visible rip
  // conservative against the crumple bound of 8: two vertices of one triangle pushed in the
  // same round are each judged with the other held still, so leave joint-move headroom
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
      // area of (v + α·Δ, b, c): |N₀ + α·Δ×(b−c)| ≤ |N₀| + α·|Δ×(b−c)| — bound the bound
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
  const spent = new Float64Array(mesh.V);    // total distance a vertex has been walked
  const pos0 = Float64Array.from(pos);
  const COL = 0.004;                         // column spacing for the layer spread
  const colCells = new Set<number>();
  let best: Float64Array | null = null;      // never hand back anything worse than the input
  let bestLen = Infinity;
  let firstLen = 0;
  // after the first full sweep, only the neighbourhoods where crossings were found are checked
  // again — the rest of the sheet was clean and nothing there has moved
  let region: Set<number> | null = null;
  let nextRegion = new Set<number>();

  for (let round = 0; round <= ROUNDS; round++) {
    // fresh bounds and hash each round — vertices moved last round
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
          if (tris[A]!.still && tris[B]!.still) continue;   // exact plates never cross
          if (bbox[6 * A]! > bbox[6 * B + 1]! || bbox[6 * B]! > bbox[6 * A + 1]!) continue;
          if (bbox[6 * A + 2]! > bbox[6 * B + 3]! || bbox[6 * B + 2]! > bbox[6 * A + 3]!) continue;
          if (bbox[6 * A + 4]! > bbox[6 * B + 5]! + MINSEP || bbox[6 * B + 4]! > bbox[6 * A + 5]! + MINSEP) continue;
          // handle each pair once, in the tile holding the overlap's low corner
          if (Math.floor(Math.max(bbox[6 * A]!, bbox[6 * B]!) / CELL) !== cgx) continue;
          if (Math.floor(Math.max(bbox[6 * A + 2]!, bbox[6 * B + 2]!) / CELL) !== cgy) continue;
          const va = [mesh.tris[3 * A]!, mesh.tris[3 * A + 1]!, mesh.tris[3 * A + 2]!];
          const vb = [mesh.tris[3 * B]!, mesh.tris[3 * B + 1]!, mesh.tris[3 * B + 2]!];
          if (va.some((v) => vb.includes(v))) continue;     // joined paper touches via shared verts

          // do they truly cross? plane distances both ways, then interval overlap on the
          // intersection line (the standard triangle-triangle test, kept because its
          // by-products — the signed distances — are exactly what the repair needs)
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
          const dA = dist(nB, pb[0]!, pa);                  // A's verts against B's plane
          const dB = dist(nA, pa[0]!, pb);
          const E = 1e-12;
          const flatA = Math.abs(nA[2]) > 0.4, flatB = Math.abs(nB[2]) > 0.4;
          const lvlGap = Math.abs(tris[A]!.lvl - tris[B]!.lvl) > 0.5 * eps;
          const noCross =
            dA.every((x) => x > E) || dA.every((x) => x < -E)
            || dB.every((x) => x > E) || dB.every((x) => x < -E)
            || dA.every((x) => Math.abs(x) <= E) || dB.every((x) => Math.abs(x) <= E);
          if (noCross) {
            // not crossing — but STUCK? unrelated flat layers closer than the minimum stay
            // the side they are on and are eased apart (see MINSEP)
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
            // count the shortfall and mark the spot — the COLUMN SPREAD below does the moving,
            // because only a whole column knows how much room the pile actually has here
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

          // Which side should each triangle's paper be on? Where BOTH triangles lie flat-ish
          // (the braid ramps at fold-line junctions) the engine already says: the lower LEVEL
          // goes below. That one global answer is what makes the walk converge — pushing every
          // pair apart by whichever side happens to be closer just trades crossings around the
          // knot forever. Where either triangle stands on edge (a turn's band), level and
          // height don't correspond, so the poking side is walked back the way it came.
          // Which side should each triangle's paper be on? For flat-ish paper the engine
          // already says: the lower LEVEL goes below — unless the lower face's own fold wraps
          // right over the other's level here, in which case its crest is legitimately on top.
          // That one consistent answer is what lets the walk converge; pushing every pair to
          // whichever side is closer just trades the crossings around the knot forever. Paper
          // standing on edge (a turn's band) has no vertical order, so the poking vertices are
          // simply walked back the way they came.
          const dLvl = tris[A]!.lvl - tris[B]!.lvl;
          const belowA: boolean | null = flatA && flatB && lvlGap ? dLvl < 0 : null;
          const repair = (verts: number[], d: number[], n: [number, number, number], below: boolean | null): void => {
            let neg = 0, pnt = 0;
            for (const x of d) { if (x < -E) neg++; else if (x > E) pnt++; }
            if (neg === 0 || pnt === 0) return;
            const keepSign = below === null
              ? (neg <= pnt ? 1 : -1)                        // majority side
              : (below ? -Math.sign(n[2]) : Math.sign(n[2]));  // the ordered side
            for (let e = 0; e < 3; e++) {
              const de = d[e]!;
              if (Math.sign(de) === keepSign) continue;
              const v = verts[e]!;
              if (settled[v]) continue;                      // the engine's exact paper stays
              const want = keepSign * GAP - de;              // along n, to just past the plane
              if (Math.abs(want) <= pushMag[v]!) continue;   // keep the strongest correction
              pushMag[v] = Math.abs(want);
              if (below !== null) {
                // ordering flat paper is one-dimensional: push straight in z, so the repair
                // cannot shove material sideways into a third layer at a crowded knot
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
    // THE COLUMN SPREAD. At every marked spot, list the flat paper the vertical line there
    // passes through, in its CURRENT order — never reordered, so this cannot push paper
    // through paper — and re-space it: a minimum gap between distinct, unjoined layers,
    // settled paper pinned where the engine put it, and everything else moved as little as
    // possible (weighted pool-adjacent-violators). Where the pile has less room than the gaps
    // want, the pooling spreads what room there is evenly — which is exactly what a squeezed
    // pile of real paper does.
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
        // flat paper only — a turn's band stands on edge and has no place in a vertical pile
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
    // keep the best configuration seen so far. Crossings rule: a round is only kept if it
    // crosses no more than a whisker past what the layout started with — unsticking layers is
    // not allowed to push paper through paper. Among the rounds that hold that line, the one
    // with the least crossing-plus-stuckness wins.
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
        // per-round step cap, and a lifetime budget per vertex — past that the walk is not
        // converging there and stretching the paper further would show more than the crossing
        // it chases (0.6ε keeps the crumple and rim contracts intact)
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
  // hand back the best configuration, and mark exactly the paper that ended up moved
  if (best && bestLen < Infinity) pos.set(best);
  for (let v = 0; v < mesh.V; v++) {
    if (pos[3 * v] !== pos0[3 * v] || pos[3 * v + 1] !== pos0[3 * v + 1] || pos[3 * v + 2] !== pos0[3 * v + 2]) {
      settled[v] = 0;
    }
  }
}

/**
 * The last fold, as motion. The movers swing about the hinge from 0 to π; whatever the turn and
 * the drape then do to settle them is blended in over the same interval, so t = 0 is exactly the
 * previous state's layout and t = 1 is exactly this one's.
 *
 * The swing is RIGID — one shared axis height for the whole moving pack, so its layers stay
 * parallel and ε apart all the way round — and the pack ARCS OVER the pile: a lift of
 * L·sin²(θ), zero WITH zero slope at both ends so take-off and landing stay the rotation's
 * own, carries it clear while it travels. Without the lift two things cut: at take-off, the
 * pack pivots about the fold line while the pile's rims BULGE at that same line, so the pack's
 * crease band slices them; and near landing, any mover whose own height the rigid flip
 * misjudges (the cup's front flap spans the 2-layer and the 4-layer pile at once, so one
 * shared axis cannot land both parts) is dragged through the pile by the closing blend — which
 * read as the colours shattering as the flap landed. L is sized to the worst of those two: the
 * rims it must clear and the largest landing error. The lift also fades out over the first
 * band of paper past the crease, so the forming fold is never sheared against its own hinge.
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
  untangle(mesh, faceOfCell, built.pos, built.settled, eps, built.z, built.joins);
  const q = built.pos;

  // ---- motion of the last fold, if there was one
  let motion: Motion | null = null;
  let posPre: Float64Array | null = null;
  if (pre) {
    const preCells = facesOfCells(pre, mesh.cells);
    const lp = layout(pre, mesh, preCells, eps);
    untangle(mesh, preCells, lp.pos, lp.settled, eps, lp.z, lp.joins);
    motion = motionOf(pre, state, mesh, preCells, faceOfCell, lp.z, built.z);
    if (motion) posPre = lp.pos;
  }
  // how high the swing has to arc: over the pile's rims, and over its own worst landing error
  let lift = 0;
  if (motion && posPre) {
    let err = 0;
    for (let v = 0; v < mesh.V; v++) {
      if (!motion.move[v]) continue;
      err = Math.max(err, Math.abs(q[3 * v + 2]! - (2 * motion.h - posPre[3 * v + 2]!)));
    }
    lift = err + 2 * eps;
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
        // arc over the pile — sin·|sin| dies off fast at both ends (take-off and landing are
        // the rotation's own), carries the mountain/valley sign, and the ramp keeps the crease
        // itself unlifted so the forming fold is not sheared against the paper it hinges on
        z += lift * sin * Math.abs(sin) * smoothstep(Math.min(1, s / 0.08));
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

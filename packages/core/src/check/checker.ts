/**
 * Independent invariant checker (§6). It recomputes spots/overlaps from raw face
 * polygons + transforms rather than trusting op internals, so it can catch op bugs
 * and validate imported states. I1–I3 here; I4–I6 (layer-crossing) land in M4.
 */
import { Rat } from '../geom/rat.js';
import { Vec2 } from '../geom/vec2.js';
import { Line, lineThrough, pointSideOfLine } from '../geom/line.js';
import { isoEq, reflectIso, applyIso } from '../geom/iso.js';
import { area, polysIdentical, polysInteriorDisjoint } from '../geom/poly.js';
import { canonicalPolyKey } from '../geom/hash.js';
import { collinearOverlap } from '../state/edge.js';
import { foldedPoly } from '../state/face.js';
import { FaceId, SpotId } from '../state/ids.js';
import { FoldedState } from '../state/state.js';
import { CheckReport, InvariantResult } from './types.js';

/** Area of the paper P (unit square). */
const PAPER_AREA = Rat.ONE;

function checkI1(state: FoldedState): InvariantResult {
  for (const edge of state.edges.values()) {
    const [aId, bId] = edge.faces;
    if (bId === null) continue; // boundary edge, nothing to relate
    const fa = state.faces.get(aId)!;
    const fb = state.faces.get(bId)!;
    if (edge.kind === 'SPLIT') {
      if (!isoEq(fa.T, fb.T)) {
        return { invariant: 'I1', pass: false, witness: { edge: edge.id, reason: 'transforms differ across SPLIT edge' } };
      }
    } else {
      // folded crease: T_b = Refl(L) ∘ T_a, L = folded image of the shared segment
      const p0 = applyIso(fa.T, edge.srcSeg[0]);
      const p1 = applyIso(fa.T, edge.srcSeg[1]);
      const L = lineThrough(p0, p1);
      if (!isoEq(reflectIso(L, fa.T), fb.T)) {
        return { invariant: 'I1', pass: false, witness: { edge: edge.id, reason: 'not a reflection across the folded hinge' } };
      }
    }
  }
  return { invariant: 'I1', pass: true };
}

function checkI2(state: FoldedState): InvariantResult {
  let total = Rat.ZERO;
  for (const f of state.faces.values()) {
    const sa = area(f.srcPoly);
    const fa = area(foldedPoly(f));
    if (!sa.eq(fa)) {
      return { invariant: 'I2', pass: false, witness: { face: f.id, reason: 'folded area ≠ source area' } };
    }
    total = total.add(sa);
  }
  if (!total.eq(PAPER_AREA)) {
    return { invariant: 'I2', pass: false, witness: { total: total.toString(), expected: PAPER_AREA.toString() } };
  }
  return { invariant: 'I2', pass: true };
}

function checkI3(state: FoldedState): InvariantResult {
  const faces = [...state.faces.values()];
  const polys = faces.map(foldedPoly);

  // pairwise identical-or-interior-disjoint
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (polysIdentical(polys[i]!, polys[j]!)) continue;
      if (polysInteriorDisjoint(polys[i]!, polys[j]!)) continue;
      return { invariant: 'I3', pass: false, witness: { pair: [faces[i]!.id, faces[j]!.id], reason: 'partial overlap (CONF violated)' } };
    }
  }

  // independently regroup by canonical key; compare to state.spots
  const groups = new Map<string, string[]>();
  for (const f of faces) {
    const key = canonicalPolyKey(foldedPoly(f));
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f.id);
  }
  if (groups.size !== state.spots.size) {
    return { invariant: 'I3', pass: false, witness: { reason: 'spot count mismatch', derived: groups.size, stored: state.spots.size } };
  }
  for (const spot of state.spots.values()) {
    const key = canonicalPolyKey(spot.poly);
    const g = groups.get(key);
    if (!g || g.length !== spot.stack.length) {
      return { invariant: 'I3', pass: false, witness: { spot: spot.id, reason: 'spot membership mismatch' } };
    }
    for (const id of spot.stack) {
      const p = foldedPoly(state.faces.get(id)!);
      if (!polysIdentical(p, spot.poly)) {
        return { invariant: 'I3', pass: false, witness: { spot: spot.id, face: id, reason: 'face not congruent to its spot' } };
      }
    }
  }

  // every face appears in exactly one stack, exactly once
  const seen = new Map<string, number>();
  for (const spot of state.spots.values()) {
    for (const id of spot.stack) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const f of faces) {
    if (seen.get(f.id) !== 1) {
      return { invariant: 'I3', pass: false, witness: { face: f.id, count: seen.get(f.id) ?? 0, reason: 'face not in exactly one stack once' } };
    }
  }

  return { invariant: 'I3', pass: true };
}

// ---- layer-crossing invariants I4–I6 (M4) ----------------------------------
//
// These are the standard flat-foldability non-crossing conditions. They read
// pairwise above/below relations off the per-spot stacks and check that folded
// paper never passes through itself.

interface FaceLoc {
  readonly spot: SpotId;
  readonly index: number; // position in stack (bottom = 0)
}

function faceLocations(state: FoldedState): Map<FaceId, FaceLoc> {
  const loc = new Map<FaceId, FaceLoc>();
  for (const spot of state.spots.values()) {
    spot.stack.forEach((id, index) => loc.set(id, { spot: spot.id, index }));
  }
  return loc;
}

interface Taco {
  readonly spot: SpotId;
  readonly hinge: [Vec2, Vec2]; // folded hinge segment
  readonly lo: number;
  readonly hi: number;
}

/** Folded creases whose two faces share a spot: a "taco" (a folded pair). */
function tacos(state: FoldedState, loc: Map<FaceId, FaceLoc>): Taco[] {
  const out: Taco[] = [];
  for (const e of state.edges.values()) {
    if (e.kind !== 'CREASE') continue; // every CREASE is an active (folded) hinge
    const [aId, bId] = e.faces;
    if (bId === null) continue;
    const la = loc.get(aId)!;
    const lb = loc.get(bId)!;
    if (la.spot !== lb.spot) continue; // not a taco (faces in different spots)
    const fa = state.faces.get(aId)!;
    const hinge: [Vec2, Vec2] = [applyIso(fa.T, e.srcSeg[0]), applyIso(fa.T, e.srcSeg[1])];
    out.push({
      spot: la.spot,
      hinge,
      lo: Math.min(la.index, lb.index),
      hi: Math.max(la.index, lb.index),
    });
  }
  return out;
}

interface FlatConn {
  readonly a: FaceId;
  readonly b: FaceId;
  readonly seg: [Vec2, Vec2]; // folded boundary segment (shared)
}

/**
 * Flat continuations across a spot boundary (§D5). An unfolded precrease never
 * splits paper, so the sheet stays a single face there; the only flat cross-spot
 * boundaries are SPLIT edges (coplanar artificial cuts).
 */
function flatConnections(state: FoldedState): FlatConn[] {
  const out: FlatConn[] = [];
  for (const e of state.edges.values()) {
    if (e.kind !== 'SPLIT') continue;
    const [aId, bId] = e.faces;
    if (bId === null) continue;
    const fa = state.faces.get(aId)!;
    out.push({ a: aId, b: bId, seg: [applyIso(fa.T, e.srcSeg[0]), applyIso(fa.T, e.srcSeg[1])] });
  }
  return out;
}

function segOnLine(l: Line, seg: readonly [Vec2, Vec2]): boolean {
  return pointSideOfLine(l, seg[0]) === 0 && pointSideOfLine(l, seg[1]) === 0;
}

/** I4: two tacos sharing a hinge must have nested-or-disjoint index intervals. */
function checkI4(state: FoldedState, loc: Map<FaceId, FaceLoc>): InvariantResult {
  const ts = tacos(state, loc);
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i]!;
      const b = ts[j]!;
      if (a.spot !== b.spot) continue;
      if (!collinearOverlap(a.hinge[0], a.hinge[1], b.hinge[0], b.hinge[1])) continue;
      const disjoint = a.hi < b.lo || b.hi < a.lo;
      const nested =
        (a.lo <= b.lo && b.hi <= a.hi) || (b.lo <= a.lo && a.hi <= b.hi);
      if (!disjoint && !nested) {
        return {
          invariant: 'I4',
          pass: false,
          witness: { spot: a.spot, intervals: [[a.lo, a.hi], [b.lo, b.hi]], reason: 'interleaved tacos' },
        };
      }
    }
  }
  return { invariant: 'I4', pass: true };
}

/** I5: through-going paper (a tortilla) may not sit strictly inside a taco. */
function checkI5(state: FoldedState, loc: Map<FaceId, FaceLoc>): InvariantResult {
  const ts = tacos(state, loc);
  const conns = flatConnections(state);
  for (const t of ts) {
    const line = lineThrough(t.hinge[0], t.hinge[1]);
    for (const c of conns) {
      if (!segOnLine(line, c.seg)) continue;
      if (!collinearOverlap(t.hinge[0], t.hinge[1], c.seg[0], c.seg[1])) continue;
      for (const f of [c.a, c.b]) {
        const l = loc.get(f)!;
        if (l.spot !== t.spot) continue;
        if (t.lo < l.index && l.index < t.hi) {
          return {
            invariant: 'I5',
            pass: false,
            witness: { spot: t.spot, taco: [t.lo, t.hi], tortilla: f, index: l.index },
          };
        }
      }
    }
  }
  return { invariant: 'I5', pass: true };
}

/** I6: two sheets crossing a shared boundary keep a consistent above/below order. */
function checkI6(state: FoldedState, loc: Map<FaceId, FaceLoc>): InvariantResult {
  const conns = flatConnections(state);
  // group by unordered spot pair
  const groups = new Map<string, { A: SpotId; B: SpotId; pairs: Array<{ ia: number; ib: number }> }>();
  for (const c of conns) {
    const la = loc.get(c.a)!;
    const lb = loc.get(c.b)!;
    if (la.spot === lb.spot) continue;
    const [A, B] = la.spot < lb.spot ? [la.spot, lb.spot] : [lb.spot, la.spot];
    const key = `${A}||${B}`;
    const [ia, ib] = la.spot === A ? [la.index, lb.index] : [lb.index, la.index];
    const g = groups.get(key) ?? { A, B, pairs: [] };
    g.pairs.push({ ia, ib });
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.pairs.length; i++) {
      for (let j = i + 1; j < g.pairs.length; j++) {
        const p = g.pairs[i]!;
        const q = g.pairs[j]!;
        const sa = Math.sign(p.ia - q.ia);
        const sb = Math.sign(p.ib - q.ib);
        if (sa !== sb) {
          return {
            invariant: 'I6',
            pass: false,
            witness: { spots: [g.A, g.B], reason: 'inconsistent cross-boundary order' },
          };
        }
      }
    }
  }
  return { invariant: 'I6', pass: true };
}

/** Run the full checker I1–I6 (§2.4). */
export function checkState(state: FoldedState): CheckReport {
  const loc = faceLocations(state);
  const results = [
    checkI1(state),
    checkI2(state),
    checkI3(state),
    checkI4(state, loc),
    checkI5(state, loc),
    checkI6(state, loc),
  ];
  return { ok: results.every((r) => r.pass), results };
}

/**
 * Fast checker for interactive previews (§6): skips the O(n²) layer-crossing
 * invariants I4–I6. The committed state is always run through the full checkState.
 */
export function checkStateFast(state: FoldedState): CheckReport {
  const results = [checkI1(state), checkI2(state), checkI3(state)];
  return { ok: results.every((r) => r.pass), results };
}

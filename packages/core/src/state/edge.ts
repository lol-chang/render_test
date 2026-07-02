/**
 * Edges and crease records (§D2, §4.1).
 *
 * Edges are DERIVED from face adjacency in source space at rebuild time. A CREASE
 * edge is always an ACTIVE (folded) hinge — there is no `folded` flag, because an
 * unfolded precrease is not an edge at all: it is an annotation in
 * `state.pendingCreases` (a source-space segment + assignment) that only causes a
 * face split lazily, when a later fold actually uses that line (§3.4). Everything
 * that is not a CREASE or BOUNDARY is a SPLIT (an artificial coplanar cut).
 */
import { Rat } from '../geom/rat.js';
import { Vec2, sub, dot, cross, lexCmp } from '../geom/vec2.js';
import { FaceId, EdgeId } from './ids.js';

export type EdgeKind = 'BOUNDARY' | 'CREASE' | 'SPLIT';
export type Assignment = 'M' | 'V';

export interface Edge {
  readonly id: EdgeId;
  readonly faces: readonly [FaceId, FaceId | null]; // null = paper boundary
  readonly srcSeg: readonly [Vec2, Vec2];
  readonly kind: EdgeKind;
  readonly assignment?: Assignment; // intrinsic; CREASE only
}

/**
 * An intrinsic crease mark on a source-space segment: the assignment is defined
 * w.r.t. the FRONT of the sheet and is never rewritten by flips (§D2). Used both for
 * the active folded-crease store and for pending (unfolded) precrease annotations —
 * the two differ only by where they live on the state, not by shape.
 */
export interface CreaseRecord {
  readonly seg: readonly [Vec2, Vec2];
  readonly assignment: Assignment;
}

/** An unfolded precrease annotation (§3.4): a source-space segment + assignment. */
export type PendingCrease = CreaseRecord;

/**
 * True iff `inner` is collinear with and contained in `outer` (both source-space
 * segments). Used to recognize a crease on a sub-segment after CONF re-splits a
 * face along the hinge (§3.0), so the intrinsic assignment survives (I1).
 */
export function segContains(
  outer: readonly [Vec2, Vec2],
  inner: readonly [Vec2, Vec2],
): boolean {
  const d = sub(outer[1], outer[0]);
  const dd = dot(d, d);
  if (dd.isZero()) return false;
  if (!cross(d, sub(inner[0], outer[0])).isZero()) return false;
  if (!cross(d, sub(inner[1], outer[0])).isZero()) return false;
  const t0 = dot(sub(inner[0], outer[0]), d);
  const t1 = dot(sub(inner[1], outer[0]), d);
  return (
    t0.cmp(Rat.ZERO) >= 0 &&
    t0.cmp(dd) <= 0 &&
    t1.cmp(Rat.ZERO) >= 0 &&
    t1.cmp(dd) <= 0
  );
}

/** Find a crease record whose segment contains the given overlap segment. */
export function findCrease(
  creases: Iterable<CreaseRecord>,
  ov: readonly [Vec2, Vec2],
): CreaseRecord | null {
  for (const c of creases) {
    if (segContains(c.seg, ov)) return c;
  }
  return null;
}

/** Canonical key for a source segment (endpoint order normalized). */
export function segKey(a: Vec2, b: Vec2): string {
  const [p, q] = lexCmp(a, b) <= 0 ? [a, b] : [b, a];
  return `${p.x.toString()},${p.y.toString()}|${q.x.toString()},${q.y.toString()}`;
}

/**
 * Overlap of two collinear source segments, or null if not collinear / no positive-
 * length overlap. Used to detect shared edges between adjacent faces.
 */
export function collinearOverlap(
  a0: Vec2,
  a1: Vec2,
  b0: Vec2,
  b1: Vec2,
): [Vec2, Vec2] | null {
  const d = sub(a1, a0);
  const dd = dot(d, d);
  if (dd.isZero()) return null;
  // require all collinear
  if (!cross(d, sub(b0, a0)).isZero()) return null;
  if (!cross(d, sub(b1, a0)).isZero()) return null;
  // params (in units where a0 -> 0, a1 -> dd)
  const ta0 = Rat.ZERO;
  const ta1 = dd;
  const tb0 = dot(sub(b0, a0), d);
  const tb1 = dot(sub(b1, a0), d);
  const aLo = ta0.cmp(ta1) <= 0 ? ta0 : ta1;
  const aHi = ta0.cmp(ta1) <= 0 ? ta1 : ta0;
  const bLo = tb0.cmp(tb1) <= 0 ? tb0 : tb1;
  const bHi = tb0.cmp(tb1) <= 0 ? tb1 : tb0;
  const lo = aLo.cmp(bLo) >= 0 ? aLo : bLo;
  const hi = aHi.cmp(bHi) <= 0 ? aHi : bHi;
  if (hi.cmp(lo) <= 0) return null; // no positive-length overlap
  // convert back to points: p(t) = a0 + (t/dd) d
  const pt = (t: Rat): Vec2 => ({
    x: a0.x.add(d.x.mul(t).div(dd)),
    y: a0.y.add(d.y.mul(t).div(dd)),
  });
  return [pt(lo), pt(hi)];
}

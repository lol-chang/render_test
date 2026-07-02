/**
 * Exact simple polygons in the plane and the operations folds need (§5.2).
 *
 * All faces in the engine are convex (the paper starts convex and every operation
 * — reflection, split-by-line, CONF overlap clipping — preserves convexity), so the
 * split and boolean helpers here assume convex input where noted. We never "simplify"
 * or merge polygons (spec §1.2 rule 4): splits are part of state identity.
 */
import { Rat } from './rat.js';
import { Vec2, sub, dot, cross, eq as vecEq, lexCmp } from './vec2.js';
import { Line, dir as lineDir, pointSideOfLine, segLineIntersect } from './line.js';

export type Poly = readonly Vec2[]; // simple, CCW in source space, ≥ 3 vertices

/** Signed area (positive ⇔ CCW). Exact rational (shoelace / 2). */
export function signedArea(poly: Poly): Rat {
  let acc = Rat.ZERO;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    acc = acc.add(a.x.mul(b.y).sub(b.x.mul(a.y)));
  }
  return acc.div(Rat.of(2n));
}

/** Unsigned area. */
export function area(poly: Poly): Rat {
  return signedArea(poly).abs();
}

export function isCCW(poly: Poly): boolean {
  return signedArea(poly).sign() > 0;
}

/** Return the polygon oriented CCW (reversing a copy if needed). */
export function ensureCCW(poly: Poly): Poly {
  return isCCW(poly) ? poly : [...poly].reverse();
}

/** Drop consecutive duplicate vertices (exact equality). */
function dedupeConsecutive(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const prev = out.length ? out[out.length - 1]! : pts[n - 1]!;
    if (!vecEq(p, prev)) out.push(p);
  }
  // also drop wrap-around duplicate
  if (out.length > 1 && vecEq(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

/**
 * Canonical CCW vertex list starting at the lexicographically smallest vertex
 * (§5.4). Two polygons equal as oriented point-cycles ⇒ identical canonical list.
 */
export function canonicalVertices(poly: Poly): Vec2[] {
  const ccw = dedupeConsecutive(ensureCCW(poly) as Vec2[]);
  const n = ccw.length;
  if (n === 0) return [];
  // find index of lexicographically smallest vertex
  let min = 0;
  for (let i = 1; i < n; i++) {
    if (lexCmp(ccw[i]!, ccw[min]!) < 0) min = i;
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push(ccw[(min + i) % n]!);
  return out;
}

/** True iff the two polygons are the same oriented region (§5.2 polysIdentical). */
export function polysIdentical(a: Poly, b: Poly): boolean {
  const ca = canonicalVertices(a);
  const cb = canonicalVertices(b);
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) {
    if (!vecEq(ca[i]!, cb[i]!)) return false;
  }
  return true;
}

/**
 * Split a convex polygon by an infinite line into its left (side ≥ 0) and right
 * (side ≤ 0) pieces, plus the cut segment lying on the line (§5.2 splitPolyByLine).
 *
 * "left" = side > 0 of the directed line, "right" = side < 0 (see line.ts).
 * On-line vertices belong to both pieces. Returns null for a piece that is empty
 * or degenerate (< 3 distinct vertices). `cut` is null when the line does not cross
 * the interior (touches at most a vertex/edge).
 */
export function splitPolyByLine(
  poly: Poly,
  line: Line,
): { left: Poly | null; right: Poly | null; cut: [Vec2, Vec2] | null } {
  const n = poly.length;
  const sides = poly.map((p) => pointSideOfLine(line, p));
  const anyLeft = sides.some((s) => s > 0);
  const anyRight = sides.some((s) => s < 0);

  if (!anyRight) return { left: poly, right: null, cut: null };
  if (!anyLeft) return { left: null, right: poly, cut: null };

  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const onLinePts: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    const cur = poly[i]!;
    const curSide = sides[i]!;
    const nxt = poly[(i + 1) % n]!;
    const nxtSide = sides[(i + 1) % n]!;

    if (curSide >= 0) left.push(cur);
    if (curSide <= 0) right.push(cur);
    if (curSide === 0) onLinePts.push(cur);

    // strict crossing between cur and nxt → shared boundary intersection point
    if ((curSide > 0 && nxtSide < 0) || (curSide < 0 && nxtSide > 0)) {
      const hit = segLineIntersect(line, cur, nxt);
      if (hit) {
        left.push(hit.point);
        right.push(hit.point);
        onLinePts.push(hit.point);
      }
    }
  }

  const leftP = dedupeConsecutive(left);
  const rightP = dedupeConsecutive(right);

  // cut segment: two extreme on-line points ordered along the line direction
  let cut: [Vec2, Vec2] | null = null;
  const uniq = dedupeOnLine(onLinePts);
  if (uniq.length >= 2) {
    const d = lineDir(line);
    uniq.sort((p, q) => dot(sub(p, line.a), d).cmp(dot(sub(q, line.a), d)));
    cut = [uniq[0]!, uniq[uniq.length - 1]!];
  }

  return {
    left: leftP.length >= 3 ? leftP : null,
    right: rightP.length >= 3 ? rightP : null,
    cut,
  };
}

function dedupeOnLine(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (!out.some((q) => vecEq(p, q))) out.push(p);
  }
  return out;
}

/**
 * Interiors disjoint test for two convex polygons via exact SAT (§5.2).
 * Touching along a shared edge/vertex counts as disjoint interiors (uses ≤).
 */
export function polysInteriorDisjoint(a: Poly, b: Poly): boolean {
  return hasSeparatingAxis(a, b) || hasSeparatingAxis(b, a);
}

function hasSeparatingAxis(a: Poly, b: Poly): boolean {
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const p = a[i]!;
    const q = a[(i + 1) % n]!;
    const edge = sub(q, p);
    // outward normal for CCW polygon a is (edge.y, -edge.x)
    const axis = { x: edge.y, y: edge.x.neg() };
    const [amin, amax] = projectRange(a, axis);
    const [bmin, bmax] = projectRange(b, axis);
    // separated (interiors disjoint) if intervals do not overlap in interior
    if (amax.cmp(bmin) <= 0 || bmax.cmp(amin) <= 0) return true;
  }
  return false;
}

function projectRange(poly: Poly, axis: Vec2): [Rat, Rat] {
  let min = dot(poly[0]!, axis);
  let max = min;
  for (let i = 1; i < poly.length; i++) {
    const d = dot(poly[i]!, axis);
    if (d.cmp(min) < 0) min = d;
    if (d.cmp(max) > 0) max = d;
  }
  return [min, max];
}

/**
 * Convex intersection region of two convex polygons via Sutherland–Hodgman
 * clipping (exact). Returns null if the intersection has no area. Used by CONF
 * renormalization (§3.0) to find overlap boundaries.
 */
export function overlapRegion(subject: Poly, clip: Poly): Poly | null {
  let output: Vec2[] = ensureCCW(subject) as Vec2[];
  const clipCCW = ensureCCW(clip);
  const m = clipCCW.length;

  for (let i = 0; i < m && output.length > 0; i++) {
    const cp1 = clipCCW[i]!;
    const cp2 = clipCCW[(i + 1) % m]!;
    const edge: Line = { a: cp1, b: cp2 };
    const input = output;
    output = [];
    const len = input.length;
    for (let j = 0; j < len; j++) {
      const cur = input[j]!;
      const prev = input[(j - 1 + len) % len]!;
      const curIn = pointSideOfLine(edge, cur) >= 0; // inside = left/on of CCW clip edge
      const prevIn = pointSideOfLine(edge, prev) >= 0;
      if (curIn) {
        if (!prevIn) {
          const hit = segLineIntersect(edge, prev, cur);
          if (hit) output.push(hit.point);
        }
        output.push(cur);
      } else if (prevIn) {
        const hit = segLineIntersect(edge, prev, cur);
        if (hit) output.push(hit.point);
      }
    }
  }

  const result = dedupeConsecutive(output);
  if (result.length < 3) return null;
  if (area(result).isZero()) return null;
  return result;
}

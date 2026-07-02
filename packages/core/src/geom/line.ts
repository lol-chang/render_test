/**
 * Exact directed lines through two rational points, and the reflection /
 * side / intersection predicates built on them (§5.2, §5.3).
 *
 * A Line is stored as two distinct points (a, b). Its direction is b - a.
 * "Left/right of the directed axis" is the sign of cross(dir, p - a):
 *   > 0  → left,  < 0 → right,  = 0 → on the line.
 */
import { Rat } from './rat.js';
import { Vec2, vec, sub, add, scale, dot, cross } from './vec2.js';

export interface Line {
  readonly a: Vec2;
  readonly b: Vec2;
}

export function lineThrough(a: Vec2, b: Vec2): Line {
  if (a.x.eq(b.x) && a.y.eq(b.y)) throw new Error('Line: degenerate (a === b)');
  return { a, b };
}

export function dir(l: Line): Vec2 {
  return sub(l.b, l.a);
}

/**
 * Exact side of a point relative to the directed line:
 *   +1 left, -1 right, 0 on the line.
 */
export function pointSideOfLine(l: Line, p: Vec2): -1 | 0 | 1 {
  return cross(dir(l), sub(p, l.a)).sign();
}

export function onLine(l: Line, p: Vec2): boolean {
  return pointSideOfLine(l, p) === 0;
}

/**
 * Reflect a point across the line. Exact & rational:
 *   Refl(p) = a + (2 (v·d)/(d·d)) d - v,   v = p - a, d = b - a.
 */
export function reflectPoint(l: Line, p: Vec2): Vec2 {
  const d = dir(l);
  const v = sub(p, l.a);
  const dd = dot(d, d);
  const two = Rat.of(2n);
  const k = dot(v, d).mul(two).div(dd);
  // a + k*d - v
  return sub(add(l.a, scale(d, k)), v);
}

/**
 * Intersect segment [p,q] with the (infinite) line l.
 * Returns the intersection point and its parameter t along [p,q] (point = p + t(q-p)),
 * or null if the segment does not properly cross the line.
 *
 * - If p and q lie strictly on opposite sides → single crossing, t in (0,1).
 * - If exactly one endpoint is on the line → that endpoint (t = 0 or 1).
 * - If both endpoints are on the line (collinear segment) → null (caller handles
 *   the degenerate "segment lies on the line" case explicitly).
 * - If both strictly on the same side → null.
 */
export function segLineIntersect(
  l: Line,
  p: Vec2,
  q: Vec2,
): { point: Vec2; t: Rat } | null {
  const d = dir(l);
  const sp = cross(d, sub(p, l.a)); // signed distance * |d|
  const sq = cross(d, sub(q, l.a));
  const signP = sp.sign();
  const signQ = sq.sign();

  if (signP === 0 && signQ === 0) return null; // collinear
  if (signP === 0) return { point: p, t: Rat.ZERO };
  if (signQ === 0) return { point: q, t: Rat.ONE };
  if (signP === signQ) return null; // same side, no crossing

  // t = sp / (sp - sq)
  const t = sp.div(sp.sub(sq));
  const point = add(p, scale(sub(q, p), t));
  return { point, t };
}

/** Exact 2D points/vectors in the plane (source or folded space). */
import { Rat } from './rat.js';

export interface Vec2 {
  readonly x: Rat;
  readonly y: Rat;
}

export function vec(x: Rat, y: Rat): Vec2 {
  return { x, y };
}

/** Convenience constructor from integers/bigints for fixtures. */
export function vi(x: bigint | number, y: bigint | number): Vec2 {
  return { x: Rat.of(x), y: Rat.of(y) };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x.add(b.x), y: a.y.add(b.y) };
}
export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x.sub(b.x), y: a.y.sub(b.y) };
}
export function scale(a: Vec2, s: Rat): Vec2 {
  return { x: a.x.mul(s), y: a.y.mul(s) };
}
export function dot(a: Vec2, b: Vec2): Rat {
  return a.x.mul(b.x).add(a.y.mul(b.y));
}
/** 2D cross product (z-component): a.x*b.y - a.y*b.x. */
export function cross(a: Vec2, b: Vec2): Rat {
  return a.x.mul(b.y).sub(a.y.mul(b.x));
}
export function eq(a: Vec2, b: Vec2): boolean {
  return a.x.eq(b.x) && a.y.eq(b.y);
}
export function toString(a: Vec2): string {
  return `(${a.x.toString()},${a.y.toString()})`;
}
/** Lexicographic compare by (x then y). */
export function lexCmp(a: Vec2, b: Vec2): -1 | 0 | 1 {
  const cx = a.x.cmp(b.x);
  if (cx !== 0) return cx;
  return a.y.cmp(b.y);
}

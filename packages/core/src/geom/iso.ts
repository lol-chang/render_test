/**
 * Exact plane isometries: T(p) = m·p + t, with det(m) ∈ {+1, -1} (§D3).
 *
 * The side of the paper facing up is derived, never stored: side = front iff
 * det(m) = +1 (§D3 side rule). Fold operations compose a reflection about the
 * folded-space axis onto the moving faces' transforms; reflections about lines
 * through rational points are rational, so isometries stay exact.
 */
import { Rat } from './rat.js';
import { Vec2 } from './vec2.js';
import { Line, dir } from './line.js';

export interface Iso {
  readonly m: readonly [readonly [Rat, Rat], readonly [Rat, Rat]];
  readonly t: Vec2;
}

export const IDENTITY: Iso = {
  m: [
    [Rat.ONE, Rat.ZERO],
    [Rat.ZERO, Rat.ONE],
  ],
  t: { x: Rat.ZERO, y: Rat.ZERO },
};

export function det(T: Iso): Rat {
  const [[a, b], [c, d]] = T.m;
  return a.mul(d).sub(b.mul(c));
}

/** +1 if front side is up, -1 if back side is up (§D3). Throws if det ∉ {±1}. */
export function sideParity(T: Iso): 1 | -1 {
  const dv = det(T);
  if (dv.eq(Rat.ONE)) return 1;
  if (dv.eq(Rat.of(-1n))) return -1;
  throw new Error(`Iso: det must be ±1, got ${dv.toString()}`);
}

export function isFront(T: Iso): boolean {
  return sideParity(T) === 1;
}

export function applyIso(T: Iso, p: Vec2): Vec2 {
  const [[a, b], [c, d]] = T.m;
  return {
    x: a.mul(p.x).add(b.mul(p.y)).add(T.t.x),
    y: c.mul(p.x).add(d.mul(p.y)).add(T.t.y),
  };
}

/** Compose two isometries: (A ∘ B)(p) = A(B(p)). */
export function compose(A: Iso, B: Iso): Iso {
  const [[a11, a12], [a21, a22]] = A.m;
  const [[b11, b12], [b21, b22]] = B.m;
  const m: [[Rat, Rat], [Rat, Rat]] = [
    [a11.mul(b11).add(a12.mul(b21)), a11.mul(b12).add(a12.mul(b22))],
    [a21.mul(b11).add(a22.mul(b21)), a21.mul(b12).add(a22.mul(b22))],
  ];
  // t = A.m · B.t + A.t
  const t: Vec2 = {
    x: a11.mul(B.t.x).add(a12.mul(B.t.y)).add(A.t.x),
    y: a21.mul(B.t.x).add(a22.mul(B.t.y)).add(A.t.y),
  };
  return { m, t };
}

/** Exact inverse of an isometry (det = ±1 ⇒ integer-free rational inverse). */
export function invert(T: Iso): Iso {
  const [[a, b], [c, d]] = T.m;
  const dv = a.mul(d).sub(b.mul(c));
  if (dv.isZero()) throw new Error('Iso: singular, cannot invert');
  // inverse linear part
  const mi: [[Rat, Rat], [Rat, Rat]] = [
    [d.div(dv), b.neg().div(dv)],
    [c.neg().div(dv), a.div(dv)],
  ];
  // inverse translation = -mi · t
  const ti: Vec2 = {
    x: mi[0][0].mul(T.t.x).add(mi[0][1].mul(T.t.y)).neg(),
    y: mi[1][0].mul(T.t.x).add(mi[1][1].mul(T.t.y)).neg(),
  };
  return { m: mi, t: ti };
}

/**
 * Reflection isometry about a line L through rational points.
 * Linear part R = 1/(dx²+dy²) · [[dx²-dy², 2dxdy],[2dxdy, dy²-dx²]];
 * translation t = a - R·a  (so the line is fixed pointwise).
 */
export function reflectionIso(l: Line): Iso {
  const d = dir(l);
  const dx = d.x;
  const dy = d.y;
  const den = dx.mul(dx).add(dy.mul(dy));
  const m11 = dx.mul(dx).sub(dy.mul(dy)).div(den);
  const m12 = Rat.of(2n).mul(dx).mul(dy).div(den);
  const m21 = m12;
  const m22 = dy.mul(dy).sub(dx.mul(dx)).div(den);
  const m: [[Rat, Rat], [Rat, Rat]] = [
    [m11, m12],
    [m21, m22],
  ];
  // t = a - R·a
  const a = l.a;
  const Ra: Vec2 = {
    x: m11.mul(a.x).add(m12.mul(a.y)),
    y: m21.mul(a.x).add(m22.mul(a.y)),
  };
  const t: Vec2 = { x: a.x.sub(Ra.x), y: a.y.sub(Ra.y) };
  return { m, t };
}

/** Refl(L) ∘ T — reflect an isometry across a folded-space line (§5.2). */
export function reflectIso(l: Line, T: Iso): Iso {
  return compose(reflectionIso(l), T);
}

export function isoEq(A: Iso, B: Iso): boolean {
  const [[a11, a12], [a21, a22]] = A.m;
  const [[b11, b12], [b21, b22]] = B.m;
  return (
    a11.eq(b11) &&
    a12.eq(b12) &&
    a21.eq(b21) &&
    a22.eq(b22) &&
    A.t.x.eq(B.t.x) &&
    A.t.y.eq(B.t.y)
  );
}

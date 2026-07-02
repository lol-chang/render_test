import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { vi, eq as vecEq } from '../src/geom/vec2.js';
import { lineThrough, reflectPoint, pointSideOfLine } from '../src/geom/line.js';
import {
  IDENTITY,
  det,
  reflectIso,
  applyIso,
  sideParity,
  compose,
  invert,
  isoEq,
} from '../src/geom/iso.js';

describe('reflection of points', () => {
  // vertical line x = 1/2
  const xHalf = lineThrough(
    { x: Rat.of(1n, 2n), y: Rat.ZERO },
    { x: Rat.of(1n, 2n), y: Rat.ONE },
  );

  it('reflects across the vertical line x = 1/2', () => {
    const p = vi(0, 0);
    const r = reflectPoint(xHalf, p);
    expect(vecEq(r, vi(1, 0))).toBe(true);
  });

  it('reflection is an involution', () => {
    const p = vi(3, 7);
    const r = reflectPoint(xHalf, p);
    const rr = reflectPoint(xHalf, r);
    expect(vecEq(rr, p)).toBe(true);
  });

  it('points on the line are fixed', () => {
    const p = { x: Rat.of(1n, 2n), y: Rat.of(5n, 3n) };
    expect(vecEq(reflectPoint(xHalf, p), p)).toBe(true);
  });

  it('reflecting a diagonal line maps sides correctly', () => {
    const diag = lineThrough(vi(0, 0), vi(1, 1));
    const r = reflectPoint(diag, vi(2, 0));
    expect(vecEq(r, vi(0, 2))).toBe(true);
  });
});

describe('reflection of isometries (parity flips det)', () => {
  const line = lineThrough(vi(0, 0), vi(0, 1)); // y-axis

  it('identity has det +1 (front)', () => {
    expect(det(IDENTITY).eq(Rat.ONE)).toBe(true);
    expect(sideParity(IDENTITY)).toBe(1);
  });

  it('a single reflection has det -1 (back)', () => {
    const R = reflectIso(line, IDENTITY);
    expect(det(R).eq(Rat.of(-1n))).toBe(true);
    expect(sideParity(R)).toBe(-1);
  });

  it('two reflections restore det +1', () => {
    const R = reflectIso(line, IDENTITY);
    const RR = reflectIso(line, R);
    expect(det(RR).eq(Rat.ONE)).toBe(true);
  });

  it('reflectIso composes reflection onto the transform (applies to points)', () => {
    // reflect identity across y-axis: point (2,5) -> (-2,5)
    const R = reflectIso(line, IDENTITY);
    expect(vecEq(applyIso(R, vi(2, 5)), vi(-2, 5))).toBe(true);
  });

  it('invert(compose)=identity for a reflection', () => {
    const R = reflectIso(lineThrough(vi(1, 1), vi(3, 5)), IDENTITY);
    const back = compose(invert(R), R);
    expect(isoEq(back, IDENTITY)).toBe(true);
  });
});

describe('exact point-side predicate', () => {
  it('reports left/on/right', () => {
    const l = lineThrough(vi(0, 0), vi(1, 0)); // x-axis, dir +x
    expect(pointSideOfLine(l, vi(0, 1))).toBe(1); // above → left
    expect(pointSideOfLine(l, vi(0, -1))).toBe(-1);
    expect(pointSideOfLine(l, vi(5, 0))).toBe(0);
  });
});

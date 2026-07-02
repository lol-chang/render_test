import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { vi, Vec2, eq as vecEq } from '../src/geom/vec2.js';
import { lineThrough, onLine } from '../src/geom/line.js';
import {
  area,
  signedArea,
  isCCW,
  ensureCCW,
  splitPolyByLine,
  polysIdentical,
  polysInteriorDisjoint,
  overlapRegion,
} from '../src/geom/poly.js';
import { canonicalPolyKey, polyHash } from '../src/geom/hash.js';

const unit: Vec2[] = [vi(0, 0), vi(1, 0), vi(1, 1), vi(0, 1)];

describe('polygon area & orientation', () => {
  it('unit square has area 1 and is CCW', () => {
    expect(area(unit).eq(Rat.ONE)).toBe(true);
    expect(isCCW(unit)).toBe(true);
    expect(signedArea(unit).sign()).toBe(1);
  });
  it('ensureCCW flips a CW polygon', () => {
    const cw = [...unit].reverse();
    expect(isCCW(cw)).toBe(false);
    expect(isCCW(ensureCCW(cw))).toBe(true);
  });
});

describe('splitPolyByLine (areas sum, cut on line)', () => {
  it('splits the unit square at x = 1/2 into two equal halves', () => {
    const line = lineThrough(
      { x: Rat.of(1n, 2n), y: Rat.ZERO },
      { x: Rat.of(1n, 2n), y: Rat.ONE },
    );
    const { left, right, cut } = splitPolyByLine(unit, line);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // areas sum to the original
    expect(area(left!).add(area(right!)).eq(area(unit))).toBe(true);
    // each half has area 1/2
    expect(area(left!).eq(Rat.of(1n, 2n))).toBe(true);
    expect(area(right!).eq(Rat.of(1n, 2n))).toBe(true);
    // cut endpoints lie on the line
    expect(cut).not.toBeNull();
    expect(onLine(line, cut![0])).toBe(true);
    expect(onLine(line, cut![1])).toBe(true);
  });

  it('diagonal split of the unit square conserves area', () => {
    const diag = lineThrough(vi(0, 0), vi(1, 1));
    const { left, right } = splitPolyByLine(unit, diag);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(area(left!).add(area(right!)).eq(Rat.ONE)).toBe(true);
    expect(area(left!).eq(Rat.of(1n, 2n))).toBe(true);
  });

  it('line missing the interior yields a single piece', () => {
    const line = lineThrough(vi(2, 0), vi(2, 1)); // x = 2, entirely to the right
    const { left, right, cut } = splitPolyByLine(unit, line);
    expect(cut).toBeNull();
    // square is entirely on one side (left, side>0 of upward directed line at x=2)
    expect((left === null) !== (right === null)).toBe(true);
  });
});

describe('convex predicates', () => {
  it('polysIdentical is rotation/orientation invariant', () => {
    const rotated: Vec2[] = [vi(1, 1), vi(0, 1), vi(0, 0), vi(1, 0)]; // CW, shifted start
    expect(polysIdentical(unit, rotated)).toBe(true);
  });
  it('disjoint squares report interior-disjoint', () => {
    const shifted = unit.map((p) => ({ x: p.x.add(Rat.of(2n)), y: p.y }));
    expect(polysInteriorDisjoint(unit, shifted)).toBe(true);
  });
  it('edge-touching squares are interior-disjoint', () => {
    const shifted = unit.map((p) => ({ x: p.x.add(Rat.ONE), y: p.y }));
    expect(polysInteriorDisjoint(unit, shifted)).toBe(true);
  });
  it('overlapping squares are NOT interior-disjoint', () => {
    const shifted = unit.map((p) => ({ x: p.x.add(Rat.of(1n, 2n)), y: p.y }));
    expect(polysInteriorDisjoint(unit, shifted)).toBe(false);
  });
});

describe('overlapRegion (convex clip)', () => {
  it('half-overlap of two unit squares has area 1/2', () => {
    const shifted = unit.map((p) => ({ x: p.x.add(Rat.of(1n, 2n)), y: p.y }));
    const ov = overlapRegion(unit, shifted);
    expect(ov).not.toBeNull();
    expect(area(ov!).eq(Rat.of(1n, 2n))).toBe(true);
  });
  it('disjoint squares have no overlap region', () => {
    const shifted = unit.map((p) => ({ x: p.x.add(Rat.of(3n)), y: p.y }));
    expect(overlapRegion(unit, shifted)).toBeNull();
  });
});

describe('canonical polygon hash (§5.4)', () => {
  it('is invariant to starting vertex and orientation', () => {
    const rotated: Vec2[] = [vi(1, 1), vi(0, 1), vi(0, 0), vi(1, 0)];
    expect(canonicalPolyKey(unit)).toBe(canonicalPolyKey(rotated));
    expect(polyHash(unit)).toBe(polyHash(rotated));
  });
  it('distinguishes translated polygons', () => {
    const shifted = unit.map((p) => ({ x: p.x.add(Rat.ONE), y: p.y }));
    expect(canonicalPolyKey(unit)).not.toBe(canonicalPolyKey(shifted));
  });
});

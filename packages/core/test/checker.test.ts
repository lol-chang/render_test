import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2, vi } from '../src/geom/vec2.js';
import { Iso, IDENTITY, reflectionIso } from '../src/geom/iso.js';
import { lineThrough } from '../src/geom/line.js';
import { Poly } from '../src/geom/poly.js';
import { makeFace, Face } from '../src/state/face.js';
import { CreaseRecord, segKey } from '../src/state/edge.js';
import { FaceId, asFaceId } from '../src/state/ids.js';
import { buildState } from '../src/state/state.js';
import { initialSquare } from '../src/state/state.js';
import { checkState } from '../src/check/checker.js';
import { applyOp } from '../src/ops/apply.js';
import { FoldOp } from '../src/ops/types.js';
import { Invariant } from '../src/ops/types.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const P = (x0: number, x1: number): Poly => [
  { x: R(x0), y: R(0) },
  { x: R(x1), y: R(0) },
  { x: R(x1), y: R(1) },
  { x: R(x0), y: R(1) },
]; // vertical strip [x0,x1]×[0,1] (x given as thirds/quarters via R(n,d) below)

const strip = (n0: number, d0: number, n1: number, d1: number): Poly => [
  { x: R(n0, d0), y: R(0) },
  { x: R(n1, d1), y: R(0) },
  { x: R(n1, d1), y: R(1) },
  { x: R(n0, d0), y: R(1) },
];

const reflX = (c: Rat): Iso =>
  reflectionIso(lineThrough({ x: c, y: R(0) }, { x: c, y: R(1) }));
const translate = (dx: Rat): Iso => ({
  m: [
    [Rat.ONE, Rat.ZERO],
    [Rat.ZERO, Rat.ONE],
  ],
  t: { x: dx, y: Rat.ZERO },
});

function crease(x: Rat): [string, CreaseRecord] {
  const seg: [Vec2, Vec2] = [{ x, y: R(0) }, { x, y: R(1) }];
  return [segKey(seg[0], seg[1]), { seg, assignment: 'V' }];
}

function build(faces: Face[], order: string[], creases: Array<[string, CreaseRecord]>) {
  return buildState({
    faces,
    order: order.map(asFaceId),
    creases: new Map(creases),
    step: 0,
  });
}

function failed(state: ReturnType<typeof build>): Invariant[] {
  return checkState(state)
    .results.filter((r) => !r.pass)
    .map((r) => r.invariant);
}

// ---- I4: accordion of 4 congruent strips; two tacos share the right hinge ----
// A=id, B=refl(1/4), C=translate(-1/2), D=refl(1/2) — all fold onto [0,1/4].
function accordion(order: string[]) {
  const faces = [
    makeFace(asFaceId('A'), strip(0, 1, 1, 4), IDENTITY),
    makeFace(asFaceId('B'), strip(1, 4, 1, 2), reflX(R(1, 4))),
    makeFace(asFaceId('C'), strip(1, 2, 3, 4), translate(R(-1, 2))),
    makeFace(asFaceId('D'), strip(3, 4, 1, 1), reflX(R(1, 2))),
  ];
  return build(faces, order, [crease(R(1, 4)), crease(R(1, 2)), crease(R(3, 4))]);
}

describe('I4 taco-taco (crafted)', () => {
  it('valid accordion order [A,B,C,D] passes all invariants', () => {
    expect(checkState(accordion(['A', 'B', 'C', 'D'])).ok).toBe(true);
  });
  it('interleaved order [A,C,B,D] fails I4 (only)', () => {
    const f = failed(accordion(['A', 'C', 'B', 'D']));
    expect(f).toContain('I4');
    expect(f).toEqual(['I4']);
  });
});

// ---- I6: two flat sheets crossing a shared boundary ----
// Sheet A flat over [0,1/2] (split at x=1/4); sheet B = right half folded onto
// [0,1/2] (split at x=3/4). A2-B1 crease at x=1/2.
function twoSheets(order: string[]) {
  const faces = [
    makeFace(asFaceId('A1'), strip(0, 1, 1, 4), IDENTITY),
    makeFace(asFaceId('A2'), strip(1, 4, 1, 2), IDENTITY),
    makeFace(asFaceId('B1'), strip(1, 2, 3, 4), reflX(R(1, 2))),
    makeFace(asFaceId('B2'), strip(3, 4, 1, 1), reflX(R(1, 2))),
  ];
  return build(faces, order, [crease(R(1, 2))]);
}

describe('I6 tortilla-tortilla (crafted)', () => {
  it('valid order [A1,A2,B1,B2] passes', () => {
    expect(checkState(twoSheets(['A1', 'A2', 'B1', 'B2'])).ok).toBe(true);
  });
  it('inconsistent order [A1,B2,B1,A2] fails I6 (only)', () => {
    const f = failed(twoSheets(['A1', 'B2', 'B1', 'A2']));
    expect(f).toContain('I6');
    expect(f).toEqual(['I6']);
  });
});

// ---- I5: taco (V,W) at hinge x=1/4 with a tortilla U2 passing through it ----
// U1=id[0,1/4], U2=id[1/4,1/2] (tortilla across x=1/4), V=refl(1/2), W=translate(-1/2)
// both fold onto [1/4,1/2]; U2-V crease x=1/2, V-W crease x=3/4.
function tacoTortilla(order: string[]) {
  const faces = [
    makeFace(asFaceId('U1'), strip(0, 1, 1, 4), IDENTITY),
    makeFace(asFaceId('U2'), strip(1, 4, 1, 2), IDENTITY),
    makeFace(asFaceId('V'), strip(1, 2, 3, 4), reflX(R(1, 2))),
    makeFace(asFaceId('W'), strip(3, 4, 1, 1), translate(R(-1, 2))),
  ];
  return build(faces, order, [crease(R(1, 2)), crease(R(3, 4))]);
}

describe('I5 taco-tortilla (crafted)', () => {
  it('valid order [U1,U2,V,W] passes', () => {
    expect(checkState(tacoTortilla(['U1', 'U2', 'V', 'W'])).ok).toBe(true);
  });
  it('tortilla trapped inside the taco [U1,V,U2,W] fails I5 (only)', () => {
    const f = failed(tacoTortilla(['U1', 'V', 'U2', 'W']));
    expect(f).toContain('I5');
    expect(f).toEqual(['I5']);
  });
});

describe('regression: real folds pass the FULL checker I1–I6', () => {
  const R2 = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
  const V = (x: Rat, y: Rat): Vec2 => ({ x, y });
  const fa = (a: Vec2, b: Vec2, side: 'left' | 'right'): FoldOp => ({
    type: 'FOLD',
    mode: 'ALL',
    axis: { a, b },
    movingSide: side,
    direction: 'V',
  });
  it('half/half golden end state satisfies all six invariants', () => {
    let s = initialSquare();
    const r1 = applyOp(s, fa(V(R2(1, 2), R2(0)), V(R2(1, 2), R2(1)), 'right'));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = applyOp(r1.state, fa(V(R2(0), R2(1, 2)), V(R2(1), R2(1, 2)), 'left'));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const report = checkState(r2.state);
    expect(report.ok).toBe(true);
    expect(report.results.map((x) => x.invariant)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);
  });
});

import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2, vi } from '../src/geom/vec2.js';
import { Line, lineThrough, pointSideOfLine } from '../src/geom/line.js';
import { reflectionIso, compose } from '../src/geom/iso.js';
import { area, polysIdentical, polysInteriorDisjoint } from '../src/geom/poly.js';
import { Face, makeFace, foldedPoly } from '../src/state/face.js';
import { FaceId } from '../src/state/ids.js';
import { initialSquare, buildState } from '../src/state/state.js';
import { serialize, parse } from '../src/state/serialize.js';
import { splitAtAxis, renormalizeToCONF } from '../src/ops/split.js';

// ---- deterministic PRNG (no Math.random; G2) ----
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function confHolds(faces: readonly Face[]): boolean {
  const polys = faces.map(foldedPoly);
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = polys[i]!;
      const b = polys[j]!;
      if (polysIdentical(a, b)) continue;
      if (polysInteriorDisjoint(a, b)) continue;
      return false;
    }
  }
  return true;
}

function totalSrcArea(faces: readonly Face[]): Rat {
  let acc = Rat.ZERO;
  for (const f of faces) acc = acc.add(area(f.srcPoly));
  return acc;
}

// apply one synthetic fold: split at axis, reflect the movingSide faces, renormalize
function syntheticFold(
  faces: Face[],
  order: FaceId[],
  axis: Line,
  side: 1 | -1,
): { faces: Face[]; order: FaceId[] } {
  const split = splitAtAxis(faces, order, axis);
  const refl = reflectionIso(axis);
  const moved = split.faces.map((f) => {
    const fp = foldedPoly(f);
    const onSide = fp.every((p) => {
      const s = pointSideOfLine(axis, p);
      return s === 0 || s === side;
    });
    return onSide ? makeFace(f.id, f.srcPoly, compose(refl, f.T), f.parent) : f;
  });
  return renormalizeToCONF(moved, split.order);
}

describe('split-at-axis', () => {
  it('splits the initial square into f0:L and f0:R', () => {
    const s0 = initialSquare();
    const axis = lineThrough(
      { x: Rat.of(1n, 2n), y: Rat.ZERO },
      { x: Rat.of(1n, 2n), y: Rat.ONE },
    );
    const { faces, order } = splitAtAxis([...s0.faces.values()], [...s0.order], axis);
    const ids = faces.map((f) => f.id).sort();
    expect(ids).toEqual(['f0:L', 'f0:R']);
    expect(order.length).toBe(2);
    expect(totalSrcArea(faces).eq(Rat.ONE)).toBe(true);
  });

  it('the two halves occupy disjoint spots (no reflection yet)', () => {
    const s0 = initialSquare();
    const axis = lineThrough(
      { x: Rat.of(1n, 2n), y: Rat.ZERO },
      { x: Rat.of(1n, 2n), y: Rat.ONE },
    );
    const { faces } = splitAtAxis([...s0.faces.values()], [...s0.order], axis);
    expect(confHolds(faces)).toBe(true);
    expect(polysInteriorDisjoint(foldedPoly(faces[0]!), foldedPoly(faces[1]!))).toBe(true);
  });
});

describe('CONF holds under randomized synthetic reflections (M1 acceptance)', () => {
  const axes: Line[] = [
    lineThrough({ x: Rat.of(1n, 2n), y: Rat.ZERO }, { x: Rat.of(1n, 2n), y: Rat.ONE }),
    lineThrough({ x: Rat.ZERO, y: Rat.of(1n, 2n) }, { x: Rat.ONE, y: Rat.of(1n, 2n) }),
    lineThrough(vi(0, 0), vi(1, 1)),
    lineThrough({ x: Rat.of(1n, 3n), y: Rat.ZERO }, { x: Rat.of(1n, 3n), y: Rat.ONE }),
    lineThrough(vi(1, 0), vi(0, 1)),
    lineThrough({ x: Rat.ZERO, y: Rat.of(1n, 4n) }, { x: Rat.ONE, y: Rat.of(1n, 4n) }),
  ];

  for (const seed of [1, 7, 42, 1000, 65535]) {
    it(`seed ${seed}: 6 random folds keep CONF + area`, () => {
      const rng = lcg(seed);
      const s0 = initialSquare();
      let faces: Face[] = [...s0.faces.values()];
      let order: FaceId[] = [...s0.order];
      for (let round = 0; round < 6; round++) {
        const axis = axes[Math.floor(rng() * axes.length)]!;
        const side: 1 | -1 = rng() < 0.5 ? 1 : -1;
        const res = syntheticFold(faces, order, axis, side);
        faces = res.faces;
        order = res.order;
        expect(confHolds(faces)).toBe(true);
        expect(totalSrcArea(faces).eq(Rat.ONE)).toBe(true);
        // order stays a permutation of the face ids
        expect(new Set(order).size).toBe(faces.length);
      }
    });
  }
});

describe('serialization round-trip (§4.2)', () => {
  it('initial square round-trips exactly', () => {
    const s0 = initialSquare();
    const json = serialize(s0);
    expect(serialize(parse(json))).toBe(json);
  });

  it('a synthetically folded state round-trips exactly', () => {
    const rng = lcg(12345);
    const s0 = initialSquare();
    let faces: Face[] = [...s0.faces.values()];
    let order: FaceId[] = [...s0.order];
    const axes: Line[] = [
      lineThrough({ x: Rat.of(1n, 2n), y: Rat.ZERO }, { x: Rat.of(1n, 2n), y: Rat.ONE }),
      lineThrough({ x: Rat.ZERO, y: Rat.of(1n, 2n) }, { x: Rat.ONE, y: Rat.of(1n, 2n) }),
      lineThrough(vi(0, 0), vi(1, 1)),
    ];
    for (let r = 0; r < 4; r++) {
      const res = syntheticFold(faces, order, axes[Math.floor(rng() * axes.length)]!, 1);
      faces = res.faces;
      order = res.order;
    }
    const state = buildState({ faces, order, creases: new Map(), step: 4 });
    const json = serialize(state);
    const round = parse(json);
    expect(serialize(round)).toBe(json);
    // spots re-derive identically
    expect(round.spots.size).toBe(state.spots.size);
    expect(round.faces.size).toBe(state.faces.size);
  });
});

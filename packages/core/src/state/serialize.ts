/**
 * Deterministic JSON serialization (§4.2). Only persistent fields are written;
 * spots and edges are re-derived on parse, so the round-trip is exact and the
 * output is byte-identical for equal states (G2).
 */
import { Rat } from '../geom/rat.js';
import { Vec2 } from '../geom/vec2.js';
import { Iso } from '../geom/iso.js';
import { Poly } from '../geom/poly.js';
import { Face, makeFace } from './face.js';
import { CreaseRecord, PendingCrease, Assignment, segKey } from './edge.js';
import { asFaceId } from './ids.js';
import { FoldedState, buildState } from './state.js';

interface VecJSON {
  x: string;
  y: string;
}
interface IsoJSON {
  m: [[string, string], [string, string]];
  t: VecJSON;
}
interface FaceJSON {
  id: string;
  parent?: string;
  srcPoly: VecJSON[];
  T: IsoJSON;
}
interface CreaseJSON {
  seg: [VecJSON, VecJSON];
  assignment: Assignment;
}
export interface StateJSON {
  version: 1;
  step: number;
  faces: FaceJSON[];
  order: string[];
  creases: CreaseJSON[];
  pendingCreases: CreaseJSON[];
}

function vecJSON(v: Vec2): VecJSON {
  return { x: v.x.toString(), y: v.y.toString() };
}
function vecFrom(j: VecJSON): Vec2 {
  return { x: Rat.parse(j.x), y: Rat.parse(j.y) };
}
function isoJSON(T: Iso): IsoJSON {
  return {
    m: [
      [T.m[0][0].toString(), T.m[0][1].toString()],
      [T.m[1][0].toString(), T.m[1][1].toString()],
    ],
    t: vecJSON(T.t),
  };
}
function isoFrom(j: IsoJSON): Iso {
  return {
    m: [
      [Rat.parse(j.m[0][0]), Rat.parse(j.m[0][1])],
      [Rat.parse(j.m[1][0]), Rat.parse(j.m[1][1])],
    ],
    t: vecFrom(j.t),
  };
}

export function toJSON(state: FoldedState): StateJSON {
  const faces: FaceJSON[] = [...state.faces.values()]
    .map((f): FaceJSON => {
      const base: FaceJSON = {
        id: f.id,
        srcPoly: f.srcPoly.map(vecJSON),
        T: isoJSON(f.T),
      };
      return f.parent === undefined ? base : { ...base, parent: f.parent };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const creaseJSON = (c: { seg: readonly [Vec2, Vec2]; assignment: Assignment }): CreaseJSON => ({
    seg: [vecJSON(c.seg[0]), vecJSON(c.seg[1])],
    assignment: c.assignment,
  });
  const bySeg = (a: CreaseJSON, b: CreaseJSON): number => {
    const ka = segKey(vecFrom(a.seg[0]), vecFrom(a.seg[1]));
    const kb = segKey(vecFrom(b.seg[0]), vecFrom(b.seg[1]));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

  const creases = [...state.creases.values()].map(creaseJSON).sort(bySeg);
  const pendingCreases = [...state.pendingCreases].map(creaseJSON).sort(bySeg);

  return {
    version: 1,
    step: state.step,
    faces,
    order: [...state.order],
    creases,
    pendingCreases,
  };
}

/** Canonical serialized string (stable key order via explicit construction). */
export function serialize(state: FoldedState): string {
  return JSON.stringify(toJSON(state));
}

export function fromJSON(j: StateJSON): FoldedState {
  if (j.version !== 1) throw new Error(`serialize: unsupported version ${j.version}`);
  const faces: Face[] = j.faces.map((fj) => {
    const poly: Poly = fj.srcPoly.map(vecFrom);
    const parent = fj.parent === undefined ? undefined : asFaceId(fj.parent);
    return makeFace(asFaceId(fj.id), poly, isoFrom(fj.T), parent);
  });
  const creases = new Map<string, CreaseRecord>();
  for (const cj of j.creases) {
    const seg: [Vec2, Vec2] = [vecFrom(cj.seg[0]), vecFrom(cj.seg[1])];
    creases.set(segKey(seg[0], seg[1]), { seg, assignment: cj.assignment });
  }
  const pendingCreases: PendingCrease[] = j.pendingCreases.map((cj) => ({
    seg: [vecFrom(cj.seg[0]), vecFrom(cj.seg[1])] as [Vec2, Vec2],
    assignment: cj.assignment,
  }));
  return buildState({
    faces,
    order: j.order.map(asFaceId),
    creases,
    pendingCreases,
    step: j.step,
  });
}

export function parse(text: string): FoldedState {
  return fromJSON(JSON.parse(text) as StateJSON);
}

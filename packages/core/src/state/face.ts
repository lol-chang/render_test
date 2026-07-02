/** Faces: a convex source-space polygon carrying an exact isometry (§D2, §D3). */
import { Poly } from '../geom/poly.js';
import { Iso, applyIso, isFront } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { FaceId } from './ids.js';

export interface Face {
  readonly id: FaceId;
  readonly srcPoly: Poly;
  readonly T: Iso;
  readonly parent?: FaceId;
}

export function makeFace(id: FaceId, srcPoly: Poly, T: Iso, parent?: FaceId): Face {
  // exactOptionalPropertyTypes: only attach parent when defined
  return parent === undefined ? { id, srcPoly, T } : { id, srcPoly, T, parent };
}

/** Folded-space polygon of a face: T applied to each source vertex. */
export function foldedPoly(f: Face): Poly {
  return f.srcPoly.map((p): Vec2 => applyIso(f.T, p));
}

/** Front side up iff det(T) = +1 (§D3 side rule). */
export function faceIsFront(f: Face): boolean {
  return isFront(f.T);
}

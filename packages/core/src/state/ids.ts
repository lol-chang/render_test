/** Branded stable identifiers (§4.2). Ids are deterministic across runs. */

export type FaceId = string & { readonly __faceId: unique symbol };
export type EdgeId = string & { readonly __edgeId: unique symbol };
export type SpotId = string & { readonly __spotId: unique symbol };

export const ROOT_FACE = 'f0' as FaceId;

/**
 * Child id of a face split by a directed line: parent + ':L' (left, side > 0) or
 * ':R' (right, side < 0). Nesting under repeated splits keeps ids unique and
 * records parentage in the string itself (§4.2).
 */
export function childFaceId(parent: FaceId, side: 'L' | 'R'): FaceId {
  return `${parent}:${side}` as FaceId;
}

export function asFaceId(s: string): FaceId {
  return s as FaceId;
}
export function asSpotId(s: string): SpotId {
  return s as SpotId;
}
export function asEdgeId(s: string): EdgeId {
  return s as EdgeId;
}

/**
 * Immutable folded state (§D4, §4.1).
 *
 * Persistent fields: faces, the global layer `order` (a linear extension of the
 * per-spot stacks — bottom→top), the crease store, and the step counter. Spots and
 * edges are DERIVED deterministically from these, so serialization round-trips
 * exactly (§4.2) and the checker (§6) can recompute them independently.
 *
 * Layer model: rather than a global integer per face, we keep one total order over
 * all faces. Two faces are only ever *compared* when they share a spot (§D4), and a
 * spot's stack is simply `order` filtered to that spot's members. Splitting a face
 * replaces its id in `order` with its children (they inherit the parent's slot),
 * which is exactly the "split children inherit the parent's position" rule (§3.0).
 */
import { Poly } from '../geom/poly.js';
import { canonicalPolyKey } from '../geom/hash.js';
import { Face, foldedPoly } from './face.js';
import { Edge, CreaseRecord, PendingCrease, segKey, collinearOverlap, findCrease } from './edge.js';
import { FaceId, EdgeId, SpotId, ROOT_FACE, asSpotId, asEdgeId } from './ids.js';
import { makeFace } from './face.js';
import { IDENTITY } from '../geom/iso.js';
import { vi } from '../geom/vec2.js';
import type { Op } from '../ops/types.js';

export interface Spot {
  readonly id: SpotId;
  readonly poly: Poly; // folded-space polygon shared by all faces in the stack
  readonly stack: readonly FaceId[]; // bottom → top
}

export interface FoldedState {
  readonly faces: ReadonlyMap<FaceId, Face>;
  readonly edges: ReadonlyMap<EdgeId, Edge>;
  readonly spots: ReadonlyMap<SpotId, Spot>;
  readonly order: readonly FaceId[]; // global layer sequence, bottom → top
  readonly creases: ReadonlyMap<string, CreaseRecord>; // active folded creases, key = segKey
  readonly pendingCreases: readonly PendingCrease[]; // unfolded precrease annotations (§3.4)
  readonly step: number;
  readonly prev?: FoldedState;
  readonly lastOp?: Op;
}

/** Folded polygon of a face by id (throws if unknown). */
export function facePoly(state: FoldedState, id: FaceId): Poly {
  const f = state.faces.get(id);
  if (!f) throw new Error(`facePoly: unknown face ${id}`);
  return foldedPoly(f);
}

/** Group faces into spots by exact canonical folded-polygon key (§D4, §5.4). */
export function rebuildSpots(
  faces: ReadonlyMap<FaceId, Face>,
  order: readonly FaceId[],
): Map<SpotId, Spot> {
  const groups = new Map<string, FaceId[]>();
  for (const id of order) {
    const f = faces.get(id);
    if (!f) throw new Error(`rebuildSpots: order references unknown face ${id}`);
    const key = canonicalPolyKey(foldedPoly(f));
    const g = groups.get(key);
    if (g) g.push(id);
    else groups.set(key, [id]);
  }
  const spots = new Map<SpotId, Spot>();
  for (const [key, stack] of groups) {
    const rep = faces.get(stack[0]!)!;
    spots.set(asSpotId(key), { id: asSpotId(key), poly: foldedPoly(rep), stack });
  }
  return spots;
}

/**
 * Derive edges from source-space adjacency (§4.1). A source segment shared by two
 * faces is a SPLIT edge unless the crease store marks it CREASE; a segment adjacent
 * to no other face is BOUNDARY.
 *
 * SPEC-GAP: partially-shared source edges (half shared, half boundary) are not
 * subdivided here; every fold in v1 produces fully-shared-or-fully-boundary edges,
 * so this is exact for reachable states. Revisit if a v2 op breaks that.
 */
export function deriveEdges(
  faces: ReadonlyMap<FaceId, Face>,
  creases: ReadonlyMap<string, CreaseRecord>,
): Map<EdgeId, Edge> {
  const faceList = [...faces.values()];
  const edges = new Map<EdgeId, Edge>();
  const sharedSegs: boolean[][] = faceList.map((f) => f.srcPoly.map(() => false));

  for (let i = 0; i < faceList.length; i++) {
    const fi = faceList[i]!;
    for (let j = i + 1; j < faceList.length; j++) {
      const fj = faceList[j]!;
      for (let ei = 0; ei < fi.srcPoly.length; ei++) {
        const a0 = fi.srcPoly[ei]!;
        const a1 = fi.srcPoly[(ei + 1) % fi.srcPoly.length]!;
        for (let ej = 0; ej < fj.srcPoly.length; ej++) {
          const b0 = fj.srcPoly[ej]!;
          const b1 = fj.srcPoly[(ej + 1) % fj.srcPoly.length]!;
          const ov = collinearOverlap(a0, a1, b0, b1);
          if (!ov) continue;
          sharedSegs[i]![ei] = true;
          sharedSegs[j]![ej] = true;
          const key = segKey(ov[0], ov[1]);
          const [lo, hi] = fi.id < fj.id ? [fi.id, fj.id] : [fj.id, fi.id];
          const edgeId = asEdgeId(`${lo}~${hi}|${key}`);
          const crease = findCrease(creases.values(), ov);
          const edge: Edge = crease
            ? {
                id: edgeId,
                faces: [lo, hi],
                srcSeg: ov,
                kind: 'CREASE',
                assignment: crease.assignment,
              }
            : { id: edgeId, faces: [lo, hi], srcSeg: ov, kind: 'SPLIT' };
          edges.set(edgeId, edge);
        }
      }
    }
  }

  // boundary edges: source edges shared with no other face
  for (let i = 0; i < faceList.length; i++) {
    const fi = faceList[i]!;
    for (let ei = 0; ei < fi.srcPoly.length; ei++) {
      if (sharedSegs[i]![ei]) continue;
      const a0 = fi.srcPoly[ei]!;
      const a1 = fi.srcPoly[(ei + 1) % fi.srcPoly.length]!;
      const key = segKey(a0, a1);
      const edgeId = asEdgeId(`${fi.id}|B|${key}`);
      edges.set(edgeId, { id: edgeId, faces: [fi.id, null], srcSeg: [a0, a1], kind: 'BOUNDARY' });
    }
  }
  return edges;
}

/** Assemble a full immutable state from persistent fields (derives spots + edges). */
export function buildState(args: {
  faces: readonly Face[];
  order: readonly FaceId[];
  creases: ReadonlyMap<string, CreaseRecord>;
  pendingCreases?: readonly PendingCrease[];
  step: number;
  prev?: FoldedState;
  lastOp?: Op;
}): FoldedState {
  const faceMap = new Map<FaceId, Face>();
  for (const f of args.faces) faceMap.set(f.id, f);
  // order must be a permutation of face ids; append any stragglers deterministically
  const inOrder = new Set(args.order);
  const order = [...args.order];
  for (const f of args.faces) if (!inOrder.has(f.id)) order.push(f.id);

  const spots = rebuildSpots(faceMap, order);
  const edges = deriveEdges(faceMap, args.creases);
  const base = {
    faces: faceMap,
    edges,
    spots,
    order,
    creases: args.creases,
    pendingCreases: args.pendingCreases ?? [],
    step: args.step,
  };
  // exactOptionalPropertyTypes: attach optionals only when present
  const withPrev = args.prev === undefined ? base : { ...base, prev: args.prev };
  return args.lastOp === undefined ? withPrev : { ...withPrev, lastOp: args.lastOp };
}

/** The initial unit-square state: single face f0, identity transform (§D1). */
export function initialSquare(): FoldedState {
  const f0 = makeFace(ROOT_FACE, [vi(0, 0), vi(1, 0), vi(1, 1), vi(0, 1)], IDENTITY);
  return buildState({
    faces: [f0],
    order: [ROOT_FACE],
    creases: new Map(),
    step: 0,
  });
}

/**
 * FOLD operation, mode ONE_LAYER (§3.2): fold only the top (V) / bottom (M) flap.
 *
 * Moving-set selection is a deterministic closure: seed the flap at the hinge, then
 * pull in everything connected to it through a non-axis edge (an off-axis connection
 * would tear). Preconditions P1 (no tearing / hinge anchoring) and P2 (extractability
 * — movers are already on the correct side of every shared stack) are checked with
 * machine-readable witnesses before any geometry is applied.
 *
 * Lemma L2 (motion feasibility): given P1 + P2 on a flat state, the 180° rotation of
 * the moving set is collision-free — where movers and statics share xy-support they
 * are separated in stack order on the correct side (P2), and elsewhere the sweep arc
 * stays strictly above/below the plane except at the hinge. So the viewer needs no
 * collision detection; the discrete engine has already proven feasibility.
 */
import { Line, lineThrough, pointSideOfLine } from '../geom/line.js';
import { applyIso } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { Face } from '../state/face.js';
import { collinearOverlap } from '../state/edge.js';
import { FaceId, EdgeId, asEdgeId, SpotId } from '../state/ids.js';
import { segKey } from '../state/edge.js';
import { FoldedState, rebuildSpots, Spot } from '../state/state.js';
import { splitAtAxis } from './split.js';
import { FoldOp, Result, err } from './types.js';
import { sideSign, faceSide, commitPlan, PlanResult } from './fold.js';

interface Adjacency {
  readonly neighbor: FaceId;
  readonly seg: readonly [Vec2, Vec2];
  readonly onAxis: boolean; // folded image of the shared segment lies on the axis
}

/** Build the source-space adjacency map, tagging each shared edge on/off the axis. */
function buildAdjacency(
  faces: readonly Face[],
  axis: Line,
): Map<FaceId, Adjacency[]> {
  const adj = new Map<FaceId, Adjacency[]>();
  const push = (id: FaceId, a: Adjacency) => {
    const list = adj.get(id);
    if (list) list.push(a);
    else adj.set(id, [a]);
  };
  for (let i = 0; i < faces.length; i++) {
    const fi = faces[i]!;
    for (let j = i + 1; j < faces.length; j++) {
      const fj = faces[j]!;
      for (let ei = 0; ei < fi.srcPoly.length; ei++) {
        const a0 = fi.srcPoly[ei]!;
        const a1 = fi.srcPoly[(ei + 1) % fi.srcPoly.length]!;
        for (let ej = 0; ej < fj.srcPoly.length; ej++) {
          const b0 = fj.srcPoly[ej]!;
          const b1 = fj.srcPoly[(ej + 1) % fj.srcPoly.length]!;
          const ov = collinearOverlap(a0, a1, b0, b1);
          if (!ov) continue;
          const f0 = applyIso(fi.T, ov[0]);
          const f1 = applyIso(fi.T, ov[1]);
          const onAxis =
            pointSideOfLine(axis, f0) === 0 && pointSideOfLine(axis, f1) === 0;
          push(fi.id, { neighbor: fj.id, seg: ov, onAxis });
          push(fj.id, { neighbor: fi.id, seg: ov, onAxis });
        }
      }
    }
  }
  return adj;
}

/** A spot lies on the moving side and has an edge on the axis (touches the hinge). */
function spotSeedsHinge(spot: Spot, axis: Line, target: 1 | -1): boolean {
  const sides = spot.poly.map((p) => pointSideOfLine(axis, p));
  const onSide = sides.every((s) => s === 0 || s === target);
  if (!onSide || !sides.some((s) => s === target)) return false;
  const n = spot.poly.length;
  for (let i = 0; i < n; i++) {
    if (sides[i] === 0 && sides[(i + 1) % n] === 0) return true; // an edge on the axis
  }
  return false;
}

function edgeIdFor(a: FaceId, b: FaceId, seg: readonly [Vec2, Vec2]): EdgeId {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return asEdgeId(`${lo}~${hi}|${segKey(seg[0], seg[1])}`);
}

/**
 * Plan a FOLD ONE_LAYER (seeds → closure → P1 → P2) without committing, so the
 * viewer can animate the exact moving set the engine would fold (§8.2).
 */
export function planOneLayer(state: FoldedState, op: FoldOp): PlanResult {
  let axis: Line;
  try {
    axis = lineThrough(op.axis.a, op.axis.b);
  } catch {
    return { error: { code: 'E_AXIS_DEGENERATE' } };
  }

  // 1. split-at-axis
  const split = splitAtAxis([...state.faces.values()], [...state.order], axis);
  const { faces, order } = split;
  const faceMap = new Map(faces.map((f) => [f.id, f] as const));
  const target = sideSign(op.movingSide);
  const spots = rebuildSpots(faceMap, order);

  // 2. seeds
  const M = new Set<FaceId>();
  if (op.seedFaceIds && op.seedFaceIds.length > 0) {
    // seeds refer to pre-split ids; expand to surviving faces (self or split children)
    for (const seed of op.seedFaceIds) {
      for (const f of faces) {
        if (f.id === seed || f.id.startsWith(`${seed}:`)) M.add(f.id);
      }
    }
    if (M.size === 0) return { error: { code: 'E_EMPTY_MOVE' } };
  } else {
    for (const spot of spots.values()) {
      if (!spotSeedsHinge(spot, axis, target)) continue;
      const seed = op.direction === 'V' ? spot.stack[spot.stack.length - 1]! : spot.stack[0]!;
      M.add(seed);
    }
    if (M.size === 0) return { error: { code: 'E_EMPTY_MOVE' } };
  }

  // 3. closure: pull in faces connected through a non-axis edge (would tear otherwise)
  const adj = buildAdjacency(faces, axis);
  const queue = [...M];
  while (queue.length > 0) {
    const f = queue.pop()!;
    for (const a of adj.get(f) ?? []) {
      if (a.onAxis || M.has(a.neighbor)) continue;
      M.add(a.neighbor);
      queue.push(a.neighbor);
    }
  }

  // 4. P1 — no tearing / hinge anchoring
  const complementEmpty = M.size === faces.length;
  if (complementEmpty) return { error: { code: 'E_TEAR', edges: [] } };

  const tearEdges: EdgeId[] = [];
  // (a) every M↔complement shared edge must be on the axis
  for (const f of faces) {
    if (!M.has(f.id)) continue;
    for (const a of adj.get(f.id) ?? []) {
      if (!M.has(a.neighbor) && !a.onAxis) {
        tearEdges.push(edgeIdFor(f.id, a.neighbor, a.seg));
      }
    }
  }
  // (b) every mover must lie entirely on the moving side
  for (const id of M) {
    if (faceSide(faceMap.get(id)!, axis) !== target) {
      // witness: any hinge/edge of this mis-sided mover to the complement
      for (const a of adj.get(id) ?? []) {
        if (!M.has(a.neighbor)) tearEdges.push(edgeIdFor(id, a.neighbor, a.seg));
      }
      if (tearEdges.length === 0) tearEdges.push(asEdgeId(`mis-sided:${id}`));
    }
  }
  if (tearEdges.length > 0) return { error: { code: 'E_TEAR', edges: tearEdges } };

  // 5. P2 — extractability. In every spot with both a mover and a static, movers must
  //    be above (V) / below (M) every static, so the flap can lift off cleanly.
  for (const spot of spots.values()) {
    const stack = spot.stack;
    const moverIdx: number[] = [];
    const staticIdx: number[] = [];
    stack.forEach((id, i) => (M.has(id) ? moverIdx : staticIdx).push(i));
    if (moverIdx.length === 0 || staticIdx.length === 0) continue;
    const minMover = Math.min(...moverIdx);
    const maxMover = Math.max(...moverIdx);
    const minStatic = Math.min(...staticIdx);
    const maxStatic = Math.max(...staticIdx);
    const wantAbove = op.direction === 'V';
    const good = wantAbove ? minMover > maxStatic : maxMover < minStatic;
    if (!good) {
      // witness: a mover/static pair on the wrong side
      let mover: FaceId | null = null;
      let stat: FaceId | null = null;
      for (const mi of moverIdx) {
        for (const si of staticIdx) {
          if (wantAbove ? mi < si : mi > si) {
            mover = stack[mi]!;
            stat = stack[si]!;
            break;
          }
        }
        if (mover) break;
      }
      return { error: { code: 'E_BLOCKED', spot: spot.id as SpotId, pair: [mover!, stat!] } };
    }
  }

  return { plan: { axis, faces, order, moverSet: M, direction: op.direction } };
}

export function foldOneLayer(state: FoldedState, op: FoldOp): Result {
  const r = planOneLayer(state, op);
  if ('error' in r) return err(r.error);
  return commitPlan(state, r.plan, op);
}

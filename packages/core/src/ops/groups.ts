import { Line, lineThrough, pointSideOfLine } from '../geom/line.js';
import { applyIso } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { Face } from '../state/face.js';
import { collinearOverlap } from '../state/edge.js';
import { FaceId, SpotId } from '../state/ids.js';
import { FoldedState, rebuildSpots } from '../state/state.js';
import { splitAtAxis } from './split.js';
import { faceSide, sideSign } from './fold.js';
import { AxisSpec, MovingSide, OpError } from './types.js';
import type { Assignment } from '../state/edge.js';

export interface GroupLayer {
  readonly spot: SpotId;
  readonly depth: number;
  readonly indices: readonly number[];
  readonly stackSize: number;
}

export interface FoldGroup {
  readonly seed: FaceId;
  readonly faces: readonly FaceId[];
  readonly layers: readonly GroupLayer[];
  readonly bonded: boolean;
  readonly bondedTo: readonly FaceId[];
  readonly foldable: boolean;
  readonly reason?: OpError | undefined;
}

export interface FoldGroupsResult {
  readonly groups: readonly FoldGroup[];
  readonly error?: OpError | undefined;
}

interface Bond { readonly neighbor: FaceId; readonly onAxis: boolean }

function bonds(faces: readonly Face[], axis: Line): Map<FaceId, Bond[]> {
  const adj = new Map<FaceId, Bond[]>();
  const push = (id: FaceId, b: Bond): void => {
    const l = adj.get(id);
    if (l) l.push(b); else adj.set(id, [b]);
  };
  for (let i = 0; i < faces.length; i++) {
    const fi = faces[i]!;
    for (let j = i + 1; j < faces.length; j++) {
      const fj = faces[j]!;
      let found: { seg: readonly [Vec2, Vec2] } | null = null;
      let onAxis = false;
      for (let ei = 0; ei < fi.srcPoly.length && !found; ei++) {
        const a0 = fi.srcPoly[ei]!;
        const a1 = fi.srcPoly[(ei + 1) % fi.srcPoly.length]!;
        for (let ej = 0; ej < fj.srcPoly.length; ej++) {
          const b0 = fj.srcPoly[ej]!;
          const b1 = fj.srcPoly[(ej + 1) % fj.srcPoly.length]!;
          const ov = collinearOverlap(a0, a1, b0, b1);
          if (!ov) continue;
          const f0 = applyIso(fi.T, ov[0]);
          const f1 = applyIso(fi.T, ov[1]);
          onAxis = pointSideOfLine(axis, f0) === 0 && pointSideOfLine(axis, f1) === 0;
          found = { seg: ov };
          break;
        }
      }
      if (!found) continue;
      push(fi.id, { neighbor: fj.id, onAxis });
      push(fj.id, { neighbor: fi.id, onAxis });
    }
  }
  return adj;
}

/**
 * Every set of layers this axis can lift, and for each one whether it moves alone or
 * drags others with it.
 *
 * Peeling k layers off a stack is only a wish: what actually leaves the paper is that
 * wish closed under every off-axis bond, because paper joined anywhere but the hinge
 * cannot come apart. So each candidate is grown from a seed by that closure, and what
 * the closure added is exactly the set the caller could not have chosen freely — the
 * bonded layers. A group is then offered as foldable only if it also passes the two
 * physical preconditions: nothing tears (every mover/static seam lies on the axis, and
 * no mover straddles it) and the group is extractable (in every shared stack the movers
 * sit entirely above, for a valley, or entirely below, for a mountain).
 */
export function foldGroups(
  state: FoldedState,
  axis: AxisSpec,
  movingSide: MovingSide,
  direction: Assignment,
): FoldGroupsResult {
  let line: Line;
  try {
    line = lineThrough(axis.a, axis.b);
  } catch {
    return { groups: [], error: { code: 'E_AXIS_DEGENERATE' } };
  }
  const split = splitAtAxis([...state.faces.values()], [...state.order], line);
  const { faces, order } = split;
  const faceMap = new Map(faces.map((f) => [f.id, f] as const));
  const target = sideSign(movingSide);
  const spots = rebuildSpots(faceMap, order);
  const adj = bonds(faces, line);
  const wantAbove = direction === 'V';

  const closure = (seeds: readonly FaceId[]): Set<FaceId> => {
    const M = new Set<FaceId>(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const f = queue.pop()!;
      for (const b of adj.get(f) ?? []) {
        if (b.onAxis || M.has(b.neighbor)) continue;
        M.add(b.neighbor);
        queue.push(b.neighbor);
      }
    }
    return M;
  };

  const judge = (M: ReadonlySet<FaceId>): OpError | undefined => {
    if (M.size === faces.length) return { code: 'E_TEAR', edges: [] };
    for (const id of M) {
      if (faceSide(faceMap.get(id)!, line) !== target) return { code: 'E_TEAR', edges: [] };
      for (const b of adj.get(id) ?? []) {
        if (!M.has(b.neighbor) && !b.onAxis) return { code: 'E_TEAR', edges: [] };
      }
    }
    for (const spot of spots.values()) {
      const moverIdx: number[] = [];
      const staticIdx: number[] = [];
      spot.stack.forEach((id, i) => (M.has(id) ? moverIdx : staticIdx).push(i));
      if (moverIdx.length === 0 || staticIdx.length === 0) continue;
      const good = wantAbove
        ? Math.min(...moverIdx) > Math.max(...staticIdx)
        : Math.max(...moverIdx) < Math.min(...staticIdx);
      if (!good) {
        const mover = spot.stack[wantAbove ? Math.min(...moverIdx) : Math.max(...moverIdx)]!;
        const stat = spot.stack[wantAbove ? Math.max(...staticIdx) : Math.min(...staticIdx)]!;
        return { code: 'E_BLOCKED', spot: spot.id as SpotId, pair: [mover, stat] };
      }
    }
    return undefined;
  };

  const out: FoldGroup[] = [];
  const seen = new Set<string>();
  for (const spot of spots.values()) {
    const sides = spot.poly.map((p) => pointSideOfLine(line, p));
    if (!sides.every((s) => s === 0 || s === target)) continue;
    if (!sides.some((s) => s === target)) continue;
    const n = spot.stack.length;
    for (let k = 1; k <= n; k++) {
      const seeds = wantAbove ? spot.stack.slice(n - k) : spot.stack.slice(0, k);
      const seed = wantAbove ? spot.stack[n - 1]! : spot.stack[0]!;
      const M = closure(seeds);
      const key = [...M].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const layers: GroupLayer[] = [];
      for (const sp of spots.values()) {
        const idx: number[] = [];
        sp.stack.forEach((id, i) => { if (M.has(id)) idx.push(i); });
        if (idx.length === 0) continue;
        layers.push({
          spot: sp.id as SpotId,
          depth: wantAbove ? sp.stack.length - Math.min(...idx) : Math.max(...idx) + 1,
          indices: idx,
          stackSize: sp.stack.length,
        });
      }
      const bondedTo = [...M].filter((id) => !seeds.includes(id)).sort();
      const reason = judge(M);
      out.push({
        seed,
        faces: [...M].sort(),
        layers,
        bonded: bondedTo.length > 0,
        bondedTo,
        foldable: reason === undefined,
        reason,
      });
    }
  }
  out.sort((a, b) => a.faces.length - b.faces.length);
  return { groups: out };
}

/**
 * INSIDE_REVERSE_FOLD (§3.3).
 *
 * A reverse fold reflects a flap's tip across the crease — the SAME reflection geometry
 * a FOLD would apply — but the reversed tip is tucked BETWEEN existing layers rather than
 * lifted clear of them. ONE_LAYER's extractability precondition (P2) exists precisely to
 * forbid that nesting, so the reverse fold cannot be expressed as a plain fold; it is its
 * own operation.
 *
 * Mechanics:
 *   1. split at the axis (shared machinery with FOLD),
 *   2. movers = the tip — every face on the moving side (seed closure when seeded),
 *   3. reflect the movers across the axis,
 *   4. record the hinge crease so the new mover↔static edge is a CREASE (I1),
 *   5. choose the layer interleaving: keep statics and movers each in their own relative
 *      order and search the interleavings for one the checker accepts, preferring a
 *      genuinely nested arrangement (movers neither all-top nor all-bottom) so the result
 *      is a reverse fold and not an accidental plain fold.
 *
 * The chosen order is verified by the independent checker (I1–I6) before it is returned,
 * so a success is a provably valid flat state.
 */
import { Line, lineThrough } from '../geom/line.js';
import { reflectionIso, compose } from '../geom/iso.js';
import { makeFace } from '../state/face.js';
import { FaceId } from '../state/ids.js';
import { FoldedState, buildState } from '../state/state.js';
import { checkState } from '../check/checker.js';
import { splitAtAxis, renormalizeToCONF } from './split.js';
import { faceSide, sideSign, recordHingeCreases } from './fold.js';
import { InsideReverseFoldOp, Result, ok, err } from './types.js';

/**
 * Candidate layer orders, cheapest first. A reverse/petal fold keeps the reversed tip
 * together, so try inserting the movers as ONE contiguous block (in order, then reversed)
 * at each gap between the statics — O(n) placements. A block wedged strictly inside the
 * statics is the nested (non-trivial) reverse fold; the two extreme placements are the
 * plain folds. Only if no block placement is accepted do we fall back to a bounded search
 * over general interleavings.
 */
function* candidateOrders(statics: FaceId[], movers: FaceId[]): Generator<FaceId[]> {
  const blocks = movers.length > 1 ? [movers, [...movers].reverse()] : [movers];
  for (const block of blocks) {
    for (let pos = 0; pos <= statics.length; pos++) {
      yield [...statics.slice(0, pos), ...block, ...statics.slice(pos)];
    }
  }
  // Fallback: general interleavings — but only when the fan-out is small. The count grows
  // as C(n,k), so for deep states skip it (block placement already covers reverse folds).
  if (statics.length + movers.length <= 12) yield* interleavings(statics, movers);
}

function* interleavings(a: FaceId[], b: FaceId[]): Generator<FaceId[]> {
  if (a.length === 0) {
    yield [...b];
    return;
  }
  if (b.length === 0) {
    yield [...a];
    return;
  }
  for (const rest of interleavings(a.slice(1), b)) yield [a[0]!, ...rest];
  for (const rest of interleavings(a, b.slice(1))) yield [b[0]!, ...rest];
}

/** True when the movers sit entirely at the top or entirely at the bottom (a plain fold). */
function isTrivial(order: FaceId[], moverSet: ReadonlySet<FaceId>): boolean {
  const idx = order.map((id, i) => (moverSet.has(id) ? i : -1)).filter((i) => i >= 0);
  const k = idx.length;
  const n = order.length;
  const allTop = idx[0] === n - k;
  const allBottom = idx[k - 1] === k - 1;
  return allTop || allBottom;
}

export function insideReverseFold(state: FoldedState, op: InsideReverseFoldOp): Result {
  let axis: Line;
  try {
    axis = lineThrough(op.axis.a, op.axis.b);
  } catch {
    return err({ code: 'E_AXIS_DEGENERATE' });
  }

  const split = splitAtAxis([...state.faces.values()], [...state.order], axis);
  const target = sideSign(op.movingSide);

  const moverSet = new Set<FaceId>();
  if (op.seedFaceIds && op.seedFaceIds.length > 0) {
    for (const seed of op.seedFaceIds) {
      for (const f of split.faces) {
        if ((f.id === seed || f.id.startsWith(`${seed}:`)) && faceSide(f, axis) === target) {
          moverSet.add(f.id);
        }
      }
    }
  } else {
    for (const f of split.faces) if (faceSide(f, axis) === target) moverSet.add(f.id);
  }
  if (moverSet.size === 0 || moverSet.size === split.faces.length) {
    return err({ code: 'E_EMPTY_MOVE' });
  }

  const refl = reflectionIso(axis);
  const moved = split.faces.map((f) =>
    moverSet.has(f.id) ? makeFace(f.id, f.srcPoly, compose(refl, f.T), f.parent) : f,
  );
  const creases = recordHingeCreases(moved, moverSet, axis, op.direction, state.creases);

  // CONF renormalization is geometry-only and order-independent, so run it ONCE. Only the
  // layer order then varies across candidates — no re-splitting per candidate.
  const renorm = renormalizeToCONF(moved, split.order);
  const isMover = (fid: FaceId): boolean =>
    [...moverSet].some((m) => fid === m || fid.startsWith(`${m}:`));
  const staticsF = renorm.order.filter((id) => !isMover(id));
  const moversF = renorm.order.filter((id) => isMover(id));
  const moverFinal = new Set(moversF);

  // Prefer a genuinely nested order (movers wedged inside); fall back to any valid order.
  let fallback: FoldedState | null = null;
  let iter = 0;
  for (const ord of candidateOrders(staticsF, moversF)) {
    if (++iter > 4000) break;
    const next = buildState({
      faces: renorm.faces,
      order: ord,
      creases,
      pendingCreases: state.pendingCreases,
      step: state.step + 1,
      prev: state,
      lastOp: op,
    });
    const report = checkState(next);
    if (!report.ok) continue;
    if (!isTrivial(ord, moverFinal)) return ok(next, report);
    if (!fallback) fallback = next;
  }
  if (fallback) return ok(fallback, checkState(fallback));
  return err({ code: 'E_UNSUPPORTED', detail: 'no valid reverse-fold layer order' });
}

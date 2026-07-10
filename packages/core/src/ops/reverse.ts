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

/** Interleavings of two sequences that preserve each one's internal order. */
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

  const statics = split.order.filter((id) => !moverSet.has(id));
  const movers = split.order.filter((id) => moverSet.has(id));

  // Prefer a genuinely nested interleaving; fall back to any valid order.
  let fallback: FoldedState | null = null;
  let iter = 0;
  for (const ord of interleavings(statics, movers)) {
    if (++iter > 5000) break;
    const renorm = renormalizeToCONF(moved, ord);
    const next = buildState({
      faces: renorm.faces,
      order: renorm.order,
      creases,
      pendingCreases: state.pendingCreases,
      step: state.step + 1,
      prev: state,
      lastOp: op,
    });
    const report = checkState(next);
    if (!report.ok) continue;
    if (!isTrivial(ord, moverSet)) return ok(next, report);
    if (!fallback) fallback = next;
  }
  if (fallback) return ok(fallback, checkState(fallback));
  return err({ code: 'E_UNSUPPORTED', detail: 'no valid reverse-fold layer order' });
}

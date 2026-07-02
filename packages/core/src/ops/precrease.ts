/**
 * PRECREASE (§3.4): fold, then unfold — mark remains, geometry does NOT change.
 *
 * Annotation-only: validate the equivalent FOLD on a scratch state (so P1/P2/checker
 * all apply), then commit ONLY by appending the hinge segments (source space, with
 * intrinsic assignment) to `state.pendingCreases`. No faces are split and no edges
 * are created — the split happens lazily later, in split-at-axis, if a real fold ever
 * uses that line. So a precrease never changes the face count.
 */
import { Line, lineThrough } from '../geom/line.js';
import { FaceId } from '../state/ids.js';
import { PendingCrease, segKey } from '../state/edge.js';
import { FoldedState, buildState } from '../state/state.js';
import { splitAtAxis } from './split.js';
import { checkState } from '../check/checker.js';
import { PrecreaseOp, FoldOp, Result, ok, err } from './types.js';
import { foldAll, sideSign, faceSide, hingeCreases } from './fold.js';

export function precrease(state: FoldedState, op: PrecreaseOp): Result {
  // 1. validate the fold would actually be legal (reuses the full FOLD ALL pipeline)
  const trial: FoldOp = {
    type: 'FOLD',
    mode: 'ALL',
    axis: op.axis,
    movingSide: op.movingSide,
    direction: op.direction,
  };
  const validation = foldAll(state, trial);
  if (!validation.ok) return validation; // propagate E_EMPTY_MOVE / E_INVARIANT / …

  // 2. compute the hinge segments on a scratch split (not committed), then annotate
  let axis: Line;
  try {
    axis = lineThrough(op.axis.a, op.axis.b);
  } catch {
    return err({ code: 'E_AXIS_DEGENERATE' });
  }
  const split = splitAtAxis([...state.faces.values()], [...state.order], axis);
  const target = sideSign(op.movingSide);
  const moverSet = new Set<FaceId>();
  for (const f of split.faces) if (faceSide(f, axis) === target) moverSet.add(f.id);
  const marks = hingeCreases(split.faces, moverSet, axis, op.direction);

  // 3. commit: original geometry unchanged, hinge segments appended as pending creases
  const seen = new Set(state.pendingCreases.map((c) => segKey(c.seg[0], c.seg[1])));
  const pendingCreases: PendingCrease[] = [...state.pendingCreases];
  for (const m of marks) {
    const key = segKey(m.seg[0], m.seg[1]);
    if (!seen.has(key)) {
      seen.add(key);
      pendingCreases.push(m);
    }
  }

  const next = buildState({
    faces: [...state.faces.values()],
    order: [...state.order],
    creases: state.creases,
    pendingCreases,
    step: state.step + 1,
    prev: state,
    lastOp: op,
  });
  const report = checkState(next);
  if (!report.ok) {
    const failed = report.results.find((r) => !r.pass)!;
    return err({ code: 'E_INVARIANT', invariant: failed.invariant, witness: failed.witness });
  }
  return ok(next, report);
}

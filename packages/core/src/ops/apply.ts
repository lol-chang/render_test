/** Operation dispatcher (§3). Pure: apply(state, op) → Result. */
import { FoldedState } from '../state/state.js';
import { checkState } from '../check/checker.js';
import { Op, FoldOp, Result, ok, err } from './types.js';
import { foldAll, planFoldAll, PlanResult } from './fold.js';
import { foldOneLayer, planOneLayer } from './onelayer.js';
import { flip } from './flip.js';
import { precrease } from './precrease.js';

/** Plan a FOLD without committing (moving set + hinge) — used by the viewer to animate. */
export function planFold(state: FoldedState, op: FoldOp): PlanResult {
  return op.mode === 'ALL' ? planFoldAll(state, op) : planOneLayer(state, op);
}

/** Revert to the state before the last `count` ops (§3.5). Snapshot-based, O(1). */
export function unfoldLast(state: FoldedState, count: number): Result {
  if (count < 1) return err({ code: 'E_UNSUPPORTED', detail: 'UNFOLD_LAST count < 1' });
  let s: FoldedState = state;
  for (let i = 0; i < count; i++) {
    if (s.prev === undefined) {
      return err({ code: 'E_UNSUPPORTED', detail: 'nothing to unfold' });
    }
    s = s.prev;
  }
  return ok(s, checkState(s));
}

export function applyOp(state: FoldedState, op: Op): Result {
  switch (op.type) {
    case 'FOLD':
      if (op.mode === 'ALL') return foldAll(state, op);
      return foldOneLayer(state, op);
    case 'FLIP':
      return flip(state, op);
    case 'PRECREASE':
      return precrease(state, op);
    case 'UNFOLD_LAST':
      return unfoldLast(state, op.count ?? 1);
  }
}

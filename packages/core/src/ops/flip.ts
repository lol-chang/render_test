/**
 * FLIP: turn the whole model over (§3.3). Reflect every face about the flip axis,
 * reverse every stack (⇔ reverse the global order), sides flip via det automatically.
 * No creases are created; intrinsic M/V assignments are untouched (their view-
 * dependent appearance is recomputed at render time, never rewritten).
 */
import { Rat } from '../geom/rat.js';
import { Line, lineThrough } from '../geom/line.js';
import { reflectionIso, compose } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { makeFace, foldedPoly } from '../state/face.js';
import { FoldedState, buildState } from '../state/state.js';
import { renormalizeToCONF } from './split.js';
import { checkState } from '../check/checker.js';
import { FlipOp, Result, ok, err } from './types.js';

function boundingCenter(state: FoldedState): { cx: Rat; cy: Rat } {
  let minX: Rat | null = null;
  let maxX: Rat | null = null;
  let minY: Rat | null = null;
  let maxY: Rat | null = null;
  for (const f of state.faces.values()) {
    for (const p of foldedPoly(f)) {
      minX = minX === null || p.x.cmp(minX) < 0 ? p.x : minX;
      maxX = maxX === null || p.x.cmp(maxX) > 0 ? p.x : maxX;
      minY = minY === null || p.y.cmp(minY) < 0 ? p.y : minY;
      maxY = maxY === null || p.y.cmp(maxY) > 0 ? p.y : maxY;
    }
  }
  const two = Rat.of(2n);
  return { cx: minX!.add(maxX!).div(two), cy: minY!.add(maxY!).div(two) };
}

function resolveFlipAxis(state: FoldedState, spec: FlipOp['axis']): Line {
  if (spec !== undefined && typeof spec !== 'string') {
    return lineThrough(spec.a, spec.b);
  }
  const { cx, cy } = boundingCenter(state);
  if (spec === 'horizontal') {
    // horizontal mirror line y = cy
    return lineThrough({ x: Rat.ZERO, y: cy }, { x: Rat.ONE, y: cy });
  }
  // default / 'vertical': mirror line x = cx
  return lineThrough({ x: cx, y: Rat.ZERO }, { x: cx, y: Rat.ONE });
}

export function flip(state: FoldedState, op: FlipOp): Result {
  let axis: Line;
  try {
    axis = resolveFlipAxis(state, op.axis);
  } catch {
    return err({ code: 'E_AXIS_DEGENERATE' });
  }
  const refl = reflectionIso(axis);
  const faces = [...state.faces.values()].map((f) =>
    makeFace(f.id, f.srcPoly, compose(refl, f.T), f.parent),
  );
  const order = [...state.order].reverse();
  // uniform reflection preserves CONF; renormalize defensively (should be a no-op).
  const renorm = renormalizeToCONF(faces, order);
  const next = buildState({
    faces: renorm.faces,
    order: renorm.order,
    creases: state.creases,
    pendingCreases: state.pendingCreases,
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

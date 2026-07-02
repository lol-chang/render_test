/**
 * FOLD operation, mode ALL (§3.1), plus the shared machinery ONE_LAYER reuses (M3).
 * Pipeline: split-at-axis → moving set → record creases → reflect movers →
 * deterministic layer update (reversal rule) → CONF → check.
 */
import { Line, lineThrough, pointSideOfLine } from '../geom/line.js';
import { reflectionIso, compose, sideParity, applyIso } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { Face, makeFace, foldedPoly } from '../state/face.js';
import { CreaseRecord, Assignment, collinearOverlap, segKey } from '../state/edge.js';
import { FaceId } from '../state/ids.js';
import { FoldedState, buildState } from '../state/state.js';
import { splitAtAxis, renormalizeToCONF } from './split.js';
import { checkState } from '../check/checker.js';
import { FoldOp, MovingSide, Result, ok, err } from './types.js';

/** Directed-axis side that a movingSide label selects: left = +1, right = -1. */
export function sideSign(side: MovingSide): 1 | -1 {
  return side === 'left' ? 1 : -1;
}

/** Strict side of a (post-split) face relative to the axis: +1 left, -1 right. */
export function faceSide(f: Face, axis: Line): 1 | -1 | 0 {
  let seen: 1 | -1 | 0 = 0;
  for (const p of foldedPoly(f)) {
    const s = pointSideOfLine(axis, p);
    if (s === 0) continue;
    if (seen === 0) seen = s;
    else if (seen !== s) return 0; // straddles — should not happen post-split
  }
  return seen;
}

export function flipAssign(a: Assignment): Assignment {
  return a === 'V' ? 'M' : 'V';
}

/**
 * Convert a view-relative valley/mountain (as diagrams/users specify) to the
 * intrinsic assignment stored on the crease (§3.1). If the sheet shows its front
 * (parity +1) the view direction is intrinsic; if it shows its back, it flips.
 */
export function intrinsicAssignment(viewDir: Assignment, parity: 1 | -1): Assignment {
  return parity === 1 ? viewDir : flipAssign(viewDir);
}

/**
 * Source segment shared by two faces whose folded image lies on the axis line
 * (a hinge). Returns null if they share no such segment.
 */
export function sharedAxisSeg(a: Face, b: Face, axis: Line): [Vec2, Vec2] | null {
  const na = a.srcPoly.length;
  const nb = b.srcPoly.length;
  for (let i = 0; i < na; i++) {
    const a0 = a.srcPoly[i]!;
    const a1 = a.srcPoly[(i + 1) % na]!;
    for (let j = 0; j < nb; j++) {
      const b0 = b.srcPoly[j]!;
      const b1 = b.srcPoly[(j + 1) % nb]!;
      const ov = collinearOverlap(a0, a1, b0, b1);
      if (!ov) continue;
      const f0 = applyIso(a.T, ov[0]);
      const f1 = applyIso(a.T, ov[1]);
      if (pointSideOfLine(axis, f0) === 0 && pointSideOfLine(axis, f1) === 0) return ov;
    }
  }
  return null;
}

/** Record intrinsic creases on every hinge between a mover and a static (§3.1 step 1). */
/** Collect the source-space hinge segments (with intrinsic assignment) of a fold. */
export function hingeCreases(
  faces: readonly Face[],
  moverSet: ReadonlySet<FaceId>,
  axis: Line,
  viewDir: Assignment,
): CreaseRecord[] {
  const out: CreaseRecord[] = [];
  const statics = faces.filter((f) => !moverSet.has(f.id));
  for (const m of faces) {
    if (!moverSet.has(m.id)) continue;
    for (const s of statics) {
      const seg = sharedAxisSeg(m, s, axis);
      if (!seg) continue;
      out.push({ seg, assignment: intrinsicAssignment(viewDir, sideParity(s.T)) });
    }
  }
  return out;
}

/** Record folded hinge creases into the active-crease store (keyed by segKey). */
export function recordHingeCreases(
  faces: readonly Face[],
  moverSet: ReadonlySet<FaceId>,
  axis: Line,
  viewDir: Assignment,
  base: ReadonlyMap<string, CreaseRecord>,
): Map<string, CreaseRecord> {
  const creases = new Map(base);
  for (const rec of hingeCreases(faces, moverSet, axis, viewDir)) {
    creases.set(segKey(rec.seg[0], rec.seg[1]), rec);
  }
  return creases;
}

/**
 * Shared fold tail (§3.1 steps 2–4): reflect movers, apply the reversal rule to the
 * layer order, renormalize to CONF, assemble, and run the checker. Used by both ALL
 * and ONE_LAYER since their apply/layer-update phases are identical (§3.2).
 */
export function commitFold(args: {
  state: FoldedState;
  faces: readonly Face[];
  order: readonly FaceId[];
  axis: Line;
  moverSet: ReadonlySet<FaceId>;
  direction: Assignment;
  creases: ReadonlyMap<string, CreaseRecord>;
  op: FoldOp;
}): Result {
  const { state, faces, order, axis, moverSet, direction, creases, op } = args;
  const refl = reflectionIso(axis);
  const movedFaces = faces.map((f) =>
    moverSet.has(f.id) ? makeFace(f.id, f.srcPoly, compose(refl, f.T), f.parent) : f,
  );
  const moversInOrder = order.filter((id) => moverSet.has(id));
  const staticsInOrder = order.filter((id) => !moverSet.has(id));
  const revMovers = [...moversInOrder].reverse();
  const newOrder: FaceId[] =
    direction === 'V'
      ? [...staticsInOrder, ...revMovers]
      : [...revMovers, ...staticsInOrder];

  const renorm = renormalizeToCONF(movedFaces, newOrder);
  const next = buildState({
    faces: renorm.faces,
    order: renorm.order,
    creases: new Map(creases),
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

export function foldAll(state: FoldedState, op: FoldOp): Result {
  let axis: Line;
  try {
    axis = lineThrough(op.axis.a, op.axis.b);
  } catch {
    return err({ code: 'E_AXIS_DEGENERATE' });
  }

  const split = splitAtAxis([...state.faces.values()], [...state.order], axis);
  const { faces, order } = split;

  const target = sideSign(op.movingSide);
  const moverSet = new Set<FaceId>();
  for (const f of faces) if (faceSide(f, axis) === target) moverSet.add(f.id);
  if (moverSet.size === 0) return err({ code: 'E_EMPTY_MOVE' });
  if (moverSet.size === faces.length) return err({ code: 'E_EMPTY_MOVE' }); // no static hinge

  const creases = recordHingeCreases(faces, moverSet, axis, op.direction, state.creases);
  return commitFold({ state, faces, order, axis, moverSet, direction: op.direction, creases, op });
}

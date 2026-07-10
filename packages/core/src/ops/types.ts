/** Operation, error, and result types (§3.6). Ops are implemented in later milestones. */
import { Vec2 } from '../geom/vec2.js';
import { FaceId, EdgeId, SpotId } from '../state/ids.js';
import type { Assignment } from '../state/edge.js';
import type { FoldedState } from '../state/state.js';
import type { CheckReport } from '../check/types.js';

/** Side of the *directed* axis that moves. */
export type MovingSide = 'left' | 'right';

export interface AxisSpec {
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface FoldOp {
  readonly type: 'FOLD';
  readonly mode: 'ALL' | 'ONE_LAYER';
  readonly axis: AxisSpec;
  readonly movingSide: MovingSide;
  /** View-relative valley/mountain as a diagram/user specifies it (§3.1). */
  readonly direction: Assignment;
  readonly seedFaceIds?: readonly FaceId[];
}

export interface FlipOp {
  readonly type: 'FLIP';
  readonly axis?: AxisSpec | 'vertical' | 'horizontal';
}

export interface PrecreaseOp {
  readonly type: 'PRECREASE';
  readonly axis: AxisSpec;
  readonly movingSide: MovingSide;
  readonly direction: Assignment;
}

export interface UnfoldLastOp {
  readonly type: 'UNFOLD_LAST';
  readonly count?: number;
}

/**
 * Inside-reverse fold (§3.3): reflect a flap's tip across the axis — same reflection
 * geometry as a FOLD — but instead of lifting the movers cleanly above/below the stack
 * (which ONE_LAYER's P2 requires), the reversed tip is NESTED between the existing
 * layers. That nesting is the whole point of a reverse fold and is exactly what P2
 * forbids, so it is its own op. The valid layer interleaving is found by construction
 * and confirmed by the checker (I1–I6).
 */
export interface InsideReverseFoldOp {
  readonly type: 'INSIDE_REVERSE_FOLD';
  readonly axis: AxisSpec;
  readonly movingSide: MovingSide;
  readonly direction: Assignment;
  readonly seedFaceIds?: readonly FaceId[];
}

export type Op = FoldOp | FlipOp | PrecreaseOp | UnfoldLastOp | InsideReverseFoldOp;

export type Invariant = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6';

export type OpError =
  | { readonly code: 'E_TEAR'; readonly edges: readonly EdgeId[] }
  | { readonly code: 'E_BLOCKED'; readonly spot: SpotId; readonly pair: readonly [FaceId, FaceId] }
  | { readonly code: 'E_EMPTY_MOVE' }
  | { readonly code: 'E_AXIS_DEGENERATE' }
  | { readonly code: 'E_INVARIANT'; readonly invariant: Invariant; readonly witness: unknown }
  | { readonly code: 'E_UNSUPPORTED'; readonly detail: string };

export type Result =
  | { readonly ok: true; readonly state: FoldedState; readonly report: CheckReport }
  | { readonly ok: false; readonly error: OpError };

export function ok(state: FoldedState, report: CheckReport): Result {
  return { ok: true, state, report };
}
export function err(error: OpError): Result {
  return { ok: false, error };
}

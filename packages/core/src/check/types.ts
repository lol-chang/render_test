/** Checker report types (§6). The checker itself lands in M2/M4. */
import { Invariant } from '../ops/types.js';

export interface InvariantResult {
  readonly invariant: Invariant;
  readonly pass: boolean;
  readonly witness?: unknown;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly results: readonly InvariantResult[];
}

export const EMPTY_REPORT: CheckReport = { ok: true, results: [] };

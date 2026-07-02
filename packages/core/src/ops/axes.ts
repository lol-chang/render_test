/**
 * Axis-candidate enumeration (§8.3). The engine never guesses an axis from mouse
 * floats; the UI picks from this exact set. Candidates come from:
 *   - existing crease lines (folded hinges),
 *   - lines through pairs of folded vertices,
 *   - perpendicular bisectors of vertex pairs (Huzita–Justin O2: fold a point onto
 *     another point).
 *
 * SPEC-GAP: O3 (edge-to-edge angle bisectors — fold a line onto a line) is omitted.
 * The angle bisector of two rational lines needs unit-normalized directions (√ of a
 * sum of squares), which is irrational in general and therefore not representable in
 * the exact rational kernel. Per §1.2 rule 6 we omit it rather than introduce floats.
 */
import { Rat } from '../geom/rat.js';
import { Vec2, sub, add, scale } from '../geom/vec2.js';
import { applyIso } from '../geom/iso.js';
import { FoldedState } from '../state/state.js';
import { foldedPoly } from '../state/face.js';

export type AxisKind = 'crease' | 'vertices' | 'perp-bisector';

export interface AxisCandidate {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly kind: AxisKind;
}

/** Canonical exact key for the (undirected, infinite) line through a and b. */
export function lineKey(a: Vec2, b: Vec2): string {
  const dx = b.x.sub(a.x);
  const dy = b.y.sub(a.y);
  // line: dy*x - dx*y = dy*ax - dx*ay  → A x + B y = C
  const A = dy;
  const B = dx.neg();
  const C = dy.mul(a.x).sub(dx.mul(a.y));
  // clear denominators to integers
  const dLcm = A.d * B.d * C.d;
  let ai = A.n * (B.d * C.d);
  let bi = B.n * (A.d * C.d);
  let ci = C.n * (A.d * B.d);
  void dLcm;
  // reduce by gcd
  const gcd = (x: bigint, y: bigint): bigint => {
    x = x < 0n ? -x : x; y = y < 0n ? -y : y;
    while (y) { [x, y] = [y, x % y]; }
    return x || 1n;
  };
  let g = gcd(gcd(ai, bi), ci);
  ai /= g; bi /= g; ci /= g;
  // sign-normalize: first nonzero of (ai, bi) positive
  if (ai < 0n || (ai === 0n && bi < 0n)) { ai = -ai; bi = -bi; ci = -ci; }
  return `${ai}:${bi}:${ci}`;
}

function distinct(a: Vec2, b: Vec2): boolean {
  return !(a.x.eq(b.x) && a.y.eq(b.y));
}

/** All distinct folded vertices of the current state. */
function foldedVertices(state: FoldedState): Vec2[] {
  const seen = new Set<string>();
  const out: Vec2[] = [];
  for (const f of state.faces.values()) {
    for (const p of foldedPoly(f)) {
      const k = `${p.x.toString()},${p.y.toString()}`;
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
  }
  return out;
}

export function enumerateAxisCandidates(state: FoldedState): AxisCandidate[] {
  const out: AxisCandidate[] = [];
  const seen = new Set<string>();
  const push = (a: Vec2, b: Vec2, kind: AxisKind): void => {
    if (!distinct(a, b)) return;
    const k = lineKey(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ a, b, kind });
  };

  // existing crease lines (folded hinges)
  for (const e of state.edges.values()) {
    if (e.kind !== 'CREASE') continue;
    const fa = state.faces.get(e.faces[0]);
    if (!fa) continue;
    push(applyIso(fa.T, e.srcSeg[0]), applyIso(fa.T, e.srcSeg[1]), 'crease');
  }

  const verts = foldedVertices(state);
  const half = Rat.of(1n, 2n);
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      const p = verts[i]!;
      const qv = verts[j]!;
      // line through the two vertices
      push(p, qv, 'vertices');
      // perpendicular bisector (O2): through midpoint, perpendicular to pq
      const mid = scale(add(p, qv), half);
      const d = sub(qv, p);
      const perp: Vec2 = { x: d.y.neg(), y: d.x };
      push(mid, add(mid, perp), 'perp-bisector');
    }
  }

  return out;
}

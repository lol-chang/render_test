/**
 * Split-at-axis and CONF renormalization (§3.0).
 *
 * These operate on plain face lists + the global layer order, independent of the
 * assembled state, so both ops (M2+) and the checker can reuse them. Everything is
 * exact: splits happen in source space by pulling folded-space lines back through
 * each face's inverse isometry.
 */
import { Line, lineThrough } from '../geom/line.js';
import { Poly, splitPolyByLine, polysIdentical, polysInteriorDisjoint } from '../geom/poly.js';
import { applyIso, invert } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { Face, makeFace, foldedPoly } from '../state/face.js';
import { FaceId, childFaceId } from '../state/ids.js';

/** Iteration cap guarding CONF renormalization against non-termination (§3.0). */
export const CONF_ITER_CAP = 100000;

/** Pull a folded-space line back to a face's source space. */
function pullbackLine(face: Face, folded: Line): Line {
  const Ti = invert(face.T);
  return lineThrough(applyIso(Ti, folded.a), applyIso(Ti, folded.b));
}

/**
 * Split one face by a folded-space line. Returns [left, right] children (side tags
 * from the source-space split) if the line crosses the interior, else [face].
 */
export function splitFaceByFoldedLine(face: Face, folded: Line): Face[] {
  const srcLine = pullbackLine(face, folded);
  const { left, right } = splitPolyByLine(face.srcPoly, srcLine);
  if (left && right) {
    return [
      makeFace(childFaceId(face.id, 'L'), left, face.T, face.id),
      makeFace(childFaceId(face.id, 'R'), right, face.T, face.id),
    ];
  }
  return [face];
}

/** Split a face by several folded-space lines in sequence. */
export function splitFaceByFoldedLines(face: Face, lines: readonly Line[]): Face[] {
  let pieces: Face[] = [face];
  for (const L of lines) {
    const next: Face[] = [];
    for (const p of pieces) next.push(...splitFaceByFoldedLine(p, L));
    pieces = next;
  }
  return pieces;
}

/** Infinite lines through each edge of a (folded) polygon. */
function edgeLines(poly: Poly): Line[] {
  const lines: Line[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    lines.push(lineThrough(a, b));
  }
  return lines;
}

/** Replace, in the global order, each parent id by its children's ids in place. */
function applyOrderReplacements(
  order: readonly FaceId[],
  repl: ReadonlyMap<FaceId, FaceId[]>,
): FaceId[] {
  const out: FaceId[] = [];
  for (const id of order) {
    const kids = repl.get(id);
    if (kids) out.push(...kids);
    else out.push(id);
  }
  return out;
}

/**
 * Split every face whose folded interior is crossed by the axis (§3.0 Split-at-axis).
 * Returns the new face list and layer order (children inherit the parent's slot).
 */
export function splitAtAxis(
  faces: readonly Face[],
  order: readonly FaceId[],
  axis: Line,
): { faces: Face[]; order: FaceId[] } {
  const out: Face[] = [];
  const repl = new Map<FaceId, FaceId[]>();
  for (const f of faces) {
    const pieces = splitFaceByFoldedLine(f, axis);
    out.push(...pieces);
    if (pieces.length > 1) repl.set(f.id, pieces.map((p) => p.id));
  }
  return { faces: out, order: applyOrderReplacements(order, repl) };
}

/** First pair of faces whose folded polygons partially overlap (non-conforming). */
function findPartialOverlap(faces: readonly Face[]): [number, number] | null {
  const polys = faces.map(foldedPoly);
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = polys[i]!;
      const b = polys[j]!;
      if (polysIdentical(a, b)) continue;
      if (polysInteriorDisjoint(a, b)) continue;
      return [i, j];
    }
  }
  return null;
}

/**
 * Renormalize to Congruent-Overlap Normal Form (§3.0, §D4): split faces by mutual
 * edge-line clipping until every pair of folded polygons is identical or has
 * interior-disjoint. Each pass strictly reduces total non-conforming overlap area,
 * and all arithmetic is exact, so it terminates; the cap is a backstop.
 */
export function renormalizeToCONF(
  faces: readonly Face[],
  order: readonly FaceId[],
): { faces: Face[]; order: FaceId[] } {
  let fs: Face[] = [...faces];
  let ord: FaceId[] = [...order];
  let iter = 0;
  for (;;) {
    if (++iter > CONF_ITER_CAP) {
      throw new Error('SPEC-GAP: CONF renormalization exceeded iteration cap');
    }
    const pair = findPartialOverlap(fs);
    if (!pair) break;
    const [i, j] = pair;
    const A = fs[i]!;
    const B = fs[j]!;
    const aPieces = splitFaceByFoldedLines(A, edgeLines(foldedPoly(B)));
    const bPieces = splitFaceByFoldedLines(B, edgeLines(foldedPoly(A)));
    const remove = new Set<FaceId>([A.id, B.id]);
    fs = fs.filter((f) => !remove.has(f.id)).concat(aPieces, bPieces);
    const repl = new Map<FaceId, FaceId[]>();
    repl.set(A.id, aPieces.map((p) => p.id));
    repl.set(B.id, bPieces.map((p) => p.id));
    ord = applyOrderReplacements(ord, repl);
  }
  return { faces: fs, order: ord };
}

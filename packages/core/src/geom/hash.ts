/**
 * Canonical polygon hash for spot identity (§5.4).
 *
 * Not a lossy hash: it is an exact string encoding of the canonical (CCW,
 * lex-min-start) vertex list, so equality of keys ⇔ identical folded polygons,
 * with zero collision risk by construction.
 */
import { Poly, canonicalVertices } from './poly.js';

/** Exact canonical key string for a polygon (rotation/orientation invariant). */
export function canonicalPolyKey(poly: Poly): string {
  const cv = canonicalVertices(poly);
  return cv.map((p) => `${p.x.toString()},${p.y.toString()}`).join(';');
}

/**
 * A short stable digest of the canonical key, for compact SpotIds. Uses a
 * deterministic FNV-1a over the exact key string — collisions are impossible in
 * practice, and the full key is retained on the Spot for exact comparison, so
 * this is purely a display/index convenience.
 */
export function polyHash(poly: Poly): string {
  const key = canonicalPolyKey(poly);
  let h = 0x811c9dc5n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ BigInt(key.charCodeAt(i))) & mask;
    h = (h * 0x100000001b3n) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

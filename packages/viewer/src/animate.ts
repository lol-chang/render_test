/**
 * Fold animation (§8.2) is no longer a separate renderer.
 *
 * It used to be: the static build drew flat slabs, so a fold had to be staged as a second scene
 * — movers in a rotating pivot, statics beside them — and the last frame SNAPPED to the
 * committed model, because the two were built by different code. The continuous-sheet build
 * (see build3d.ts) deforms one mesh through the whole history, so animating is just running the
 * last fold at θ = π·t: `Built.setProgress`. At t = 1 the mesh IS the committed model, and
 * there is nothing left to snap to.
 *
 * What remains here is the timing curve.
 */

/** ease-in-out cubic */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Continuous fold animation (spec §8.2).
 *
 * Given the engine's fold PLAN (split pre-state faces + moving set + folded-space
 * hinge), the moving faces rotate rigidly about the hinge line from 0 → π while the
 * static faces stay put — so you watch one connected sheet bend over. Per Lemmas
 * L1/L2 the engine already proved this motion is collision-free, so no collision
 * detection is needed; at t = 1 the caller swaps in the exact committed post-state.
 */
import * as THREE from 'three';
import type { FoldPlan } from '@origami/core';
import { foldedPoly } from '@origami/core';
import { addFace, layerZMap } from './build3d.js';

export interface FoldAnim {
  object: THREE.Group;
  setAngle(theta: number): void; // radians, 0 → Math.PI
}

export function buildFoldAnim(plan: FoldPlan, thickness: number): FoldAnim {
  const object = new THREE.Group();
  const staticG = new THREE.Group();
  const pivot = new THREE.Group();
  const content = new THREE.Group(); // holds world-coord movers, offset so pivot rotates about the hinge
  pivot.add(content);
  object.add(staticG, pivot);

  // per-spot z (movers and statics only stacked where they actually overlap)
  const zOf = layerZMap(plan.faces, plan.order, thickness);

  // hinge point A and unit direction u (in the z = 0 plane)
  const A = { x: plan.axis.a.x.toNumber(), y: plan.axis.a.y.toNumber() };
  const B = { x: plan.axis.b.x.toNumber(), y: plan.axis.b.y.toNumber() };
  let ux = B.x - A.x;
  let uy = B.y - A.y;
  const ulen = Math.hypot(ux, uy) || 1;
  ux /= ulen;
  uy /= ulen;

  // build faces: movers into the rotating content, statics fixed
  let cx = 0, cy = 0, n = 0;
  let moverZmin = Infinity, moverZmax = -Infinity;
  let staticZmin = Infinity, staticZmax = -Infinity;
  for (const face of plan.faces) {
    const z = zOf.get(face.id) ?? 0;
    if (plan.moverSet.has(face.id)) {
      addFace(content, face, z);
      // side test must use the FOLDED centroid (the axis lives in folded space), not
      // the source polygon — post-fold movers carry a non-identity transform.
      const fp = foldedPoly(face);
      let fx = 0, fy = 0;
      for (const p of fp) { fx += p.x.toNumber(); fy += p.y.toNumber(); }
      cx += fx / fp.length; cy += fy / fp.length; n++;
      moverZmin = Math.min(moverZmin, z); moverZmax = Math.max(moverZmax, z);
    } else {
      addFace(staticG, face, z);
      staticZmin = Math.min(staticZmin, z); staticZmax = Math.max(staticZmax, z);
    }
  }
  if (!isFinite(staticZmax)) { staticZmax = 0; staticZmin = 0; }

  // choose rotation sign so a Valley fold sweeps UP (+z) and over, a Mountain fold down.
  const wx = (n ? cx / n : A.x) - A.x;
  const wy = (n ? cy / n : A.y) - A.y;
  const upSign = ux * wy - uy * wx > 0 ? 1 : -1; // z-component of u × w
  const sign = plan.direction === 'V' ? upSign : -upSign;

  // Rotate about the hinge held at the level the flap should FOLD ONTO — no separate
  // translation. A rigid 180° rotation about height h maps a mover at z to 2h − z, so
  // picking h just past the midpoint of the stacks lands every mover ABOVE the statics
  // (valley) or BELOW (mountain) via pure rotation. Keeping h near the paper means the
  // hinge stays glued to the crease; the earlier growing "lift" translation is what made
  // the flap look like it detached and swung 360° around.
  const gap = thickness * 1.2 + 0.006;
  const pivotZ =
    plan.direction === 'V'
      ? (staticZmax + moverZmax) / 2 + gap
      : (staticZmin + moverZmin) / 2 - gap;

  pivot.position.set(A.x, A.y, pivotZ);
  content.position.set(-A.x, -A.y, -pivotZ);

  const axisVec = new THREE.Vector3(ux, uy, 0);
  const setAngle = (theta: number): void => {
    pivot.quaternion.setFromAxisAngle(axisVec, sign * theta);
  };
  setAngle(0);

  return { object, setAngle };
}

/** ease-in-out cubic */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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
import { addFace } from './build3d.js';

export interface FoldAnim {
  object: THREE.Group;
  setAngle(theta: number): void; // radians, 0 → Math.PI
}

export function buildFoldAnim(plan: FoldPlan, thickness: number): FoldAnim {
  const object = new THREE.Group();
  const staticG = new THREE.Group();
  const lifter = new THREE.Group(); // ramps the moving stack to the correct side (see below)
  const pivot = new THREE.Group();
  const content = new THREE.Group(); // holds world-coord movers, offset so pivot rotates about A
  pivot.add(content);
  lifter.add(pivot);
  object.add(staticG, lifter);

  const zOf = new Map<string, number>();
  plan.order.forEach((id, i) => zOf.set(id, i));

  // hinge point A and unit direction u (in the z = 0 plane)
  const A = { x: plan.axis.a.x.toNumber(), y: plan.axis.a.y.toNumber() };
  const B = { x: plan.axis.b.x.toNumber(), y: plan.axis.b.y.toNumber() };
  let ux = B.x - A.x;
  let uy = B.y - A.y;
  const ulen = Math.hypot(ux, uy) || 1;
  ux /= ulen;
  uy /= ulen;

  pivot.position.set(A.x, A.y, 0);
  content.position.set(-A.x, -A.y, 0);

  // build faces: movers into the rotating content, statics fixed
  let cx = 0;
  let cy = 0;
  let n = 0;
  let moverZmin = Infinity, moverZmax = -Infinity;
  let staticZmin = Infinity, staticZmax = -Infinity;
  for (const face of plan.faces) {
    const z = (zOf.get(face.id) ?? 0) * thickness;
    if (plan.moverSet.has(face.id)) {
      addFace(content, face, z);
      const v = face.srcPoly[0]!;
      cx += v.x.toNumber();
      cy += v.y.toNumber();
      n++;
      moverZmin = Math.min(moverZmin, z);
      moverZmax = Math.max(moverZmax, z);
    } else {
      addFace(staticG, face, z);
      staticZmin = Math.min(staticZmin, z);
      staticZmax = Math.max(staticZmax, z);
    }
  }
  if (!isFinite(staticZmax)) { staticZmax = 0; staticZmin = 0; }

  // choose rotation sign so a Valley fold lifts UP (+z) first, a Mountain fold behind.
  const wx = (n ? cx / n : A.x) - A.x;
  const wy = (n ? cy / n : A.y) - A.y;
  const upSign = ux * wy - uy * wx > 0 ? 1 : -1; // z-component of u × w
  const sign = plan.direction === 'V' ? upSign : -upSign;

  // A rigid 180° rotation about the hinge INVERTS the moving stack's z (top→bottom):
  // a mover at z0 lands at -z0. So we ramp a vertical lift over the fold so the moving
  // stack settles on the correct side — ABOVE the statics for a valley fold, BELOW for
  // a mountain — matching the committed post-state the caller snaps to at t = 1.
  const gap = thickness * 1.5 + 0.004;
  const lift =
    plan.direction === 'V'
      ? staticZmax + moverZmax + gap // lowest mover (-moverZmax) rises above staticZmax
      : staticZmin - moverZmax - gap; // highest mover (-moverZmin) sinks below staticZmin

  const axisVec = new THREE.Vector3(ux, uy, 0);
  const setAngle = (theta: number): void => {
    pivot.quaternion.setFromAxisAngle(axisVec, sign * theta);
    lifter.position.z = lift * (theta / Math.PI);
  };
  setAngle(0);

  return { object, setAngle };
}

/** ease-in-out cubic */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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
  const pivot = new THREE.Group();
  const content = new THREE.Group(); // holds world-coord movers, offset so pivot rotates about A
  pivot.add(content);
  object.add(staticG, pivot);

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
  for (const face of plan.faces) {
    const z = (zOf.get(face.id) ?? 0) * thickness;
    if (plan.moverSet.has(face.id)) {
      addFace(content, face, z);
      // accumulate mover centroid (of first vertex is enough for a sign test)
      const v = face.srcPoly[0]!;
      cx += v.x.toNumber();
      cy += v.y.toNumber();
      n++;
    } else {
      addFace(staticG, face, z);
    }
  }

  // choose rotation sign so a Valley fold lifts UP (+z) first, a Mountain fold behind.
  const wx = (n ? cx / n : A.x) - A.x;
  const wy = (n ? cy / n : A.y) - A.y;
  const zVelForPositive = ux * wy - uy * wx; // z-component of u × w
  const upSign = zVelForPositive > 0 ? 1 : -1;
  const sign = plan.direction === 'V' ? upSign : -upSign;

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

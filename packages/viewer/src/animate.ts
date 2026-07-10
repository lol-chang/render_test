/**
 * Fold animation (§8.2): the engine's fold PLAN gives the split pre-state faces, the moving
 * set, and the folded-space hinge. The moving faces rotate rigidly about the hinge from
 * 0 → π (ease-in-out) while the statics stay put — you watch one connected sheet bend over.
 * Per Lemmas L1/L2 the engine already proved the motion is collision-free, so no collision
 * detection is needed; at t = 1 the caller swaps in the exact committed post-state.
 */
import * as THREE from 'three';
import type { FoldPlan, Face, FaceId } from '@origami/core';
import { foldedPoly, faceIsFront, signedArea, canonicalPolyKey } from '@origami/core';
import { FRONT_COLOR, BACK_COLOR } from './build3d.js';

export interface FoldAnim {
  object: THREE.Group;
  setAngle(theta: number): void; // radians, 0 → π
}

/** Per-face z within its spot (so overlapping layers separate a little during motion). */
function layerZ(faces: readonly Face[], order: readonly FaceId[], eps: number): Map<FaceId, number> {
  const rank = new Map<FaceId, number>();
  order.forEach((id, i) => rank.set(id, i));
  const groups = new Map<string, Face[]>();
  for (const f of faces) {
    const k = canonicalPolyKey(foldedPoly(f));
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  const z = new Map<FaceId, number>();
  for (const g of groups.values()) {
    g.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    g.forEach((f, i) => z.set(f.id, i * eps));
  }
  return z;
}

/** A flat face at height z, two-sided (red front / white back by det). */
function addFlatFace(group: THREE.Group, face: Face, z: number): void {
  let poly = foldedPoly(face);
  if (signedArea(poly).sign() < 0) poly = [...poly].reverse(); // CCW ⇒ +z normal
  const shape = new THREE.Shape();
  shape.moveTo(poly[0]!.x.toNumber(), poly[0]!.y.toNumber());
  for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i]!.x.toNumber(), poly[i]!.y.toNumber());
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.translate(0, 0, z);
  const front = faceIsFront(face);
  const mat = (c: number, s: THREE.Side) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0, side: s });
  group.add(
    new THREE.Mesh(geo, mat(front ? FRONT_COLOR : BACK_COLOR, THREE.FrontSide)),
    new THREE.Mesh(geo, mat(front ? BACK_COLOR : FRONT_COLOR, THREE.BackSide)),
  );
}

export function buildFoldAnim(plan: FoldPlan, eps: number): FoldAnim {
  const object = new THREE.Group();
  const staticG = new THREE.Group();
  const pivot = new THREE.Group();
  const content = new THREE.Group(); // holds movers, offset so the pivot rotates about the hinge
  pivot.add(content);
  object.add(staticG, pivot);

  const zOf = layerZ(plan.faces, plan.order, eps);
  const A = { x: plan.axis.a.x.toNumber(), y: plan.axis.a.y.toNumber() };
  const B = { x: plan.axis.b.x.toNumber(), y: plan.axis.b.y.toNumber() };
  let ux = B.x - A.x, uy = B.y - A.y;
  const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;

  let cx = 0, cy = 0, n = 0;
  for (const face of plan.faces) {
    const z = zOf.get(face.id) ?? 0;
    if (plan.moverSet.has(face.id)) {
      addFlatFace(content, face, z);
      const fp = foldedPoly(face);
      let fx = 0, fy = 0;
      for (const p of fp) { fx += p.x.toNumber(); fy += p.y.toNumber(); }
      cx += fx / fp.length; cy += fy / fp.length; n++;
    } else {
      addFlatFace(staticG, face, z);
    }
  }

  // rotation sign: a Valley fold sweeps the movers UP (+z) and over; a Mountain fold down.
  const wx = (n ? cx / n : A.x) - A.x, wy = (n ? cy / n : A.y) - A.y;
  const upSign = ux * wy - uy * wx > 0 ? 1 : -1; // z of u × w
  const sign = plan.direction === 'V' ? upSign : -upSign;

  pivot.position.set(A.x, A.y, 0);
  content.position.set(-A.x, -A.y, 0);
  const axisVec = new THREE.Vector3(ux, uy, 0);
  const setAngle = (theta: number): void => { pivot.quaternion.setFromAxisAngle(axisVec, sign * theta); };
  setAngle(0);
  return { object, setAngle };
}

/** ease-in-out cubic */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

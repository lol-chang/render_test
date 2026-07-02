/**
 * FoldedState → three.js meshes (spec §8.1) with continuous-paper rendering.
 *
 * A face's height is its index in the engine's global bottom→top layer order ×
 * thickness. Front/back comes from the det-based side rule. Crucially, every folded
 * CREASE is rendered as a small "wall" bridging the two stacked layers it joins, so
 * the paper reads as ONE continuous folded sheet (wrapping at each fold) rather than
 * a pile of loose polygons — especially visible in the exploded view.
 */
import * as THREE from 'three';
import type { FoldedState, Face, Vec2, FaceId } from '@origami/core';
import { foldedPoly, faceIsFront, applyIso, signedArea, canonicalPolyKey } from '@origami/core';

/**
 * Assign each face a height by its position WITHIN ITS SPOT (the set of faces that
 * share the same folded polygon), not by a global index. Faces in different spots
 * are disjoint in xy, so they all sit at z = 0 and only genuinely-overlapping layers
 * are separated. This keeps a flat sheet flat (its halves stay coplanar) instead of
 * stepping them apart — which previously made folds look like they pierced the paper.
 */
export function layerZMap(faces: readonly Face[], order: readonly FaceId[], thickness: number): Map<string, number> {
  const rank = new Map<FaceId, number>();
  order.forEach((id, i) => rank.set(id, i));
  const groups = new Map<string, Face[]>();
  for (const f of faces) {
    const k = canonicalPolyKey(foldedPoly(f));
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  const z = new Map<string, number>();
  for (const g of groups.values()) {
    g.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    g.forEach((f, i) => z.set(f.id, i * thickness));
  }
  return z;
}

export const FRONT_COLOR = 0xd94f5c; // colored paper surface (front)
export const BACK_COLOR = 0xf3f1ea; // white-ish paper surface (back)
const EDGE_COLOR = 0x2b2f36;
const HINGE_COLOR = 0xc94c58; // fold spine

export interface BuildOptions {
  thickness: number;
}

export interface Built {
  object: THREE.Group;
  center: THREE.Vector3;
  extent: number;
}

function toXY(p: Vec2): { x: number; y: number } {
  return { x: p.x.toNumber(), y: p.y.toNumber() };
}

function paperMat(color: number, sideMode: THREE.Side): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.82, metalness: 0.0, side: sideMode,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

/**
 * Add a face at height z, rendered with DISTINCT front (red) and back (white) paper
 * surfaces. The geometry is wound CCW (normal +z), and the paper's front surface faces
 * +z iff the face is front-up (det>0). So as a flap rotates past vertical during a
 * fold, the camera starts seeing the other surface — the paper visibly flips red↔white,
 * both in the animation and at rest.
 */
export function addFace(group: THREE.Group, face: Face, z: number): void {
  let poly = foldedPoly(face);
  if (signedArea(poly).sign() < 0) poly = [...poly].reverse(); // ensure CCW ⇒ normal +z
  const xy = poly.map(toXY);
  const shape = new THREE.Shape();
  shape.moveTo(xy[0]!.x, xy[0]!.y);
  for (let i = 1; i < xy.length; i++) shape.lineTo(xy[i]!.x, xy[i]!.y);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  geo.translate(0, 0, z);
  const frontUp = faceIsFront(face);
  const plusZColor = frontUp ? FRONT_COLOR : BACK_COLOR; // surface facing +z (camera)
  const minusZColor = frontUp ? BACK_COLOR : FRONT_COLOR;

  const top = new THREE.Mesh(geo, paperMat(plusZColor, THREE.FrontSide));
  const bot = new THREE.Mesh(geo, paperMat(minusZColor, THREE.BackSide));
  top.userData.faceId = face.id;
  bot.userData.faceId = face.id;
  group.add(top, bot);

  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 1),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
  );
  group.add(line);
}

/** Bridge the two layers joined by a folded crease with a small wall (the fold spine). */
function addHingeWalls(group: THREE.Group, state: FoldedState, zOf: Map<string, number>): void {
  for (const e of state.edges.values()) {
    if (e.kind !== 'CREASE') continue;
    const [aId, bId] = e.faces;
    if (bId === null) continue;
    const fa = state.faces.get(aId);
    if (!fa) continue;
    const za = zOf.get(aId) ?? 0;
    const zb = zOf.get(bId) ?? 0;
    const h0 = toXY(applyIso(fa.T, e.srcSeg[0]));
    const h1 = toXY(applyIso(fa.T, e.srcSeg[1]));
    // quad (h0,za)-(h1,za)-(h1,zb)-(h0,zb)
    const verts = new Float32Array([
      h0.x, h0.y, za, h1.x, h1.y, za, h1.x, h1.y, zb,
      h0.x, h0.y, za, h1.x, h1.y, zb, h0.x, h0.y, zb,
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.computeVertexNormals();
    group.add(
      new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({ color: HINGE_COLOR, roughness: 0.9, side: THREE.DoubleSide }),
      ),
    );
  }
}

export function buildModel(state: FoldedState, opts: BuildOptions): Built {
  const object = new THREE.Group();
  const faces = [...state.faces.values()];
  const zOf = layerZMap(faces, state.order, opts.thickness);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let maxZ = 0;
  for (const face of faces) {
    for (const p of foldedPoly(face)) {
      const x = p.x.toNumber();
      const y = p.y.toNumber();
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const z = zOf.get(face.id) ?? 0;
    maxZ = Math.max(maxZ, z);
    addFace(object, face, z);
  }
  addHingeWalls(object, state, zOf);

  const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, maxZ / 2);
  return { object, center, extent: Math.max(maxX - minX, maxY - minY) || 1 };
}

/**
 * FoldedState → three.js meshes (spec §8.1).
 *
 * z-assignment: the engine already gives us a global bottom→top layer order, so a
 * face's height is simply its index in that order × paper thickness. Front/back is
 * read from the engine's det-based side rule (never guessed). Each face gets a filled
 * ShapeGeometry plus a crisp edge outline; the whole group is centered on the origin.
 */
import * as THREE from 'three';
import type { FoldedState } from '@origami/core';
import { foldedPoly, faceIsFront } from '@origami/core';

const FRONT_COLOR = 0xd94f5c; // colored side (classic origami front)
const BACK_COLOR = 0xf3f1ea; // white-ish back
const EDGE_COLOR = 0x2b2f36;

export interface BuildOptions {
  thickness: number; // z-gap between adjacent layers
}

export function buildModel(state: FoldedState, opts: BuildOptions): THREE.Group {
  const group = new THREE.Group();
  const zOf = new Map<string, number>();
  state.order.forEach((id, i) => zOf.set(id, i));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const face of state.faces.values()) {
    const poly = foldedPoly(face).map((p) => ({ x: p.x.toNumber(), y: p.y.toNumber() }));
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    const shape = new THREE.Shape();
    shape.moveTo(poly[0]!.x, poly[0]!.y);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i]!.x, poly[i]!.y);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    const z = (zOf.get(face.id) ?? 0) * opts.thickness;
    geo.translate(0, 0, z);

    const front = faceIsFront(face);
    const mat = new THREE.MeshStandardMaterial({
      color: front ? FRONT_COLOR : BACK_COLOR,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.faceId = face.id;
    group.add(mesh);

    const edges = new THREE.EdgesGeometry(geo, 1);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
    );
    group.add(line);
  }

  // center the model on the origin (in xy); keep z as-is
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  group.position.set(-cx, -cy, 0);

  const wrapper = new THREE.Group();
  wrapper.add(group);
  wrapper.userData.extent = Math.max(maxX - minX, maxY - minY) || 1;
  return wrapper;
}

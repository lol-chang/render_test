/**
 * FOLD-format interop (§4.3) — Demaine & Ku, github.com/edemaine/fold.
 *
 * We export the FLAT-FOLDED state: 2D folded vertex coordinates + faces + edge
 * assignments + `faceOrders` for the layer ordering. Faces are emitted CCW in folded
 * space (normal = +z), so a faceOrders triple [f, g, s] uses s = +1 ⇔ f is on the
 * side of g's normal ⇔ f is above g (higher in the stack) — the spec's convention,
 * verified against the FOLD spec, not guessed.
 *
 * `foldStacks` reads a flat-folded FOLD file back into per-region stacks so we can
 * cross-check our layer order against Flat-Folder / Origami Simulator output (§9.4).
 */
import { FoldedState } from '../state/state.js';
import { foldedPoly } from '../state/face.js';
import { signedArea } from '../geom/poly.js';
import { applyIso } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';
import { FaceId } from '../state/ids.js';

export interface FoldJSON {
  file_spec: number;
  frame_classes: string[];
  frame_attributes: string[];
  vertices_coords: [number, number][];
  edges_vertices: [number, number][];
  edges_assignment: string[];
  faces_vertices: number[][];
  faceOrders: [number, number, number][];
}

const PREC = 1e6;
const q = (n: number): number => Math.round(n * PREC) / PREC;

export function toFold(state: FoldedState): FoldJSON {
  const faces = [...state.faces.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const faceIndex = new Map<FaceId, number>();
  faces.forEach((f, i) => faceIndex.set(f.id, i));

  const vertices_coords: [number, number][] = [];
  const vIndex = new Map<string, number>();
  const vidx = (p: Vec2): number => {
    const k = `${p.x.toString()},${p.y.toString()}`;
    let i = vIndex.get(k);
    if (i === undefined) {
      i = vertices_coords.length;
      vIndex.set(k, i);
      vertices_coords.push([q(p.x.toNumber()), q(p.y.toNumber())]);
    }
    return i;
  };

  // faces (CCW in folded space so all normals are +z)
  const faces_vertices: number[][] = faces.map((f) => {
    let poly = foldedPoly(f);
    if (signedArea(poly).sign() < 0) poly = [...poly].reverse();
    return poly.map((p) => vidx(p));
  });

  // edges from the derived edge set
  const edges_vertices: [number, number][] = [];
  const edges_assignment: string[] = [];
  const emittedEdge = new Set<string>();
  for (const e of [...state.edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const fa = state.faces.get(e.faces[0])!;
    const a = applyIso(fa.T, e.srcSeg[0]);
    const b = applyIso(fa.T, e.srcSeg[1]);
    const ia = vidx(a);
    const ib = vidx(b);
    const key = ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
    if (emittedEdge.has(key)) continue;
    emittedEdge.add(key);
    edges_vertices.push([ia, ib]);
    edges_assignment.push(
      e.kind === 'BOUNDARY' ? 'B' : e.kind === 'SPLIT' ? 'F' : (e.assignment ?? 'U'),
    );
  }

  // faceOrders: within each spot, pairwise order from stack position
  const faceOrders: [number, number, number][] = [];
  for (const sp of state.spots.values()) {
    const pos = new Map<FaceId, number>();
    sp.stack.forEach((id, i) => pos.set(id, i));
    const ids = [...sp.stack].sort((a, b) => faceIndex.get(a)! - faceIndex.get(b)!);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const fa = faceIndex.get(ids[i]!)!;
        const gb = faceIndex.get(ids[j]!)!;
        const s = pos.get(ids[i]!)! > pos.get(ids[j]!)! ? 1 : -1; // f above g ⇔ +1
        faceOrders.push([fa, gb, s]);
      }
    }
  }

  return {
    file_spec: 1.1,
    frame_classes: ['foldedForm'],
    frame_attributes: ['2D'],
    vertices_coords,
    edges_vertices,
    edges_assignment,
    faces_vertices,
    faceOrders,
  };
}

/**
 * Reconstruct per-region stacks (bottom→top face indices) from a flat-folded FOLD
 * file, grouping faces by their folded polygon and ordering each group via faceOrders.
 * For cross-tool comparison (§9.4).
 */
export function foldStacks(fold: FoldJSON): Map<string, number[]> {
  // group faces by folded-polygon vertex-set key
  const groupKey = (fi: number): string => {
    const coords = fold.faces_vertices[fi]!.map((vi) => {
      const [x, y] = fold.vertices_coords[vi]!;
      return `${q(x)},${q(y)}`;
    });
    return [...coords].sort().join(';');
  };
  const groups = new Map<string, number[]>();
  fold.faces_vertices.forEach((_, fi) => {
    const k = groupKey(fi);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(fi);
  });

  // "above" relation from faceOrders: [f, g, s], s=+1 ⇒ f above g
  const above = new Map<number, Set<number>>(); // above.get(g) = faces above g
  const ensure = (x: number) => above.get(x) ?? above.set(x, new Set()).get(x)!;
  for (const [f, g, s] of fold.faceOrders) {
    if (s === 1) ensure(g).add(f);
    else if (s === -1) ensure(f).add(g);
  }

  const stacks = new Map<string, number[]>();
  for (const [k, members] of groups) {
    const set = new Set(members);
    const indeg = new Map<number, number>();
    const up = new Map<number, number[]>();
    for (const m of members) { indeg.set(m, 0); up.set(m, []); }
    for (const m of members) {
      for (const a of ensure(m)) {
        if (!set.has(a)) continue;
        up.get(m)!.push(a);
        indeg.set(a, (indeg.get(a) ?? 0) + 1);
      }
    }
    const ready = members.filter((m) => (indeg.get(m) ?? 0) === 0).sort((a, b) => a - b);
    const sorted: number[] = [];
    while (ready.length) {
      const m = ready.shift()!;
      sorted.push(m);
      for (const a of up.get(m)!) {
        const d = (indeg.get(a) ?? 0) - 1;
        indeg.set(a, d);
        if (d === 0) {
          ready.push(a);
          ready.sort((p, q) => p - q);
        }
      }
    }
    for (const m of members) if (!sorted.includes(m)) sorted.push(m);
    stacks.set(k, sorted);
  }
  return stacks;
}

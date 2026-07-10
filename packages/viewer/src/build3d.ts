/**
 * FoldedState → three.js meshes: spec §8.1 v1.3, the embedding V(state; ε, w).
 *
 * The 2.5D state has NO continuous z; the viewer computes a thickness-aware, slightly-open
 * paper appearance from it — the split is bookkeeping, not physics, so the render must be
 * C0-continuous across every SPLIT edge.
 *
 *   1. Pointwise base height: z(face) = (stack index of face within its spot) × ε. Spots
 *      tile the silhouette, so this pointwise field is globally consistent — no topo sort.
 *   2. Two-tier welding of per-(face, vertex) z, at each folded-space vertex POSITION:
 *      - SPLIT edges weld UNCONDITIONALLY (mean; independent of w) — one physical facet
 *        draping over an underlying stack becomes a continuous ramp.
 *      - folded CREASE edges weld by hinge cluster, blended z = (1−w)·own + w·mean.
 *      - coincident-but-UNattached instances (separate stacked flaps) are never merged.
 *   3. Conforming triangulation: neighbour vertices lying on a face's edge are inserted, so
 *      T-junctions (CONF splits that don't propagate across spots) share vertices — no cracks.
 *   4. Edge lines: BOUNDARY + folded CREASE only. SPLIT edges are never drawn. No hinge walls.
 */
import * as THREE from 'three';
import type { FoldedState, Face, Vec2, FaceId } from '@origami/core';
import { foldedPoly, faceIsFront, applyIso } from '@origami/core';

export const FRONT_COLOR = 0xd94f5c; // colored paper front
export const BACK_COLOR = 0xf3f1ea;  // white-ish paper back
const LINE_COLOR = 0x2b2f36;         // boundary + folded crease overlay

export interface BuildOptions {
  epsilon: number; // "paper thickness" — per-layer z gap
  // Fold tightness w ∈ [0,1]. SPLIT welding is unconditional (one physical sheet always
  // stays connected as a ramp — never cut into plates); w only gates the CREASE weld:
  // w=1 joins folds into continuous paper (Paper preset), w=0 separates the crease layers
  // so the stack is legible (Explode) while same-sheet parts stay connected.
  weight: number;
}
export interface Built {
  object: THREE.Group;
  center: THREE.Vector3;
  extent: number;
}

const keyOf = (v: Vec2): string => `${v.x.toString()},${v.y.toString()}`;
const numOf = (v: Vec2): { x: number; y: number } => ({ x: v.x.toNumber(), y: v.y.toNumber() });

/** Is p strictly interior to segment a–b (exact)? */
function onEdgeStrict(a: Vec2, b: Vec2, p: Vec2): boolean {
  const dx = b.x.sub(a.x), dy = b.y.sub(a.y);
  const px = p.x.sub(a.x), py = p.y.sub(a.y);
  if (!dx.mul(py).sub(dy.mul(px)).isZero()) return false; // not collinear
  const dot = px.mul(dx).add(py.mul(dy));
  const dd = dx.mul(dx).add(dy.mul(dy));
  return dot.sign() > 0 && dot.cmp(dd) < 0; // strictly between endpoints
}

/** Union-find over a small set of face ids. */
function makeUF(ids: Iterable<FaceId>) {
  const parent = new Map<FaceId, FaceId>();
  for (const id of ids) parent.set(id, id);
  const find = (x: FaceId): FaceId => {
    let r = x; while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  return {
    has: (x: FaceId) => parent.has(x),
    find,
    union: (a: FaceId, b: FaceId) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); },
    groups: (): FaceId[][] => {
      const g = new Map<FaceId, FaceId[]>();
      for (const x of parent.keys()) (g.get(find(x)) ?? g.set(find(x), []).get(find(x))!).push(x);
      return [...g.values()];
    },
  };
}

interface FaceGeom { face: Face; verts: Vec2[]; z: number[] } // enriched folded polygon + per-vertex z

export function buildModel(state: FoldedState, opts: BuildOptions): Built {
  const eps = opts.epsilon, w = opts.weight;

  // 1. base height per face. A physical SHEET = a SPLIT-connected component of faces; it is
  // drawn FLAT at one height = the TOP stack position it reaches anywhere. So a sheet that is
  // topmost over a 4-layer region and continues over a 2-layer region stays flat on top over
  // both (the big paper doesn't dip and let a small higher piece poke up); thin regions just
  // leave an empty gap under that top sheet. (User-chosen "flat top"; the spec's per-spot
  // ramp is the alternative.) CREASE welding (below) still joins the folds by w.
  const stackIdx = new Map<FaceId, number>();
  for (const spot of state.spots.values()) spot.stack.forEach((id, i) => stackIdx.set(id, i));
  const sheet = makeUF([...state.faces.keys()]);
  for (const e of state.edges.values()) {
    if (e.kind === 'SPLIT' && e.faces[1] !== null) sheet.union(e.faces[0], e.faces[1]);
  }
  const sheetTop = new Map<FaceId, number>(); // component root → max stack index in it
  for (const f of state.faces.values()) {
    const r = sheet.find(f.id), lvl = stackIdx.get(f.id) ?? 0;
    sheetTop.set(r, Math.max(sheetTop.get(r) ?? 0, lvl));
  }
  const levelOf = (id: FaceId): number => sheetTop.get(sheet.find(id)) ?? (stackIdx.get(id) ?? 0);

  // gather every folded vertex position (for conforming T-junction insertion)
  const folded = new Map<FaceId, readonly Vec2[]>();
  const allPos = new Map<string, Vec2>();
  for (const f of state.faces.values()) {
    const fp = foldedPoly(f);
    folded.set(f.id, fp);
    for (const v of fp) allPos.set(keyOf(v), v);
  }
  const positions = [...allPos.values()];

  // 3. conforming subdivision: insert any global vertex lying strictly on a face edge
  const fg = new Map<FaceId, FaceGeom>();
  for (const f of state.faces.values()) {
    const poly = folded.get(f.id)!;
    const out: Vec2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      out.push(a);
      const mid = positions.filter((p) => onEdgeStrict(a, b, p));
      const t = (p: Vec2) => {
        const dx = b.x.sub(a.x), dy = b.y.sub(a.y);
        const dot = p.x.sub(a.x).mul(dx).add(p.y.sub(a.y).mul(dy)), dd = dx.mul(dx).add(dy.mul(dy));
        return dot.toNumber() / dd.toNumber();
      };
      mid.sort((p, q) => t(p) - t(q));
      out.push(...mid);
    }
    const base = levelOf(f.id) * eps;
    fg.set(f.id, { face: f, verts: out, z: out.map(() => base) });
  }

  // per-position (face,vertex) instances, and per-position SPLIT / CREASE adjacency
  const instances = new Map<string, { id: FaceId; vi: number }[]>();
  for (const g of fg.values()) g.verts.forEach((v, vi) => {
    const k = keyOf(v);
    (instances.get(k) ?? instances.set(k, []).get(k)!).push({ id: g.face.id, vi });
  });
  const adj = { SPLIT: new Map<string, [FaceId, FaceId][]>(), CREASE: new Map<string, [FaceId, FaceId][]>() };
  for (const e of state.edges.values()) {
    const [a, b] = e.faces;
    if (b === null || (e.kind !== 'SPLIT' && e.kind !== 'CREASE')) continue;
    const fa = state.faces.get(a);
    if (!fa) continue;
    const map = adj[e.kind as 'SPLIT' | 'CREASE'];
    for (const end of [e.srcSeg[0], e.srcSeg[1]]) {
      const k = keyOf(applyIso(fa.T, end));
      (map.get(k) ?? map.set(k, []).get(k)!).push([a, b]);
    }
  }

  // 2. two-tier weld at each position (tier1 SPLIT always; tier2 CREASE gated by w)
  for (const [k, insts] of instances) {
    if (insts.length < 2 && !(adj.SPLIT.get(k) || adj.CREASE.get(k))) continue;
    const here = new Set(insts.map((i) => i.id));
    const viAt = new Map<FaceId, number>(insts.map((i) => [i.id, i.vi]));
    const zAt = (id: FaceId) => fg.get(id)!.z[viAt.get(id)!]!;

    const weld = (kinds: ('SPLIT' | 'CREASE')[], blend: boolean) => {
      const uf = makeUF(here);
      for (const kind of kinds) for (const [a, b] of adj[kind].get(k) ?? []) {
        if (here.has(a) && here.has(b)) uf.union(a, b);
      }
      for (const grp of uf.groups()) {
        if (grp.length < 2) continue;
        const mean = grp.reduce((s, id) => s + zAt(id), 0) / grp.length;
        for (const id of grp) {
          const g = fg.get(id)!, vi = viAt.get(id)!;
          g.z[vi] = blend ? (1 - w) * g.z[vi]! + w * mean : mean;
        }
      }
    };
    weld(['SPLIT'], false);            // tier 1: unconditional
    weld(['SPLIT', 'CREASE'], true);   // tier 2: hinge clusters, w-blended
  }

  // 4. build meshes + edge lines
  const object = new THREE.Group();
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (const g of fg.values()) addFaceSurface(object, g, box, tmp);
  addEdgeLines(object, state, fg);
  addPendingCreases(object, state, fg);

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { object, center, extent: Math.max(size.x, size.y, size.z) || 1 };
}

function paperMat(color: number, side: THREE.Side): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, side, flatShading: false });
}

/** Unfolded PRECREASE marks (annotation, not topology) as dashed blue lines on their sheet. */
function addPendingCreases(group: THREE.Group, state: FoldedState, fg: Map<FaceId, FaceGeom>): void {
  if (!state.pendingCreases.length) return;
  const mat = new THREE.LineDashedMaterial({ color: 0x2d6cdf, dashSize: 0.03, gapSize: 0.02 });
  for (const pc of state.pendingCreases) {
    const mx = (pc.seg[0].x.toNumber() + pc.seg[1].x.toNumber()) / 2;
    const my = (pc.seg[0].y.toNumber() + pc.seg[1].y.toNumber()) / 2;
    let host: Face | undefined; // source face whose polygon contains the mark's midpoint
    for (const f of state.faces.values()) {
      const poly = f.srcPoly.map(numOf);
      let pos = false, neg = false;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        const s = (b.x - a.x) * (my - a.y) - (b.y - a.y) * (mx - a.x);
        if (s > 1e-9) pos = true; else if (s < -1e-9) neg = true;
      }
      if (!(pos && neg)) { host = f; break; }
    }
    if (!host) continue;
    const g = fg.get(host.id);
    const zc = (g ? Math.max(...g.z) : 0) + 1e-3;
    const p = numOf(applyIso(host.T, pc.seg[0])), q = numOf(applyIso(host.T, pc.seg[1]));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([p.x, p.y, zc, q.x, q.y, zc]), 3));
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    group.add(line);
  }
}

/** Fan-triangulate the (convex) enriched face with per-vertex z; two-sided red/white. */
function addFaceSurface(group: THREE.Group, g: FaceGeom, box: THREE.Box3, tmp: THREE.Vector3): void {
  const xy = g.verts.map(numOf);
  const pos: number[] = [];
  const P = (i: number): number[] => [xy[i]!.x, xy[i]!.y, g.z[i]!];
  for (let i = 1; i + 1 < xy.length; i++) pos.push(...P(0), ...P(i), ...P(i + 1));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  const front = faceIsFront(g.face);
  const top = new THREE.Mesh(geo, paperMat(front ? FRONT_COLOR : BACK_COLOR, THREE.FrontSide));
  const bot = new THREE.Mesh(geo, paperMat(front ? BACK_COLOR : FRONT_COLOR, THREE.BackSide));
  top.userData.faceId = g.face.id; bot.userData.faceId = g.face.id;
  group.add(top, bot);
  for (let i = 0; i < xy.length; i++) box.expandByPoint(tmp.set(xy[i]!.x, xy[i]!.y, g.z[i]!));
}

/** Draw BOUNDARY + folded CREASE edges only (never SPLIT), at the welded height. */
function addEdgeLines(group: THREE.Group, state: FoldedState, fg: Map<FaceId, FaceGeom>): void {
  const pts: number[] = [];
  // z of face `id` at folded point p: exact-key hit, else the nearest enriched vertex's z
  // (robust — a `?? 0` fallback made near-vertical spikes at sub-segment edge endpoints).
  const zAt = (id: FaceId, p: Vec2, np: { x: number; y: number }): number => {
    const g = fg.get(id); if (!g) return 0;
    const k = keyOf(p);
    let bestZ = 0, bd = Infinity;
    for (let i = 0; i < g.verts.length; i++) {
      if (keyOf(g.verts[i]!) === k) return g.z[i]!;
      const d = (g.verts[i]!.x.toNumber() - np.x) ** 2 + (g.verts[i]!.y.toNumber() - np.y) ** 2;
      if (d < bd) { bd = d; bestZ = g.z[i]!; }
    }
    return bestZ;
  };
  for (const e of state.edges.values()) {
    if (e.kind !== 'BOUNDARY' && e.kind !== 'CREASE') continue; // SPLIT never drawn
    const f = state.faces.get(e.faces[0]);
    if (!f) continue;
    const p = applyIso(f.T, e.srcSeg[0]), q = applyIso(f.T, e.srcSeg[1]);
    const np = numOf(p), nq = numOf(q);
    pts.push(np.x, np.y, zAt(f.id, p, np) + 1e-4, nq.x, nq.y, zAt(f.id, q, nq) + 1e-4);
  }
  if (!pts.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: LINE_COLOR })));
}

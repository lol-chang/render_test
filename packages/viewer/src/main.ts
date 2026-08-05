/**
 * Origami folding simulator — viewer entry point (spec §8).
 *
 * - one continuous sheet, deformed through the model's fold history (§8.1)
 * - fold animation: the same mesh with the last fold's angle run 0→π, so the final
 *   frame IS the verified post-state and nothing snaps (§8.2)
 * - interaction (§8.3): hover a face to inspect its stack; in the Interactive model,
 *   click a face, pick an EXACT candidate axis (enumerateAxisCandidates), and get a
 *   live green/red dry-run (movers green if valid, witness red if not) before applying.
 * - history strip of Π(S) thumbnails for time travel.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  checkState, applyOp, planFold, initialSquare, enumerateAxisCandidates, renderSVG, foldedPoly,
  type FoldedState, type FoldOp, type AxisCandidate, type FaceId, type Face,
} from '@origami/core';
import { demos, type Demo } from './demos.js';
import { buildModel, type Built } from './build3d.js';
import { easeInOut } from './animate.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f13);

let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = makePerspective();
let controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.78));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(0.6, 0.8, 1.4);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x88aaff, 0.35);
rimLight.position.set(-0.8, -0.4, 0.8);
scene.add(rimLight);
const grid = new THREE.GridHelper(4, 16, 0x2a2f3a, 0x1c2027);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.02;
scene.add(grid);

function makePerspective() {
  // near = 0.01, not 0.001: the paper skins separate hairline layer inversions with a small
  // polygon offset (see paperMat), and a needlessly tight near plane makes perspective depth
  // ulps so coarse at viewing distance that the offset would swallow a whole layer gap.
  const c = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
  return c;
}
function makeOrtho() {
  const aspect = window.innerWidth / window.innerHeight;
  const h = modelExtent * 1.4 + 0.2;
  return new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, 0.001, 100);
}

// ---- state ----
const demoList = demos();
const userStates: FoldedState[] = [initialSquare()];
const INTERACTIVE: Demo = { name: '🖐 Interactive (fold it yourself)', labels: ['unit square'], states: userStates };
const allDemos: Demo[] = [INTERACTIVE, ...demoList];

let current: Demo = allDemos[0]!;
let step = 0;
let exploded = false;
let topView = true; // spec §8.1: default orthographic top view (matches diagrams / Π(S))
let currentObj: THREE.Object3D | null = null;
let currentBuilt: Built | null = null;
let modelCenter = new THREE.Vector3();
let modelExtent = 1;
let anim: { built: Built; t0: number; dur: number } | null = null;

// interactive fold selections
let selectedFace: FaceId | null = null;
let candidates: AxisCandidate[] = [];
let mode: 'ALL' | 'ONE_LAYER' = 'ALL';
let direction: 'V' | 'M' = 'V';
let side: 'left' | 'right' = 'left';

// V(state; ε) — spec §8.1. ε, the layer gap, is the only shape parameter: a fold's turn radius
// is half the gap for the innermost layer and grows by ε/2 per layer it wraps.
// Explode spreads the stack: NOT a fixed multiple of ε, because a deep, narrow stack (8 layers
// on a ⅛-wide strip) then stands taller than the paper is wide, which is not something one
// sheet of paper can do. Spread it over about the model's smaller silhouette dimension instead.
let epsilon = 0.006;
function epsFor(state: FoldedState): number {
  if (!exploded) return epsilon;
  let depth = 0;
  for (const sp of state.spots.values()) depth = Math.max(depth, sp.stack.length - 1);
  if (depth <= 0) return epsilon * 12;
  let lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
  for (const f of state.faces.values()) for (const p of foldedPoly(f as Face)) {
    const x = p.x.toNumber(), y = p.y.toNumber();
    lo = { x: Math.min(lo.x, x), y: Math.min(lo.y, y) };
    hi = { x: Math.max(hi.x, x), y: Math.max(hi.y, y) };
  }
  // Bound the WHOLE stack, not just the gap. One sheet legitimately runs from level 0 to level
  // 6 (the cup), so every layer of separation is a wall that sheet has to climb; spread them
  // until the stack is as tall as the model is wide and the paper stops reading as paper at
  // all. An eighth of the silhouette is enough to see the order and still see a folded sheet.
  const minDim = Math.max(1e-6, Math.min(hi.x - lo.x, hi.y - lo.y));
  return Math.max(epsilon, Math.min(0.03, minDim / depth, 0.12 / depth));
}
const isInteractive = () => current === INTERACTIVE;

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const demoSel = $<HTMLSelectElement>('demo');
const stepRange = $<HTMLInputElement>('step');
const stepLabel = $('stepLabel');
const info = $('info');
const foldui = $('foldui');
const selinfo = $('selinfo');
const axisSel = $<HTMLSelectElement>('axis');
const foldstatus = $('foldstatus');
const applyBtn = $<HTMLButtonElement>('apply');
const historyEl = $('history');

allDemos.forEach((d, i) => {
  const o = document.createElement('option');
  o.value = String(i); o.textContent = d.name; demoSel.appendChild(o);
});

// ---- rendering ----
function disposeObj(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
  });
}
function clearCurrent() {
  if (currentObj) { scene.remove(currentObj); disposeObj(currentObj); currentObj = null; currentBuilt = null; }
}

function showState(state: FoldedState, reframe = false) {
  clearCurrent();
  // Explode = layer-order pedagogy: the layer gap is the ONLY thing it stretches, and the fold
  // geometry follows it — the turns simply get wider, so the stack stays a stack of one sheet.
  const built = buildModel(state, { epsilon: epsFor(state) });
  scene.add(built.object);
  currentObj = built.object;
  currentBuilt = built;
  modelCenter = built.center; modelExtent = built.extent;
  stepLabel.textContent = `${step}/${current.states.length - 1}`;
  info.textContent = infoText(state);
  if (reframe) frameCamera();
  if (isInteractive()) refreshFoldUI(state);
}

function infoText(state: FoldedState): string {
  const report = checkState(state);
  return `${current.labels[step] ?? ''}\nfaces ${state.faces.size} · layers/spots ${state.spots.size}\n` +
    `checker: ${report.ok ? '✅ valid (I1–I6)' : '❌ ' + report.results.filter((r) => !r.pass).map((r) => r.invariant).join(',')}`;
}

function frameCamera() {
  if (topView) { camera = makeOrtho(); } else { camera = makePerspective(); }
  const d = modelExtent * 1.9 + 0.5;
  if (topView) camera.position.set(modelCenter.x, modelCenter.y, modelCenter.z + d);
  else camera.position.set(modelCenter.x + d * 0.55, modelCenter.y - d * 0.7, modelCenter.z + d * 0.75);
  camera.up.set(0, 1, 0);
  controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(modelCenter);
  controls.update();
}

/**
 * Set emissive highlight on faces by id (others cleared). A sheet is one mesh with one
 * material per fragment (geometry groups), so the tint still lands on exactly the faces asked
 * for even though the paper is drawn as a single continuous surface.
 */
function highlight(map: Map<string, number>) {
  currentObj?.traverse((o) => {
    const m = o as THREE.Mesh;
    const frags = m.userData?.fragIds as string[] | undefined;
    const mats = m.material as THREE.MeshStandardMaterial[] | undefined;
    if (!frags || !Array.isArray(mats)) return;
    frags.forEach((id, i) => mats[i]?.emissive?.setHex(map.get(id) ?? 0x000000));
  });
}

function frameState(): FoldedState { return current.states[step]!; }

// ---- history strip ----
function rebuildHistory() {
  historyEl.innerHTML = '';
  current.states.forEach((st, i) => {
    const img = document.createElement('img');
    img.className = 'thumb' + (i === step ? ' active' : '');
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(renderSVG(st));
    img.title = `step ${i}`;
    img.addEventListener('click', () => goToStep(i, false));
    historyEl.appendChild(img);
  });
}

// ---- navigation ----
function goToStep(n: number, allowAnim: boolean) {
  n = Math.max(0, Math.min(current.states.length - 1, n));
  const forwardOne = n === step + 1;
  const pre = current.states[step]!;
  const post = current.states[n]!;
  step = n; stepRange.value = String(step);
  void pre;
  anim = null;
  showState(post);
  rebuildHistory();
  // §8.2: a forward fold is the SAME mesh with the last fold's angle run 0 → π. The last frame
  // is the committed model, so there is nothing to snap to when it finishes.
  if (allowAnim && forwardOne && currentBuilt?.animatable) {
    currentBuilt.setProgress(0);
    anim = { built: currentBuilt, t0: performance.now(), dur: 650 };
    info.textContent = `${current.labels[step] ?? ''}\n folding…`;
  }
}

function selectDemo(i: number, stepOverride?: number) {
  i = Number.isFinite(i) ? Math.max(0, Math.min(allDemos.length - 1, i)) : 0; // clamp bad hash
  anim = null; selectedFace = null;
  current = allDemos[i]!;
  const last = current.states.length - 1;
  step = stepOverride === undefined || stepOverride < 0 ? last : Math.min(last, stepOverride);
  stepRange.max = String(last); stepRange.value = String(step);
  demoSel.value = String(i);
  foldui.classList.toggle('on', isInteractive());
  showState(current.states[step]!, true);
  rebuildHistory();
}

// ---- interactive fold ----
function refreshFoldUI(state: FoldedState) {
  candidates = enumerateAxisCandidates(state).filter((c) => crossesModel(c, state));
  axisSel.innerHTML = '';
  candidates.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.kind}: (${num(c.a.x)},${num(c.a.y)})–(${num(c.b.x)},${num(c.b.y)})`;
    axisSel.appendChild(o);
  });
  selinfo.textContent = selectedFace ? `seed face: ${selectedFace}` : 'no face selected (needed for One-layer)';
  dryRun();
}
const num = (r: { toNumber(): number }) => Math.round(r.toNumber() * 100) / 100;

/** Numeric filter: keep candidate axes that actually pass through the model interior. */
function crossesModel(c: AxisCandidate, state: FoldedState): boolean {
  const ax = c.a.x.toNumber(), ay = c.a.y.toNumber();
  const dx = c.b.x.toNumber() - ax, dy = c.b.y.toNumber() - ay;
  let pos = false, neg = false;
  for (const f of state.faces.values()) {
    for (const p of foldedPoly(f as Face)) {
      const s = dx * (p.y.toNumber() - ay) - dy * (p.x.toNumber() - ax);
      if (s > 1e-9) pos = true; else if (s < -1e-9) neg = true;
    }
  }
  return pos && neg;
}

function currentOp(): FoldOp | null {
  const c = candidates[Number(axisSel.value)];
  if (!c) return null;
  const base: FoldOp = { type: 'FOLD', mode, axis: { a: c.a, b: c.b }, movingSide: side, direction };
  if (mode === 'ONE_LAYER' && selectedFace) return { ...base, seedFaceIds: [selectedFace] };
  return base;
}

function dryRun() {
  const state = frameState();
  const op = currentOp();
  highlight(new Map());
  if (!op) { foldstatus.textContent = ''; applyBtn.disabled = true; return; }
  const res = applyOp(state, op);
  if (res.ok) {
    // highlight movers green
    const pr = planFold(state, op);
    const hl = new Map<string, number>();
    if ('plan' in pr) pr.plan.moverSet.forEach((id) => hl.set(id, 0x14532d));
    highlight(hl);
    foldstatus.innerHTML = `<span class="ok">✓ valid fold</span>\n${res.state.faces.size} faces · movers highlighted green`;
    applyBtn.disabled = false;
  } else {
    const e = res.error;
    const hl = new Map<string, number>();
    if (e.code === 'E_BLOCKED') e.pair.forEach((id) => hl.set(id, 0x7f1d1d));
    highlight(hl);
    foldstatus.innerHTML = `<span class="bad">✗ ${e.code}</span>\n${witnessText(e)}`;
    applyBtn.disabled = true;
  }
}
function witnessText(e: { code: string } & Record<string, unknown>): string {
  if (e.code === 'E_BLOCKED') return `blocked by layer order: ${(e.pair as string[]).join(' vs ')}`;
  if (e.code === 'E_TEAR') return `would tear (${(e.edges as string[]).length} edge(s))`;
  return '';
}

function applyFold() {
  const state = frameState();
  const op = currentOp();
  if (!op) return;
  const res = applyOp(state, op);
  if (!res.ok) return;
  userStates.length = step + 1; // truncate any redo tail
  userStates.push(res.state);
  selectedFace = null;
  goToStep(step + 1, true);
}

// ---- picking ----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function pick(ev: PointerEvent): string | null {
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera as THREE.Camera);
  if (!currentObj) return null;
  const hits = raycaster.intersectObject(currentObj, true);
  for (const h of hits) {
    // one mesh per facet now, so the fragment (and thus the layer) comes from the triangle hit
    const ids = h.object.userData?.faceIds as string[] | undefined;
    const id = ids && h.faceIndex != null ? ids[h.faceIndex] : undefined;
    if (id) return id;
  }
  return null;
}

canvas.addEventListener('pointermove', (ev) => {
  const id = pick(ev);
  const state = frameState();
  if (id && state.faces.has(id as FaceId)) {
    const spot = [...state.spots.values()].find((s) => s.stack.includes(id as FaceId));
    const depth = spot ? `${spot.stack.indexOf(id as FaceId) + 1}/${spot.stack.length}` : '?';
    canvas.style.cursor = 'pointer';
    selinfo.title = `${id} — layer ${depth}`;
    if (!isInteractive()) info.title = `${id} — layer ${depth} in its spot`;
  } else canvas.style.cursor = 'default';
});

canvas.addEventListener('click', (ev) => {
  if (!isInteractive()) return;
  const id = pick(ev);
  if (id) { selectedFace = id as FaceId; refreshFoldUI(frameState()); }
});

// ---- UI wiring ----
demoSel.addEventListener('change', () => selectDemo(Number(demoSel.value)));
stepRange.addEventListener('input', () => goToStep(Number(stepRange.value), false));
$('prev').addEventListener('click', () => goToStep(step - 1, false));
$('next').addEventListener('click', () => goToStep(step + 1, true));
$('topView').addEventListener('click', (e) => { topView = (e.target as HTMLButtonElement).classList.toggle('active'); frameCamera(); });
$('explode').addEventListener('click', (e) => { exploded = (e.target as HTMLButtonElement).classList.toggle('active'); showState(frameState()); });
axisSel.addEventListener('change', dryRun);

// V(state; ε) slider + presets (§8.1 item 5)
const epsRange = $<HTMLInputElement>('eps');
const epsVal = $('epsVal');
function syncEmbed() { epsVal.textContent = epsilon.toFixed(4); }
epsRange.addEventListener('input', () => { epsilon = Number(epsRange.value); syncEmbed(); showState(frameState()); });
function applyPreset(paper: boolean) {
  epsilon = 0.006; exploded = !paper;
  $('explode').classList.toggle('active', exploded);
  epsRange.value = String(epsilon); syncEmbed();
  showState(frameState());
}
$('presetPaper').addEventListener('click', () => applyPreset(true));
$('presetExplode').addEventListener('click', () => applyPreset(false));
const toggle = (id: string, other: string, set: () => void) => $(id).addEventListener('click', () => {
  $(id).classList.add('active'); $(other).classList.remove('active'); set(); dryRun();
});
toggle('mAll', 'mOne', () => (mode = 'ALL'));
toggle('mOne', 'mAll', () => (mode = 'ONE_LAYER'));
toggle('dV', 'dM', () => (direction = 'V'));
toggle('dM', 'dV', () => (direction = 'M'));
toggle('sL', 'sR', () => (side = 'left'));
toggle('sR', 'sL', () => (side = 'right'));
applyBtn.addEventListener('click', applyFold);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  if (camera instanceof THREE.PerspectiveCamera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  else frameCamera();
}
window.addEventListener('resize', resize);

function tick() {
  requestAnimationFrame(tick);
  if (anim) {
    const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
    anim.built.setProgress(easeInOut(t));
    if (t >= 1) { anim = null; info.textContent = infoText(frameState()); }
  }
  controls.update();
  renderer.render(scene, camera as THREE.Camera);
}

resize();
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('view') === 'persp') { topView = false; $('topView').classList.remove('active'); }
if (hash.get('explode') === '1') { exploded = true; $('explode').classList.add('active'); }
if (hash.has('eps')) epsilon = Number(hash.get('eps'));
$('topView').classList.toggle('active', topView);
epsRange.value = String(epsilon); syncEmbed();
selectDemo(hash.has('demo') ? Number(hash.get('demo')) : 1, hash.has('step') ? Number(hash.get('step')) : undefined);
tick();

/**
 * Origami folding simulator — viewer entry point (spec §8).
 *
 * - static build + continuous-paper rendering (§8.1)
 * - fold animation, movers rotate about the hinge 0→π then snap to the verified
 *   post-state (§8.2)
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
import { buildModel } from './build3d.js';
import { buildFoldAnim, easeInOut, type FoldAnim } from './animate.js';

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
  const c = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 100);
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
let topView = true;
let currentObj: THREE.Object3D | null = null;
let modelCenter = new THREE.Vector3();
let modelExtent = 1;
let anim: { obj: FoldAnim; t0: number; dur: number; post: FoldedState } | null = null;

// interactive fold selections
let selectedFace: FaceId | null = null;
let candidates: AxisCandidate[] = [];
let mode: 'ALL' | 'ONE_LAYER' = 'ALL';
let direction: 'V' | 'M' = 'V';
let side: 'left' | 'right' = 'left';

const thickness = () => (exploded ? 0.09 : 0.014);
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
function clearCurrent() { if (currentObj) { scene.remove(currentObj); disposeObj(currentObj); currentObj = null; } }

function showState(state: FoldedState, reframe = false) {
  clearCurrent();
  const built = buildModel(state, { thickness: thickness() });
  scene.add(built.object);
  currentObj = built.object;
  modelCenter = built.center; modelExtent = built.extent;
  const report = checkState(state);
  stepLabel.textContent = `${step}/${current.states.length - 1}`;
  info.textContent =
    `${current.labels[step] ?? ''}\nfaces ${state.faces.size} · layers/spots ${state.spots.size}\n` +
    `checker: ${report.ok ? '✅ valid (I1–I6)' : '❌ ' + report.results.filter((r) => !r.pass).map((r) => r.invariant).join(',')}`;
  if (reframe) frameCamera();
  if (isInteractive()) refreshFoldUI(state);
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

/** set emissive highlight on faces by id (others cleared) */
function highlight(map: Map<string, number>) {
  currentObj?.traverse((o) => {
    const m = o as THREE.Mesh;
    const id = m.userData?.faceId as string | undefined;
    const mat = m.material as THREE.MeshStandardMaterial | undefined;
    if (!id || !mat || !mat.emissive) return;
    const c = map.get(id);
    mat.emissive.setHex(c ?? 0x000000);
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
  const op = post.lastOp;
  if (allowAnim && forwardOne && op && op.type === 'FOLD') {
    const pr = planFold(pre, op as FoldOp);
    if ('plan' in pr) {
      clearCurrent();
      const a = buildFoldAnim(pr.plan, thickness());
      scene.add(a.object); currentObj = a.object;
      anim = { obj: a, t0: performance.now(), dur: 700, post };
      info.textContent = `${current.labels[step] ?? ''}\n folding…`;
      stepLabel.textContent = `${step}/${current.states.length - 1}`;
      return;
    }
  }
  anim = null;
  showState(post);
  rebuildHistory();
}

function selectDemo(i: number, stepOverride?: number) {
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
    const id = h.object.userData?.faceId as string | undefined;
    if (id) return id;
  }
  return null;
}

canvas.addEventListener('pointermove', (ev) => {
  if (anim) return;
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
  if (!isInteractive() || anim) return;
  const id = pick(ev);
  if (id) { selectedFace = id as FaceId; refreshFoldUI(frameState()); }
});

// ---- UI wiring ----
demoSel.addEventListener('change', () => selectDemo(Number(demoSel.value)));
stepRange.addEventListener('input', () => goToStep(Number(stepRange.value), false));
$('prev').addEventListener('click', () => goToStep(step - 1, false));
$('next').addEventListener('click', () => goToStep(step + 1, true));
$('topView').addEventListener('click', (e) => { topView = (e.target as HTMLButtonElement).classList.toggle('active'); frameCamera(); });
$('explode').addEventListener('click', (e) => { exploded = (e.target as HTMLButtonElement).classList.toggle('active'); if (!anim) showState(frameState()); });
axisSel.addEventListener('change', dryRun);
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
    anim.obj.setAngle(easeInOut(t) * Math.PI);
    if (t >= 1) { const post = anim.post; anim = null; showState(post); rebuildHistory(); }
  }
  controls.update();
  renderer.render(scene, camera as THREE.Camera);
}

resize();
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('view') === 'persp') { topView = false; $('topView').classList.remove('active'); }
selectDemo(hash.has('demo') ? Number(hash.get('demo')) : 1, hash.has('step') ? Number(hash.get('step')) : undefined);
tick();

/**
 * Origami folding simulator — viewer entry point (spec §8).
 *
 * Pick a model, scrub its fold history, and watch each fold animate: the moving
 * layers rotate about the hinge from flat to folded (§8.2), then snap to the exact
 * engine-verified post-state. Orbit the camera; "explode" to inspect layer order.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { checkState, planFold, type FoldedState, type FoldOp } from '@origami/core';
import { demos, type Demo } from './demos.js';
import { buildModel, type Built } from './build3d.js';
import { buildFoldAnim, easeInOut, type FoldAnim } from './animate.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f13);

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
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

const allDemos = demos();
const hash = new URLSearchParams(location.hash.slice(1));
const initDemo = Math.max(0, Math.min(allDemos.length - 1, Number(hash.get('demo') ?? 0)));
const initExplode = hash.get('explode') === '1';
const initTop = hash.get('view') !== 'persp';
const initStep = hash.has('step') ? Number(hash.get('step')) : -1;

let current: Demo = allDemos[0]!;
let step = 0;
let exploded = initExplode;
let topView = initTop;
let currentObj: THREE.Object3D | null = null;
let modelCenter = new THREE.Vector3();
let modelExtent = 1;

// active fold animation, if any
let anim: { obj: FoldAnim; t0: number; dur: number; post: FoldedState } | null = null;

const thickness = (): number => (exploded ? 0.09 : 0.014);

// ---- UI ----
const demoSel = document.getElementById('demo') as HTMLSelectElement;
const stepRange = document.getElementById('step') as HTMLInputElement;
const stepLabel = document.getElementById('stepLabel') as HTMLSpanElement;
const info = document.getElementById('info') as HTMLDivElement;
const btnPrev = document.getElementById('prev') as HTMLButtonElement;
const btnNext = document.getElementById('next') as HTMLButtonElement;
const btnTop = document.getElementById('topView') as HTMLButtonElement;
const btnExplode = document.getElementById('explode') as HTMLButtonElement;

allDemos.forEach((d, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = d.name;
  demoSel.appendChild(opt);
});

function disposeObj(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose?.();
  });
}

function clearCurrent(): void {
  if (currentObj) {
    scene.remove(currentObj);
    disposeObj(currentObj);
    currentObj = null;
  }
}

function showState(state: FoldedState, reframe = false): Built {
  clearCurrent();
  const built = buildModel(state, { thickness: thickness() });
  scene.add(built.object);
  currentObj = built.object;
  modelCenter = built.center;
  modelExtent = built.extent;
  const report = checkState(state);
  stepLabel.textContent = `${step}/${current.states.length - 1}`;
  info.textContent =
    `${current.labels[step]}\n` +
    `faces ${state.faces.size} · layers/spots ${state.spots.size}\n` +
    `checker: ${report.ok ? '✅ valid (I1–I6)' : '❌ ' + report.results.filter((r) => !r.pass).map((r) => r.invariant).join(',')}`;
  if (reframe) frameCamera();
  return built;
}

function frameCamera(): void {
  const d = modelExtent * 1.9 + 0.5;
  if (topView) camera.position.set(modelCenter.x + 0.0001, modelCenter.y + 0.0001, modelCenter.z + d);
  else camera.position.set(modelCenter.x + d * 0.55, modelCenter.y - d * 0.7, modelCenter.z + d * 0.75);
  camera.up.set(0, 1, 0);
  controls.target.copy(modelCenter);
  controls.update();
}

/** Advance to `n`; animate a single-step FOLD forward, otherwise snap. */
function goToStep(n: number, allowAnim: boolean): void {
  n = Math.max(0, Math.min(current.states.length - 1, n));
  const forwardOne = n === step + 1;
  const pre = current.states[step]!;
  const post = current.states[n]!;
  step = n;
  stepRange.value = String(step);

  const op = post.lastOp;
  if (allowAnim && forwardOne && op && op.type === 'FOLD') {
    const planRes = planFold(pre, op as FoldOp);
    if ('plan' in planRes) {
      clearCurrent();
      const a = buildFoldAnim(planRes.plan, thickness());
      scene.add(a.object);
      currentObj = a.object;
      anim = { obj: a, t0: performance.now(), dur: 700, post };
      info.textContent = `${current.labels[step]}\n folding…`;
      stepLabel.textContent = `${step}/${current.states.length - 1}`;
      return;
    }
  }
  anim = null;
  showState(post);
}

function selectDemo(i: number, stepOverride?: number): void {
  anim = null;
  current = allDemos[i]!;
  const last = current.states.length - 1;
  step = stepOverride === undefined || stepOverride < 0 ? last : Math.min(last, stepOverride);
  stepRange.max = String(last);
  stepRange.value = String(step);
  demoSel.value = String(i);
  showState(current.states[step]!, true);
}

demoSel.addEventListener('change', () => selectDemo(Number(demoSel.value)));
stepRange.addEventListener('input', () => goToStep(Number(stepRange.value), false));
btnPrev.addEventListener('click', () => goToStep(step - 1, false));
btnNext.addEventListener('click', () => goToStep(step + 1, true));
btnTop.addEventListener('click', () => {
  topView = btnTop.classList.toggle('active');
  frameCamera();
});
btnExplode.addEventListener('click', () => {
  exploded = btnExplode.classList.toggle('active');
  if (!anim) showState(current.states[step]!);
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function tick(): void {
  requestAnimationFrame(tick);
  if (anim) {
    const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
    anim.obj.setAngle(easeInOut(t) * Math.PI);
    if (t >= 1) {
      const post = anim.post;
      anim = null;
      showState(post); // swap to the exact committed post-state
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

/** Debug/deep-link: freeze the fold that produced `step` at parameter t ∈ [0,1]. */
function showFoldFrozen(t: number): void {
  if (step < 1) return;
  const pre = current.states[step - 1]!;
  const post = current.states[step]!;
  const op = post.lastOp;
  if (!op || op.type !== 'FOLD') return;
  const planRes = planFold(pre, op as FoldOp);
  if (!('plan' in planRes)) return;
  clearCurrent();
  const a = buildFoldAnim(planRes.plan, thickness());
  a.setAngle(easeInOut(t) * Math.PI);
  scene.add(a.object);
  currentObj = a.object;
  frameCamera();
}

resize();
btnTop.classList.toggle('active', topView);
btnExplode.classList.toggle('active', exploded);
selectDemo(initDemo, initStep);
if (hash.has('foldT')) showFoldFrozen(Number(hash.get('foldT')));
tick();

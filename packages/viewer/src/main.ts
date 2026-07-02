/**
 * Origami folding simulator — viewer entry point (spec §8).
 *
 * Renders engine states in 3D: pick a model, scrub through its fold history, orbit
 * the camera, and "explode" the layer stack to inspect ordering. Every frame shows a
 * state the engine has already proven valid (I1–I6).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { checkState } from '@origami/core';
import { demos, type Demo } from './demos.js';
import { buildModel } from './build3d.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f13);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(0.6, 0.8, 1.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.35);
rim.position.set(-0.8, -0.4, 0.6);
scene.add(rim);

// subtle ground grid for orientation
const grid = new THREE.GridHelper(4, 16, 0x2a2f3a, 0x1c2027);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.02;
scene.add(grid);

const allDemos = demos();
// initial view from URL hash, e.g. #demo=2&step=3&view=persp&explode=1 (deep-linking)
const hash = new URLSearchParams(location.hash.slice(1));
const initDemo = Math.max(0, Math.min(allDemos.length - 1, Number(hash.get('demo') ?? 0)));
const initExplode = hash.get('explode') === '1';
const initTop = hash.get('view') !== 'persp';
const initStep = hash.has('step') ? Number(hash.get('step')) : -1;

let current: Demo = allDemos[0]!;
let step = 0;
let exploded = initExplode;
let modelObj: THREE.Object3D | null = null;

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

function rebuild(): void {
  if (modelObj) {
    scene.remove(modelObj);
    modelObj.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
  }
  const state = current.states[step]!;
  modelObj = buildModel(state, { thickness: exploded ? 0.09 : 0.012 });
  scene.add(modelObj);

  const report = checkState(state);
  stepLabel.textContent = `${step}/${current.states.length - 1}`;
  info.textContent =
    `${current.labels[step]}\n` +
    `faces ${state.faces.size} · layers/spots ${state.spots.size}\n` +
    `checker: ${report.ok ? '✅ valid (I1–I6)' : '❌ ' + report.results.filter((r) => !r.pass).map((r) => r.invariant).join(',')}`;
}

function frameCamera(top: boolean): void {
  const extent = (modelObj?.userData.extent as number) ?? 1;
  const d = extent * 1.9 + 0.5;
  if (top) {
    camera.position.set(0.0001, 0.0001, d);
  } else {
    camera.position.set(d * 0.6, -d * 0.7, d * 0.7);
  }
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function setStep(n: number): void {
  step = Math.max(0, Math.min(current.states.length - 1, n));
  stepRange.value = String(step);
  rebuild();
}

function selectDemo(i: number, stepOverride?: number, top = true): void {
  current = allDemos[i]!;
  const last = current.states.length - 1;
  step = stepOverride === undefined || stepOverride < 0 ? last : Math.min(last, stepOverride);
  stepRange.max = String(last);
  stepRange.value = String(step);
  demoSel.value = String(i);
  rebuild();
  frameCamera(top);
}

demoSel.addEventListener('change', () => selectDemo(Number(demoSel.value)));
stepRange.addEventListener('input', () => setStep(Number(stepRange.value)));
btnPrev.addEventListener('click', () => setStep(step - 1));
btnNext.addEventListener('click', () => setStep(step + 1));
btnTop.addEventListener('click', () => {
  const isTop = btnTop.classList.toggle('active');
  frameCamera(isTop);
});
btnExplode.addEventListener('click', () => {
  exploded = btnExplode.classList.toggle('active');
  rebuild();
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

resize();
btnTop.classList.toggle('active', initTop);
btnExplode.classList.toggle('active', initExplode);
selectDemo(initDemo, initStep, initTop);
animate();

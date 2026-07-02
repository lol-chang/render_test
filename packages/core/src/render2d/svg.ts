/**
 * Top-view 2D renderer Π(S) (§7). Pure — produces a deterministic SVG string, no DOM.
 *
 * Visible-surface rule: for each spot the TOP face of the stack determines the fill
 * (front vs back colour via the det-based side rule). Silhouette + top-face edges are
 * drawn solid; crease appearance is view-dependent (computed from the intrinsic
 * assignment and the top face's parity, never stored). Optional xray mode draws
 * hidden creases dashed. Numbers are rounded at the very last step for stable goldens.
 */
import { FoldedState, Spot } from '../state/state.js';
import { foldedPoly, faceIsFront } from '../state/face.js';
import { Assignment } from '../state/edge.js';
import { applyIso, isFront } from '../geom/iso.js';
import { Vec2 } from '../geom/vec2.js';

export interface RenderOptions {
  readonly frontColor?: string;
  readonly backColor?: string;
  readonly xray?: boolean;
  readonly precision?: number; // decimal places (default 3)
  readonly strokeWidth?: number;
}

const DEFAULTS = {
  frontColor: '#d94f5c',
  backColor: '#f3f1ea',
  mountain: '#c0392b',
  valley: '#2d6cdf',
  boundary: '#222222',
  xray: false,
  precision: 3,
  strokeWidth: 0.008,
};

function flipAssign(a: Assignment): Assignment {
  return a === 'V' ? 'M' : 'V';
}

export function renderSVG(state: FoldedState, opts: RenderOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const round = (n: number): string => {
    const f = Math.pow(10, o.precision);
    const r = Math.round(n * f) / f;
    return Object.is(r, -0) ? '0' : String(r);
  };

  // bounds over all spot polygons
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sp of state.spots.values()) {
    for (const p of sp.poly) {
      const x = p.x.toNumber();
      const y = p.y.toNumber();
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (!isFinite(minX)) { minX = 0; maxX = 1; minY = 0; maxY = 1; }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04 + 0.02;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = maxX - minX;
  const h = maxY - minY;

  // SVG y grows downward; flip so origami-up is image-up by negating y.
  const px = (p: Vec2): string => round(p.x.toNumber());
  const py = (p: Vec2): string => round(-p.y.toNumber());
  const polyPath = (poly: readonly Vec2[]): string =>
    poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p)},${py(p)}`).join(' ') + ' Z';

  const spots = [...state.spots.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const topFace = (sp: Spot) => state.faces.get(sp.stack[sp.stack.length - 1]!)!;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(minX)} ${round(-maxY)} ${round(w)} ${round(h)}" width="480" height="480">`,
  );
  parts.push(`<rect x="${round(minX)}" y="${round(-maxY)}" width="${round(w)}" height="${round(h)}" fill="#ffffff"/>`);

  // filled regions (top face of each spot)
  for (const sp of spots) {
    const front = faceIsFront(topFace(sp));
    parts.push(
      `<path d="${polyPath(sp.poly)}" fill="${front ? o.frontColor : o.backColor}" stroke="${o.boundary}" stroke-width="${o.strokeWidth}" stroke-linejoin="round"/>`,
    );
  }

  // helper to draw a crease line from a folded edge
  const creaseLine = (a: Vec2, b: Vec2, assignment: Assignment, hidden: boolean): string => {
    const color = assignment === 'M' ? o.mountain : o.valley;
    const dash = hidden ? ` stroke-dasharray="${round(0.02)} ${round(0.02)}"` : '';
    const opacity = hidden ? ' opacity="0.4"' : '';
    return `<line x1="${px(a)}" y1="${py(a)}" x2="${px(b)}" y2="${py(b)}" stroke="${color}" stroke-width="${o.strokeWidth * 1.4}"${dash}${opacity}/>`;
  };

  // creases (view-dependent). A crease on a top face is solid; others hidden (xray only).
  const topIds = new Set([...state.spots.values()].map((sp) => sp.stack[sp.stack.length - 1]!));
  const edges = [...state.edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of edges) {
    if (e.kind !== 'CREASE' || e.assignment === undefined) continue;
    const [aId] = e.faces;
    const fa = state.faces.get(aId)!;
    const onTop = e.faces.some((id) => id !== null && topIds.has(id));
    if (!onTop && !o.xray) continue;
    // view-dependent: flip intrinsic assignment when the visible face shows its back
    const view: Assignment = isFront(fa.T) ? e.assignment : flipAssign(e.assignment);
    const h0 = applyIso(fa.T, e.srcSeg[0]);
    const h1 = applyIso(fa.T, e.srcSeg[1]);
    parts.push(creaseLine(h0, h1, view, !onTop));
  }

  parts.push('</svg>');
  return parts.join('\n');
}

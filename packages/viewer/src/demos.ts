import {
  Rat,
  initialSquare,
  applyOp,
  type FoldedState,
  type Op,
  type Vec2,
} from '@origami/core';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });
const foldAll = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): Op => ({
  type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide: side, direction: dir,
});
const oneLayer = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): Op => ({
  type: 'FOLD', mode: 'ONE_LAYER', axis: { a, b }, movingSide: side, direction: dir,
});
const flip = (): Op => ({ type: 'FLIP' });
const precrease = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): Op => ({
  type: 'PRECREASE', axis: { a, b }, movingSide: side, direction: dir,
});
const unfold = (): Op => ({ type: 'UNFOLD_LAST' });

export interface Demo {
  name: string;
  labels: string[];
  states: FoldedState[];
}

function run(name: string, steps: Array<{ label: string; op: Op }>): Demo {
  const states: FoldedState[] = [initialSquare()];
  const labels: string[] = ['unit square'];
  let s = states[0]!;
  for (const { label, op } of steps) {
    const r = applyOp(s, op);
    if (!r.ok) throw new Error(`${name}: "${label}" failed: ${JSON.stringify(r.error)}`);
    s = r.state;
    states.push(s);
    labels.push(label);
  }
  return { name, labels, states };
}

export function demos(): Demo[] {
  return [
    run('Half / half again', [
      { label: 'FOLD ALL  x=½  (right, valley)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  y=½  (top, valley)', op: foldAll(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V') },
    ]),
    run('Fold a third over', [
      { label: 'FOLD ALL  x=⅔  (right, valley)', op: foldAll(V(R(2, 3), R(0)), V(R(2, 3), R(1)), 'right', 'V') },
    ]),
    run('Rolling fold (8 layers)', [
      { label: 'FOLD ALL  x=½  (right, valley)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  x=¼  (right, valley)', op: foldAll(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  x=⅛  (right, valley)', op: foldAll(V(R(1, 8), R(0)), V(R(1, 8), R(1)), 'right', 'V') },
    ]),
    run('Rolling fold 2 (rolls the other way)', [
      { label: 'FOLD ALL  x=½  (right, valley)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  x=¼  (left → right, valley)', op: foldAll(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V') },
      { label: 'FOLD ALL  x=⅜  (left → right, valley)', op: foldAll(V(R(3, 8), R(0)), V(R(3, 8), R(1)), 'left', 'V') },
    ]),
    run('Traditional cup', [
      { label: 'FOLD ALL  diagonal  (triangle)', op: foldAll(V(R(0), R(0)), V(R(1), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  corner fold', op: foldAll(V(R(0), R(1, 2)), V(R(1, 2), R(1)), 'left', 'V') },
      { label: 'FOLD ONE_LAYER  front flap', op: oneLayer(V(R(0), R(3, 4)), V(R(1), R(3, 4)), 'left', 'V') },
    ]),
    run('One-layer flap', [
      { label: 'FOLD ALL  x=½  (fold in half)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ONE_LAYER  x=¼  (top flap only)', op: oneLayer(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V') },
    ]),

    run('Two-fold (v1.3 ref)', [
      { label: 'FOLD ALL  x=¾  (right flap)', op: foldAll(V(R(3, 4), R(0)), V(R(3, 4), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  y=½  (top half down)', op: foldAll(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V') },
    ]),

    run('Golden #8 (house)', [
      { label: 'FOLD ALL  (½,1)–(0,½)  top-left corner in, V', op: foldAll(V(R(1, 2), R(1)), V(R(0), R(1, 2)), 'right', 'V') },
      { label: 'FOLD ALL  (½,1)–(1,½)  top-right corner in, V', op: foldAll(V(R(1, 2), R(1)), V(R(1), R(1, 2)), 'left', 'V') },
    ]),

    run('Mountain fold (behind)', [
      { label: 'FOLD ALL  x=½  (right, MOUNTAIN → behind)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'M') },
    ]),
    run('Fold behind + FLIP', [
      { label: 'FOLD ALL  y=½  (MOUNTAIN)', op: foldAll(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'M') },
      { label: 'FLIP  (turn the whole model over)', op: flip() },
    ]),
    run('One-layer behind (M)', [
      { label: 'FOLD ALL  x=½  (fold in half)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ONE_LAYER  x=¼  (top flap, MOUNTAIN)', op: oneLayer(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'M') },
    ]),
    run('Pre-crease then fold', [
      { label: 'PRECREASE  x=½  (mark only, no fold)', op: precrease(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  x=½  (fold along the mark)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'UNFOLD_LAST  (revert the fold)', op: unfold() },
    ]),
    run('Blintz base (4 corners in)', [
      { label: 'FOLD ALL  top-left corner in', op: foldAll(V(R(1, 2), R(1)), V(R(0), R(1, 2)), 'right', 'V') },
      { label: 'FOLD ALL  top-right corner in', op: foldAll(V(R(1, 2), R(1)), V(R(1), R(1, 2)), 'left', 'V') },
      { label: 'FOLD ALL  bottom-left corner in', op: foldAll(V(R(1, 2), R(0)), V(R(0), R(1, 2)), 'left', 'V') },
      { label: 'FOLD ALL  bottom-right corner in', op: foldAll(V(R(1, 2), R(0)), V(R(1), R(1, 2)), 'right', 'V') },
    ]),
    run('Rabbit-ish (band + ears + flip)', [
      { label: 'FOLD ALL  y=½  (band up)', op: foldAll(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V') },
      { label: 'FOLD ALL  left ear', op: foldAll(V(R(1, 2), R(1, 2)), V(R(0), R(1)), 'left', 'V') },
      { label: 'FOLD ALL  right ear', op: foldAll(V(R(1, 2), R(1, 2)), V(R(1), R(1)), 'right', 'V') },
      { label: 'FLIP', op: flip() },
    ]),

    run('Frog (base: house → sides to centre)', [
      { label: 'PRECREASE  x=½  (vertical)', op: precrease(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'PRECREASE  y=½  (horizontal)', op: precrease(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V') },
      { label: 'FOLD  top-left corner → centre  (collapse top)', op: foldAll(V(R(1, 2), R(1)), V(R(0), R(1, 2)), 'right', 'V') },
      { label: 'FOLD  top-right corner → centre  (triangle house)', op: foldAll(V(R(1, 2), R(1)), V(R(1), R(1, 2)), 'left', 'V') },
      { label: 'FOLD  left side → centre line (x=¼)', op: foldAll(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V') },
      { label: 'FOLD  right side → centre line (x=¾)', op: foldAll(V(R(3, 4), R(0)), V(R(3, 4), R(1)), 'right', 'V') },
    ]),
  ];
}

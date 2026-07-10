/**
 * Scripted demo models. Each demo is a list of engine states (one per step) so the
 * viewer can scrub through the fold history. All ops go through the real engine, so
 * what you see is a provably-valid state at every step.
 */
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
const reverseFold = (a: Vec2, b: Vec2, side: 'left' | 'right', dir: 'V' | 'M'): Op => ({
  type: 'INSIDE_REVERSE_FOLD', axis: { a, b }, movingSide: side, direction: dir,
});

export interface Demo {
  name: string;
  labels: string[]; // description of the op that produced each step (step 0 = start)
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
    run('Traditional cup', [
      { label: 'FOLD ALL  diagonal  (triangle)', op: foldAll(V(R(0), R(0)), V(R(1), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  corner fold', op: foldAll(V(R(0), R(1, 2)), V(R(1, 2), R(1)), 'left', 'V') },
      { label: 'FOLD ONE_LAYER  front flap', op: oneLayer(V(R(0), R(3, 4)), V(R(1), R(3, 4)), 'left', 'V') },
    ]),
    run('One-layer flap', [
      { label: 'FOLD ALL  x=½  (fold in half)', op: foldAll(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V') },
      { label: 'FOLD ONE_LAYER  x=¼  (top flap only)', op: oneLayer(V(R(1, 4), R(0)), V(R(1, 4), R(1)), 'left', 'V') },
    ]),
    // §8.1 v1.3 acceptance: the two-fold reference state (flap at x=¾, then top half down).
    // Base sheet's top half is ONE facet: 2 layers over [0,½], 4 over [½,¾] → must ramp, not break.
    run('Two-fold (v1.3 ref)', [
      { label: 'FOLD ALL  x=¾  (right flap)', op: foldAll(V(R(3, 4), R(0)), V(R(3, 4), R(1)), 'right', 'V') },
      { label: 'FOLD ALL  y=½  (top half down)', op: foldAll(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V') },
    ]),
    // Golden #8 (§9.3): interior-anchored diagonal fold — house with two front flaps meeting at C=(½,½).
    run('Golden #8 (house)', [
      { label: 'FOLD ALL  (½,1)–(0,½)  top-left corner in, V', op: foldAll(V(R(1, 2), R(1)), V(R(0), R(1, 2)), 'right', 'V') },
      { label: 'FOLD ALL  (½,1)–(1,½)  top-right corner in, V', op: foldAll(V(R(1, 2), R(1)), V(R(1), R(1, 2)), 'left', 'V') },
    ]),

    // ---- operation showcase (harder / less-common ops, all engine-verified) ----
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
    // Jumping frog. Precrease both midlines, fold all four corners to the centre C=(½,½)
    // to reach the diamond preliminary base, then make the legs with INSIDE_REVERSE_FOLD —
    // the reversed tip tucks BETWEEN existing layers (a plain fold cannot, that is P2), and
    // the engine finds a checker-valid layer nesting. The diamond sits in folded space over
    // y ∈ [−1, 0] (top ½,0 · bottom ½,−1 · sides 0,−½ and 1,−½), so the leg creases are
    // given in those coordinates.
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

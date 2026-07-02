import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { initialSquare } from '../src/state/state.js';
import { serialize } from '../src/state/serialize.js';
import { faceIsFront } from '../src/state/face.js';
import { applyOp } from '../src/ops/apply.js';
import { FoldOp, FlipOp, Op } from '../src/ops/types.js';

const R = (n: number, d = 1) => Rat.of(BigInt(n), BigInt(d));
const V = (x: Rat, y: Rat): Vec2 => ({ x, y });

function foldAllOp(
  a: Vec2,
  b: Vec2,
  movingSide: 'left' | 'right',
  direction: 'V' | 'M',
): FoldOp {
  return { type: 'FOLD', mode: 'ALL', axis: { a, b }, movingSide, direction };
}

// strip step/prev to compare geometry only
function geomKey(json: string): string {
  const o = JSON.parse(json);
  delete o.step;
  return JSON.stringify(o);
}

describe('Appendix A worked example (golden #1: half / half again)', () => {
  it('step 1: FOLD ALL x=1/2 right V → stack [f0:L, f0:R]', () => {
    const s0 = initialSquare();
    const r = applyOp(s0, foldAllOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.ok).toBe(true);
    expect(r.state.faces.size).toBe(2);
    expect(r.state.spots.size).toBe(1);
    const spot = [...r.state.spots.values()][0]!;
    expect([...spot.stack]).toEqual(['f0:L', 'f0:R']);
    // the moving face f0:R now shows its back (det = -1)
    expect(faceIsFront(r.state.faces.get('f0:R' as never)!)).toBe(false);
  });

  it('step 2: then FOLD ALL y=1/2 top(left) V → exact 4-layer stack', () => {
    const s0 = initialSquare();
    const r1 = applyOp(s0, foldAllOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // axis y=1/2 directed +x; "top" (y>1/2) is the LEFT side
    const r2 = applyOp(r1.state, foldAllOp(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V'));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.report.ok).toBe(true);
    expect(r2.state.faces.size).toBe(4);
    expect(r2.state.spots.size).toBe(1);
    const spot = [...r2.state.spots.values()][0]!;
    // Appendix A golden assertion: bottom→top [L-bottom, R-bottom, R-top, L-top].
    // Id suffix meaning here: f0:L=left(x<1/2), f0:R=right(x>1/2); second suffix is
    // top/bottom of the y=1/2 fold — and because f0:R carries a reflection, its ':L'
    // child is the BOTTOM piece (the pulled-back cut line flips direction). So:
    //   f0:L:R = left-bottom, f0:R:L = right-bottom, f0:R:R = right-top, f0:L:L = left-top
    expect([...spot.stack]).toEqual(['f0:L:R', 'f0:R:L', 'f0:R:R', 'f0:L:L']);
  });

  it('step 3: UNFOLD_LAST returns exactly to end of step 1', () => {
    const s0 = initialSquare();
    const r1 = applyOp(s0, foldAllOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'));
    if (!r1.ok) throw new Error('r1');
    const r2 = applyOp(r1.state, foldAllOp(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'V'));
    if (!r2.ok) throw new Error('r2');
    const u = applyOp(r2.state, { type: 'UNFOLD_LAST' });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(serialize(u.state)).toBe(serialize(r1.state));
  });
});

describe('property: involution (FOLD then UNFOLD_LAST = pre-state)', () => {
  it('single fold undoes exactly', () => {
    const s0 = initialSquare();
    const r = applyOp(s0, foldAllOp(V(R(1, 3), R(0)), V(R(1, 3), R(1)), 'right', 'V'));
    if (!r.ok) throw new Error('fold failed');
    const u = applyOp(r.state, { type: 'UNFOLD_LAST' });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(serialize(u.state)).toBe(serialize(s0));
  });
});

describe('property: flip-flip identity', () => {
  it('two flips about the same axis restore geometry', () => {
    const s0 = initialSquare();
    // fold once so there is real structure to flip
    const r = applyOp(s0, foldAllOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'));
    if (!r.ok) throw new Error('fold');
    const f1 = applyOp(r.state, { type: 'FLIP' } as FlipOp);
    if (!f1.ok) throw new Error('flip1');
    const f2 = applyOp(f1.state, { type: 'FLIP' } as FlipOp);
    if (!f2.ok) throw new Error('flip2');
    expect(f2.report.ok).toBe(true);
    expect(geomKey(serialize(f2.state))).toBe(geomKey(serialize(r.state)));
  });

  it('flip shows the back side (det flips)', () => {
    const s0 = initialSquare();
    const f = applyOp(s0, { type: 'FLIP' } as FlipOp);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    for (const face of f.state.faces.values()) expect(faceIsFront(face)).toBe(false);
  });
});

describe('property: determinism (G2)', () => {
  it('same op sequence twice → byte-identical serialization', () => {
    const seq: Op[] = [
      foldAllOp(V(R(1, 2), R(0)), V(R(1, 2), R(1)), 'right', 'V'),
      foldAllOp(V(R(0), R(1, 2)), V(R(1), R(1, 2)), 'left', 'M'),
      { type: 'FLIP' } as FlipOp,
    ];
    const run = () => {
      let s = initialSquare();
      for (const op of seq) {
        const r = applyOp(s, op);
        if (!r.ok) throw new Error(`op failed: ${JSON.stringify(r.error)}`);
        s = r.state;
      }
      return serialize(s);
    };
    expect(run()).toBe(run());
  });
});

describe('partial fold triggers CONF split (fold right third over)', () => {
  it('splits the covered static face and stacks the mover on top', () => {
    const s0 = initialSquare();
    const r = applyOp(s0, foldAllOp(V(R(2, 3), R(0)), V(R(2, 3), R(1)), 'right', 'V'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.ok).toBe(true);
    // mover [2/3,1] reflects onto [1/3,2/3]; static [0,2/3] splits into
    // [0,1/3] (single) and [1/3,2/3] (covered → 2 layers).
    expect(r.state.spots.size).toBe(2);
    const overlap = [...r.state.spots.values()].find((sp) => sp.stack.length === 2)!;
    expect(overlap).toBeDefined();
    // top of the 2-layer spot is the moving flap, now showing its back
    const top = r.state.faces.get(overlap.stack[overlap.stack.length - 1]!)!;
    expect(faceIsFront(top)).toBe(false);
  });
});

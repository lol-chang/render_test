import { describe, it, expect } from 'vitest';
import { Rat } from '../src/geom/rat.js';
import { Vec2 } from '../src/geom/vec2.js';
import { initialSquare } from '../src/state/state.js';
import { applyOp } from '../src/ops/apply.js';
import { Op } from '../src/ops/types.js';
import { enumerateAxisCandidates, lineKey } from '../src/ops/axes.js';
const R=(n:number,d=1)=>Rat.of(BigInt(n),BigInt(d));const V=(x:Rat,y:Rat):Vec2=>({x,y});
const fa=(a:Vec2,b:Vec2,s:'left'|'right',d:'V'|'M'):Op=>({type:'FOLD',mode:'ALL',axis:{a,b},movingSide:s,direction:d});
describe('enumerateAxisCandidates (§8.3)',()=>{
  it('lineKey is orientation- and point-choice-invariant',()=>{
    const k1=lineKey(V(R(0),R(0)),V(R(1),R(1)));
    const k2=lineKey(V(R(1),R(1)),V(R(0),R(0)));   // reversed
    const k3=lineKey(V(R(2),R(2)),V(R(3),R(3)));   // same line, other points
    expect(k1).toBe(k2); expect(k1).toBe(k3);
  });
  it('unit square yields candidates incl. the two diagonals and mid-lines, all distinct',()=>{
    const cands=enumerateAxisCandidates(initialSquare());
    const keys=new Set(cands.map(c=>lineKey(c.a,c.b)));
    expect(keys.size).toBe(cands.length);            // deduped
    // x=1/2 perpendicular bisector of the two bottom corners must be present
    expect(keys.has(lineKey(V(R(1,2),R(0)),V(R(1,2),R(1))))).toBe(true);
    // main diagonal
    expect(keys.has(lineKey(V(R(0),R(0)),V(R(1),R(1))))).toBe(true);
  });
  it('after a fold, existing crease lines appear as candidates',()=>{
    const r=applyOp(initialSquare(),fa(V(R(1,2),R(0)),V(R(1,2),R(1)),'right','V'));
    if(!r.ok)throw new Error('fold');
    const cands=enumerateAxisCandidates(r.state);
    expect(cands.some(c=>c.kind==='crease')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { Rat, onRatBlowup } from '../src/geom/rat.js';

describe('Rat: exact rational arithmetic', () => {
  it('always reduces to lowest terms with positive denominator', () => {
    const r = Rat.of(4n, -8n);
    expect(r.n).toBe(-1n);
    expect(r.d).toBe(2n);
  });

  it('add/sub/mul/div are exact', () => {
    const a = Rat.of(1n, 3n);
    const b = Rat.of(1n, 6n);
    expect(a.add(b).toString()).toBe('1/2');
    expect(a.sub(b).toString()).toBe('1/6');
    expect(a.mul(b).toString()).toBe('1/18');
    expect(a.div(b).toString()).toBe('2/1');
  });

  it('1/3 + 1/3 + 1/3 === 1 exactly (no float drift)', () => {
    const t = Rat.of(1n, 3n);
    expect(t.add(t).add(t).eq(Rat.ONE)).toBe(true);
  });

  it('cmp, sign, isZero, eq', () => {
    expect(Rat.of(1n, 2n).cmp(Rat.of(2n, 3n))).toBe(-1);
    expect(Rat.of(2n, 3n).cmp(Rat.of(1n, 2n))).toBe(1);
    expect(Rat.of(3n, 6n).cmp(Rat.of(1n, 2n))).toBe(0);
    expect(Rat.of(-5n).sign()).toBe(-1);
    expect(Rat.ZERO.isZero()).toBe(true);
    expect(Rat.of(2n, 4n).eq(Rat.of(1n, 2n))).toBe(true);
  });

  it('neg / inv / abs', () => {
    expect(Rat.of(-3n, 4n).abs().toString()).toBe('3/4');
    expect(Rat.of(3n, 4n).inv().toString()).toBe('4/3');
    expect(Rat.of(3n, 4n).neg().toString()).toBe('-3/4');
  });

  it('rejects zero denominator and zero division', () => {
    expect(() => Rat.of(1n, 0n)).toThrow();
    expect(() => Rat.of(1n).div(Rat.ZERO)).toThrow();
    expect(() => Rat.ZERO.inv()).toThrow();
  });

  it('fromDecimalString parses exactly', () => {
    expect(Rat.fromDecimalString('0.25').toString()).toBe('1/4');
    expect(Rat.fromDecimalString('-1.5').toString()).toBe('-3/2');
    expect(Rat.fromDecimalString('3').toString()).toBe('3/1');
    expect(Rat.fromDecimalString('0.1').add(Rat.fromDecimalString('0.2')).toString()).toBe(
      '3/10',
    );
  });

  it('parse round-trips toString', () => {
    const r = Rat.of(-7n, 12n);
    expect(Rat.parse(r.toString()).eq(r)).toBe(true);
  });

  it('fires blowup handler past the bit threshold', () => {
    let fired = false;
    onRatBlowup(() => {
      fired = true;
    });
    // huge coprime numerator/denominator
    const big = 2n ** 300n + 1n;
    Rat.of(big, big - 2n);
    onRatBlowup(null);
    expect(fired).toBe(true);
  });
});

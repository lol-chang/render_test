/**
 * Exact rational arithmetic over bigint (§5.1).
 *
 * Every value is kept in fully reduced form with a strictly positive denominator,
 * so structural equality (`a.n === b.n && a.d === b.d`) coincides with mathematical
 * equality. This is the foundation of G2 (determinism) and of spot identity by
 * hashing (§5.4): there are NO epsilons anywhere in core.
 */

function gcdBig(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Denominator bit-budget warning threshold (§5.1 cost control). */
export const RAT_BITLENGTH_WARN = 512;

export type RatWarnHandler = (info: { bits: number; value: Rat }) => void;
let warnHandler: RatWarnHandler | null = null;

/** Install a handler invoked when a produced Rat exceeds RAT_BITLENGTH_WARN bits. */
export function onRatBlowup(handler: RatWarnHandler | null): void {
  warnHandler = handler;
}

function bitLen(x: bigint): number {
  x = x < 0n ? -x : x;
  return x === 0n ? 0 : x.toString(2).length;
}

export class Rat {
  readonly n: bigint;
  readonly d: bigint; // always > 0, gcd(|n|, d) === 1

  private constructor(n: bigint, d: bigint) {
    this.n = n;
    this.d = d;
  }

  /** Construct a reduced rational. Throws on zero denominator. */
  static of(n: bigint | number, d: bigint | number = 1n): Rat {
    let bn = typeof n === 'bigint' ? n : BigInt(n);
    let bd = typeof d === 'bigint' ? d : BigInt(d);
    if (bd === 0n) throw new Error('Rat: zero denominator');
    if (bd < 0n) {
      bn = -bn;
      bd = -bd;
    }
    const g = gcdBig(bn, bd) || 1n;
    bn /= g;
    bd /= g;
    const r = new Rat(bn, bd);
    if (warnHandler) {
      const bits = bitLen(bn) + bitLen(bd);
      if (bits > RAT_BITLENGTH_WARN) warnHandler({ bits, value: r });
    }
    return r;
  }

  static readonly ZERO = Rat.of(0n);
  static readonly ONE = Rat.of(1n);

  /**
   * Parse an exact decimal string (e.g. "-1.5", "3", "0.25") for test fixtures only.
   * This is the sole float-adjacent entry point permitted in core (§5.1).
   */
  static fromDecimalString(s: string): Rat {
    s = s.trim();
    const neg = s.startsWith('-');
    if (neg || s.startsWith('+')) s = s.slice(1);
    const parts = s.split('.');
    const intPart = parts[0] ?? '';
    const fracPart = parts[1] ?? '';
    if (parts.length > 2 || !/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
      throw new Error(`Rat.fromDecimalString: bad input "${s}"`);
    }
    const digits = (intPart || '0') + fracPart;
    const num = BigInt(digits === '' ? '0' : digits);
    const den = 10n ** BigInt(fracPart.length);
    return Rat.of(neg ? -num : num, den);
  }

  add(o: Rat): Rat {
    return Rat.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Rat): Rat {
    return Rat.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Rat): Rat {
    return Rat.of(this.n * o.n, this.d * o.d);
  }
  div(o: Rat): Rat {
    if (o.n === 0n) throw new Error('Rat: division by zero');
    return Rat.of(this.n * o.d, this.d * o.n);
  }
  neg(): Rat {
    return Rat.of(-this.n, this.d);
  }
  inv(): Rat {
    if (this.n === 0n) throw new Error('Rat: inverse of zero');
    return Rat.of(this.d, this.n);
  }

  /** -1, 0, or +1 depending on this < o, this === o, this > o. */
  cmp(o: Rat): -1 | 0 | 1 {
    const lhs = this.n * o.d;
    const rhs = o.n * this.d; // both denominators > 0, so no sign flip
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
  /** Sign of the value: -1, 0, or +1. */
  sign(): -1 | 0 | 1 {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0;
  }
  isZero(): boolean {
    return this.n === 0n;
  }
  eq(o: Rat): boolean {
    return this.n === o.n && this.d === o.d;
  }
  abs(): Rat {
    return this.n < 0n ? this.neg() : this;
  }

  /** Canonical exact string "n/d" (used for hashing & serialization). */
  toString(): string {
    return `${this.n}/${this.d}`;
  }
  /** Lossy — for renderers/tests only, never for core decisions. */
  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }

  static parse(s: string): Rat {
    const [n, d] = s.split('/');
    if (n === undefined || d === undefined) throw new Error(`Rat.parse: bad "${s}"`);
    return Rat.of(BigInt(n), BigInt(d));
  }
}

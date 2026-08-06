import { FaceId } from '../state/ids.js';

export const ORDER_SEARCH_CAP = 4000;
export const INTERLEAVE_LIMIT = 12;

export function isMoverId(fid: FaceId, seeds: ReadonlySet<FaceId>): boolean {
  if (seeds.has(fid)) return true;
  for (const m of seeds) if (fid.startsWith(`${m}:`)) return true;
  return false;
}

function* interleavings(a: FaceId[], b: FaceId[]): Generator<FaceId[]> {
  if (a.length === 0) { yield [...b]; return; }
  if (b.length === 0) { yield [...a]; return; }
  for (const rest of interleavings(a.slice(1), b)) yield [a[0]!, ...rest];
  for (const rest of interleavings(a, b.slice(1))) yield [b[0]!, ...rest];
}

export function* candidateOrders(
  statics: FaceId[],
  movers: FaceId[],
  preferred?: readonly FaceId[],
): Generator<FaceId[]> {
  if (preferred) yield [...preferred];
  const blocks = movers.length > 1 ? [movers, [...movers].reverse()] : [movers];
  for (const block of blocks) {
    for (let pos = 0; pos <= statics.length; pos++) {
      yield [...statics.slice(0, pos), ...block, ...statics.slice(pos)];
    }
  }
  if (statics.length + movers.length <= INTERLEAVE_LIMIT) yield* interleavings(statics, movers);
}

export function isTrivialOrder(order: readonly FaceId[], moverSet: ReadonlySet<FaceId>): boolean {
  const idx = order.map((id, i) => (moverSet.has(id) ? i : -1)).filter((i) => i >= 0);
  const k = idx.length;
  const n = order.length;
  return idx[0] === n - k || idx[k - 1] === k - 1;
}

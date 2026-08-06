import type { FaceId, FoldGroup, OpError } from '@origami/core';

export interface GroupView {
  readonly title: string;
  readonly note: string;
  readonly why: string;
}

export function reasonText(e: OpError): string {
  switch (e.code) {
    case 'E_BLOCKED':
      return `another layer is in the way (${e.pair.join(' vs ')})`;
    case 'E_TEAR':
      return e.edges.length > 0
        ? `would tear ${e.edges.length} edge${e.edges.length === 1 ? '' : 's'}`
        : 'would tear the paper';
    case 'E_EMPTY_MOVE':
      return 'nothing on the moving side';
    case 'E_AXIS_DEGENERATE':
      return 'the axis is a point, not a line';
    case 'E_INVARIANT':
      return `the result would break ${e.invariant}`;
    case 'E_UNSUPPORTED':
      return e.detail;
    default:
      return '';
  }
}

export function groupKeyOf(g: FoldGroup): string {
  return g.faces.join('|');
}

export function groupHolds(g: FoldGroup, face: FaceId): boolean {
  return g.faces.some((id) => id === face || id.startsWith(`${face}:`));
}

export function describeGroup(g: FoldGroup, direction: 'V' | 'M'): GroupView {
  const peel = g.layers.length
    ? Math.max(...g.layers.map((l) => l.indices.length))
    : g.faces.length;
  const thickest = g.layers.length ? Math.max(...g.layers.map((l) => l.stackSize)) : peel;
  const end = direction === 'V' ? 'top' : 'bottom';
  const title = peel === 1 ? `${end} layer` : `${end} ${peel} layers`;

  const note = [`${g.faces.length} face${g.faces.length === 1 ? '' : 's'}`];
  if (thickest > peel) note.push(`${peel} of ${thickest} in the thickest stack`);
  if (g.bonded) {
    note.push(
      `+${g.bondedTo.length} joined off the hinge, cannot be separated`,
    );
  }

  return {
    title,
    note: note.join(' · '),
    why: g.reason ? `${g.reason.code} · ${reasonText(g.reason)}` : '',
  };
}

export function pickGroup(
  groups: readonly FoldGroup[],
  key: string | null,
  face: FaceId | null,
): number {
  if (key !== null) {
    const kept = groups.findIndex((g) => groupKeyOf(g) === key);
    if (kept >= 0) return kept;
  }
  if (face !== null) {
    const usable = groups.findIndex((g) => g.foldable && groupHolds(g, face));
    if (usable >= 0) return usable;
    const any = groups.findIndex((g) => groupHolds(g, face));
    if (any >= 0) return any;
  }
  return groups.findIndex((g) => g.foldable);
}

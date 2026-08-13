/** Corner of the session stage where the arrow pad (`DpadSheet`) anchors. */
export type DpadPlacement =
  | 'bottom-left'
  | 'bottom-right'
  | 'top-left'
  | 'top-right';

/** Stock placement through 0.15.2 (hardcoded CSS left/bottom). */
export const DEFAULT_DPAD_PLACEMENT: DpadPlacement = 'bottom-left';

const PLACEMENTS = new Set<DpadPlacement>([
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right',
]);

/** Normalize a host value; unknown → stock bottom-left. */
export function resolveDpadPlacement(value: unknown): DpadPlacement {
  if (typeof value === 'string' && PLACEMENTS.has(value as DpadPlacement)) {
    return value as DpadPlacement;
  }
  return DEFAULT_DPAD_PLACEMENT;
}

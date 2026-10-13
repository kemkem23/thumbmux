/** Stock placement through 0.15.2 (hardcoded CSS left/bottom). */
export const DEFAULT_DPAD_PLACEMENT = 'bottom-left';
const PLACEMENTS = new Set([
    'bottom-left',
    'bottom-right',
    'top-left',
    'top-right',
]);
/** Normalize a host value; unknown → stock bottom-left. */
export function resolveDpadPlacement(value) {
    if (typeof value === 'string' && PLACEMENTS.has(value)) {
        return value;
    }
    return DEFAULT_DPAD_PLACEMENT;
}

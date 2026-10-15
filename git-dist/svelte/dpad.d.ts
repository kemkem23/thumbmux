/** Corner of the session stage where the arrow pad (`DpadSheet`) anchors. */
export type DpadPlacement = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
/** Stock placement through 0.15.2 (hardcoded CSS left/bottom). */
export declare const DEFAULT_DPAD_PLACEMENT: DpadPlacement;
/** Normalize a host value; unknown → stock bottom-left. */
export declare function resolveDpadPlacement(value: unknown): DpadPlacement;

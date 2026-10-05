import { muxHistoryBoundaryTransition, } from '../core/index.js';
export function createLiveBoundaryAdmission() {
    return { highWater: null };
}
/**
 * Admit a complete output frame before it reaches either screen state or the
 * content coalescing gate. The applied seam can lag while a gesture/selection
 * holds a newer delivery, so the pending high-water mark is authoritative.
 */
export function admitLiveBoundary(admission, applied, incoming) {
    const previous = admission.highWater ?? applied;
    if (previous && muxHistoryBoundaryTransition(previous, incoming) === 'regression') {
        return { admission, accepted: false };
    }
    return {
        admission: { highWater: { ...incoming } },
        accepted: true,
    };
}

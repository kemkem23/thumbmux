import { type MuxHistoryBoundary } from '../core/index.js';
export type LiveBoundaryAdmission = {
    highWater: MuxHistoryBoundary | null;
};
export type LiveBoundaryAdmissionResult = {
    admission: LiveBoundaryAdmission;
    accepted: boolean;
};
export declare function createLiveBoundaryAdmission(): LiveBoundaryAdmission;
/**
 * Admit a complete output frame before it reaches either screen state or the
 * content coalescing gate. The applied seam can lag while a gesture/selection
 * holds a newer delivery, so the pending high-water mark is authoritative.
 */
export declare function admitLiveBoundary(admission: LiveBoundaryAdmission, applied: MuxHistoryBoundary | null, incoming: MuxHistoryBoundary): LiveBoundaryAdmissionResult;

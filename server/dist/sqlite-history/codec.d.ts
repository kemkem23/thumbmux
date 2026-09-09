import type { CaptureObservation, HistoryRow } from './types';
export declare function safe(value: number, label?: string): number;
export declare function sha(value: string | Uint8Array): string;
export declare function rowsDigest(rows: readonly HistoryRow[]): string;
export declare function validateObservation(o: CaptureObservation): void;

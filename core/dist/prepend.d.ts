import { type SgrState } from './ansi-html';
export declare function planPrepend(batch: string[], firstExistingLineRaw: string, existingFirstState: SgrState): {
    batchStates: SgrState[];
    endState: SgrState;
    existingCacheValid: boolean;
};

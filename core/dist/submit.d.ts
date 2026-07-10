export type SubmitStep = {
    keys: string;
    delayBeforeMs: number;
};
export type SubmitAgent = `${'clau'}${'de'}` | `${'co'}${'dex'}` | `${'gr'}${'ok'}` | 'generic';
export type SubmitPlanOptions = {
    agent?: SubmitAgent;
    enterDelayMs?: number;
};
/**
 * Builds keystroke batches for submitting composed text to an alt-screen TUI.
 *
 * Bulk text can still be draining through bracketed-paste handlers when Enter
 * arrives. Delaying Enter gives the TUI time to ingest the paste so the submit
 * key is not consumed as paste data. Hosts using a request/response transport
 * such as REST can treat the awaited round trip before sending each step as
 * satisfying delayBeforeMs.
 */
export declare function submitPlan(text: string, opts?: SubmitPlanOptions): SubmitStep[];

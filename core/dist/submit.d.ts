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
 *
 * The text step never carries a bare CR/LF. A reference transport types keys
 * literally; an embedded `\r` would submit a partial prompt before the rest of
 * the batch landed, then the planned delayed Enter would submit again. Multline
 * or host-supplied CR/LF content is therefore wrapped in bracketed paste so
 * line breaks stay data. Only the delayed Enter steps below are allowed to
 * submit.
 */
export declare function submitPlan(text: string, opts?: SubmitPlanOptions): SubmitStep[];

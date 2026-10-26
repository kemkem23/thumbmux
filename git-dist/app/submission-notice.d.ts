/**
 * Copy for the existing compose failure bar.
 *
 * The phrase is short Thai. The parenthetical is the reason code the receipt
 * already carried (`network`, `http_502`, `in_doubt`, a server code, …).
 * Anything that is not a code is not echoed — a receipt must not become a
 * second place the typed text can show up.
 */
/** Thai phrase plus the reason code, for one receipt.reason. */
export declare function submissionFailureNotice(reason: string): string;
export declare function noticeAfterSubmit(receipt: {
    status?: 'sent' | 'rejected' | 'uncertain';
    reason?: string;
} | null | undefined, fallbackUncertain: string): string | null;

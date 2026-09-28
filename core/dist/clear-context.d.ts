/**
 * Clearing an agent's conversation is a keystroke plan, not one key.
 *
 * `/clear` typed into a CLI that already has half a line in its composer
 * appends to that line and submits something nobody asked for, so the plan
 * always starts by discarding the composer. Codex needs more than that: it
 * parks pasted text in an input mode that swallows the first Enter, so the
 * mode has to be cancelled and the command given a second, separately timed
 * Enter — the same shape `submitPlan` already describes for a normal
 * submission, for the same reason.
 *
 * The plan is data so the transport stays the host's business. A tmux host
 * sends symbolic key names through `send-keys`; a byte transport maps the
 * control step through `CLEAR_CONTEXT_CONTROL_BYTES`. Neither reads the pane:
 * every delay here is a fixed wait, and no step is conditioned on what the
 * screen came back with.
 */
import type { SubmitAgent } from './submit';
/** Symbolic control keys the plan can ask for (tmux `send-keys` spelling). */
export type ClearContextControlKey = 'C-u' | 'Escape';
/**
 * Byte for each control key, for transports that write raw input instead of
 * symbolic names: C-u is NAK (0x15, "kill line"), Escape is ESC (0x1b).
 */
export declare const CLEAR_CONTEXT_CONTROL_BYTES: Record<ClearContextControlKey, string>;
export type ClearContextStep = 
/** Send one control key. Never submits. */
{
    kind: 'control';
    control: ClearContextControlKey;
    delayBeforeMs: number;
}
/** Type `text` into the composer and submit it. */
 | {
    kind: 'submit';
    text: string;
    delayBeforeMs: number;
}
/** Submit whatever is in the composer, sending no text. */
 | {
    kind: 'enter';
    delayBeforeMs: number;
};
export type ClearContextPlanOptions = {
    agent?: SubmitAgent;
    /** The command to send. Default `/clear` — the spelling every agent CLI here uses. */
    command?: string;
    /**
     * Pause after discarding the composer, before the command is typed, on the
     * single-submit path. A TUI still redrawing after C-u can otherwise eat the
     * first characters. Default 120.
     */
    settleMs?: number;
    /**
     * Pause used twice on the codex path: after Escape (before the command) and
     * after the command (before the second Enter). Default 1000.
     */
    codexSecondEnterMs?: number;
};
export declare const DEFAULT_CLEAR_COMMAND = "/clear";
/** Which shape of plan an agent gets — mirrors the strategy a host reports back. */
export type ClearContextStrategy = 'single-submit' | 'codex-double-enter';
export declare function clearContextStrategy(agent?: SubmitAgent): ClearContextStrategy;
/**
 * Build the keystroke plan for clearing an agent's context.
 *
 * `delayBeforeMs` is a wait the caller owes *before* sending that step. A host
 * whose transport already costs real time per step (a REST round trip) may
 * count that round trip against the delay, exactly as `submitPlan` allows.
 */
export declare function clearContextPlan(opts?: ClearContextPlanOptions): ClearContextStep[];

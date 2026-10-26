import type { NewarchV2FixedGeometry, NewarchV2PaneDescriptor } from '../core/index.js';
/**
 * PLAN-v2 lot U: who decides this pane's size.
 *
 * - `viewer`        legacy pane; the host's claimGeometry applies as before.
 * - `fixed`         NEWARCH v2 pane born at a fixed size. The viewport, font,
 *                   rotation and keyboard are presentation only — no resize.
 * - `unknown-owner` the inventory names a v2 lookup it could not resolve
 *                   (owner store unavailable or a malformed descriptor).
 * - `pending`       no inventory row delivered yet.
 *
 * Only `viewer` may claim geometry. An unresolved owner is never guessed to
 * be legacy, because a guessed resize lands on a pane whose history the
 * capture engine records at its birth geometry.
 */
export type SessionGeometryPolicy = {
    readonly kind: 'viewer';
} | {
    readonly kind: 'pending';
} | {
    readonly kind: 'unknown-owner';
    readonly reason: 'owner-unavailable' | 'malformed';
} | {
    readonly kind: 'fixed';
    readonly panes: readonly NewarchV2PaneDescriptor[];
    /** Shared birth geometry; null when the session's panes differ. */
    readonly geometry: NewarchV2FixedGeometry | null;
};
/** Structural check of a wire descriptor; anything else is malformed. */
export declare function isNewarchV2PaneDescriptor(value: unknown): value is NewarchV2PaneDescriptor;
/**
 * Resolve the policy from one session-inventory row. `rowsSeen` is false
 * until the first inventory delivery; a row without `newarchV2` (or a v2
 * lookup that answers `missing`) is a legacy session. The field carries a
 * `NewarchV2PaneSelection`; panes inside `ambiguous` are all fixed.
 */
export declare function resolveSessionGeometryPolicy(row: unknown, rowsSeen: boolean): SessionGeometryPolicy;
import { type AppAdapters } from './config.js';
type $$ComponentProps = {
    session: string;
    adapters: AppAdapters;
};
declare const SessionView: import("svelte").Component<$$ComponentProps, {}, "">;
type SessionView = ReturnType<typeof SessionView>;
export default SessionView;

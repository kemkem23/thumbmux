type $$ComponentProps = {
    /** absolute path shown verbatim; blank or whitespace-only hides the row */
    cwd?: string;
    /** already-formatted "last moved" text, e.g. "3 นาทีที่แล้ว" */
    activityLabel?: string;
    /** machine-readable timestamp for <time datetime>; omit for a plain span */
    activityDatetime?: string;
    /** caption in front of the path — host's wording, host's language */
    cwdLabel?: string;
    /** optional caption in front of the activity text; omitted by default so
     * the row reads as bare relative time the way the grid already shows it */
    activityLabelText?: string;
    /** selectors the host depends on — override to keep existing host hooks */
    testid?: string;
    cwdTestid?: string;
    activityTestid?: string;
    /** extra class on the wrapper for host layout (global CSS only — Svelte
     * scoping means a host's scoped rules never reach this subtree) */
    extraClass?: string;
};
declare const SessionMetadata: import("svelte").Component<$$ComponentProps, {}, "">;
type SessionMetadata = ReturnType<typeof SessionMetadata>;
export default SessionMetadata;

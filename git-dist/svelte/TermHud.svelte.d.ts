import type { Snippet } from 'svelte';
/** Structurally-typed snippet: Svelte's `Snippet` carries a nominal brand
 * (unique symbol), so in monorepos where the host and this package resolve
 * different copies of svelte, `Snippet !== Snippet`. A callable type keeps
 * the prop assignable from any copy; we brand it back at the render site. */
type PanelSnippet = (() => unknown) | Snippet;
type $$ComponentProps = {
    chip: string;
    title: string;
    note?: string;
    status?: string;
    working?: boolean;
    expanded?: boolean;
    onBack: () => void;
    onToggleExpand?: () => void;
    backAria?: string;
    panel?: PanelSnippet;
    /** measured rendered height of the pinned bar (incl. safe-area padding) —
     * bind it and inset your terminal host below the (opaque) HUD. */
    barHeight?: number;
    /** Inline slot on the session-name row, rendered after the title and
     * before the caret, at the row's own font size and never case-transformed.
     *
     * It COLLAPSES rather than competing for width: when the name and the slot
     * cannot both be read on one row, the slot leaves the row and the name
     * keeps all of it. Half a badge beside a name clipped to its caret is two
     * unreadable things where one of them is what the operator came to read —
     * so the slot yields entirely instead of both shrinking. The row may
     * therefore drop the slot briefly while it is still measuring.
     *
     * Omit the prop and this row renders exactly as it did before it existed. */
    titleAdornment?: PanelSnippet;
    /** Text placed before `note`. Defaults to the historical `'✎ '`; pass `''`
     * to render the note exactly as given. */
    notePrefix?: string;
    /** `'upper'` (default, historical) uppercases `status`; `'none'` renders it
     * exactly as given. */
    statusCase?: 'upper' | 'none';
};
declare const TermHud: import("svelte").Component<$$ComponentProps, {}, "barHeight" | "expanded">;
type TermHud = ReturnType<typeof TermHud>;
export default TermHud;

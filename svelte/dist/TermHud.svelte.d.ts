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
};
declare const TermHud: import("svelte").Component<$$ComponentProps, {}, "expanded" | "barHeight">;
type TermHud = ReturnType<typeof TermHud>;
export default TermHud;

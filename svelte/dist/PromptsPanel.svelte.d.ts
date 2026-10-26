/** PromptsPanel — recent prompts extracted from the pane (core prompt-scan);
 * tap one to prefill the composer (host calls ComposerDock.openCompose()).
 * Lives inside TermHud's panel snippet next to NotePanel.
 *
 * `entries` (optional) is the structured form: exact rows sent from the UI
 * and rows rebuilt from the screen, rendered as two sections. The source and
 * delivery badges are separate elements, so `onPick` always receives
 * `entry.text` byte for byte. Without `entries` the legacy `prompts` list
 * renders exactly as before. */
/** Structurally identical to `PromptEntry` in `@thumbmux/app/config`;
 *  declared here because this package cannot import the app layer. */
type PanelPromptEntry = {
    text: string;
    source: 'ui' | 'screen';
    state?: 'sent' | 'uncertain';
    submissionId?: string;
};
type $$ComponentProps = {
    prompts?: string[];
    /** When set (including `[]`) this replaces `prompts` as the list source. */
    entries?: readonly PanelPromptEntry[] | null;
    loading?: boolean;
    onPick: (prompt: string) => void;
    /** Render the title as a disclosure control. Default false keeps the
     *  always-open list, DOM and CSS identical to before this prop existed. */
    collapsible?: boolean;
    /** Start expanded. Ignored unless `collapsible`. */
    initiallyOpen?: boolean;
    labels?: {
        title: string;
        loading: string;
        none: string;
        sourceUi?: string;
        sourceScreen?: string;
        uncertain?: string;
    };
};
declare const PromptsPanel: import("svelte").Component<$$ComponentProps, {}, "">;
type PromptsPanel = ReturnType<typeof PromptsPanel>;
export default PromptsPanel;

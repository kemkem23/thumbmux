type $$ComponentProps = {
    prompts?: string[];
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
    };
};
declare const PromptsPanel: import("svelte").Component<$$ComponentProps, {}, "">;
type PromptsPanel = ReturnType<typeof PromptsPanel>;
export default PromptsPanel;

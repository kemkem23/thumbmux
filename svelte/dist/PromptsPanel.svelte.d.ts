type $$ComponentProps = {
    prompts?: string[];
    loading?: boolean;
    onPick: (prompt: string) => void;
    labels?: {
        title: string;
        loading: string;
        none: string;
    };
};
declare const PromptsPanel: import("svelte").Component<$$ComponentProps, {}, "">;
type PromptsPanel = ReturnType<typeof PromptsPanel>;
export default PromptsPanel;

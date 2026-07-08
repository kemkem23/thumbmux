export type ComposerLabels = {
    compose: string;
    direct: string;
    hintCompose: string;
    hintDirect: string;
    placeholder: string;
    send: string;
    close: string;
    directAria: string;
};
type $$ComponentProps = {
    open?: boolean;
    mode?: 'compose' | 'direct';
    text?: string;
    dockInset?: number;
    dockFull?: number;
    kbInset?: number;
    onSend: (text: string) => void;
    onDirectText: (data: string) => void;
    onDirectKey: (seq: string) => void;
    labels?: ComposerLabels;
};
declare const ComposerDock: import("svelte").Component<$$ComponentProps, {
    openDock: () => void;
    openCompose: () => void;
    closeDock: () => void;
}, "open" | "mode" | "text" | "dockInset" | "dockFull" | "kbInset">;
type ComposerDock = ReturnType<typeof ComposerDock>;
export default ComposerDock;

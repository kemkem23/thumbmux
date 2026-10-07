export type DesktopPasteInfo = {
    text: string;
    lineCount: number;
    byteLength: number;
    reason: 'multiline' | 'large' | 'multiline-large';
};
export type DesktopKeysProps = {
    enabled?: boolean;
    focused?: boolean;
    ariaLabel?: string;
    pasteWarningLines?: number;
    pasteWarningBytes?: number;
    /** Alt/Option+printable → ESC prefix (PC style). Default: auto — true
     * everywhere except macOS-like platforms, where Option composes characters
     * that should be sent verbatim. */
    altIsMeta?: boolean;
    onKeys: (data: string) => void;
    onFocusChange?: (focused: boolean) => void;
    confirmPaste?: (info: DesktopPasteInfo) => boolean | Promise<boolean>;
    children?: import('svelte').Snippet;
};
import type { Snippet } from 'svelte';
type ChildSnippet = (() => unknown) | Snippet;
type RuntimeProps = Omit<DesktopKeysProps, 'children'> & {
    children?: ChildSnippet;
};
declare const DesktopKeys: import("svelte").Component<RuntimeProps, {}, "focused">;
type DesktopKeys = ReturnType<typeof DesktopKeys>;
export default DesktopKeys;

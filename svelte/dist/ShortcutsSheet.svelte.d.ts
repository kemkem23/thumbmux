/** ShortcutsSheet — manage the ShortcutBar chips: add, edit-in-place,
   * reorder, delete. Pure presentation; the host persists via onChange
   * (usually straight into its PreferencesAdapter). */
import type { Shortcut } from '@thumbmux/core';
type $$ComponentProps = {
    open?: boolean;
    shortcuts?: Shortcut[];
    onChange: (next: Shortcut[]) => void;
    title?: string;
    labels?: {
        add: string;
        label: string;
        send: string;
        close: string;
        del: string;
        up: string;
        down: string;
    };
};
declare const ShortcutsSheet: import("svelte").Component<$$ComponentProps, {}, "open">;
type ShortcutsSheet = ReturnType<typeof ShortcutsSheet>;
export default ShortcutsSheet;

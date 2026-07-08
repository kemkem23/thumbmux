/** ShortcutBar — one-tap prompt chips ("continue", "ไปต่อ", …) pinned above
   * the composer dock. Config-driven: the host feeds shortcuts (usually from
   * prefs) and decides what "send" means (smartSubmit per agent). */
import type { Shortcut } from '@thumbmux/core';
type $$ComponentProps = {
    shortcuts?: Shortcut[];
    visible?: boolean;
    /** current session's agent kind — chips whose s.agent mismatches are
     * hidden (absent prop or absent s.agent = show everywhere) */
    agent?: string;
    onSend: (s: Shortcut) => void;
    /** optional gear chip that opens the host's ShortcutsSheet */
    onManage?: () => void;
    manageLabel?: string;
};
declare const ShortcutBar: import("svelte").Component<$$ComponentProps, {}, "">;
type ShortcutBar = ReturnType<typeof ShortcutBar>;
export default ShortcutBar;

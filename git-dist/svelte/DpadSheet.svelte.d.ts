import { type DpadPlacement } from './dpad.js';
type $$ComponentProps = {
    open?: boolean;
    onKey: (seq: string) => void;
    /** Stage corner. Defaults to `'bottom-left'` (historical stock). */
    placement?: DpadPlacement;
};
declare const DpadSheet: import("svelte").Component<$$ComponentProps, {}, "open">;
type DpadSheet = ReturnType<typeof DpadSheet>;
export default DpadSheet;

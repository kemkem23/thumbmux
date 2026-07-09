export type GridSession = {
    name: string;
    /** small badge text, e.g. agent kind */
    chip?: string;
    /** accent for the badge/border */
    color?: string;
    /** per-session thumbnail palette override */
    palette?: import('@thumbmux/core').AnsiPalette;
};
import type { AnsiPalette } from '@thumbmux/core';
type $$ComponentProps = {
    sessions: GridSession[];
    /** default thumbnail palette (per-session override via GridSession.palette) */
    palette: AnsiPalette;
    onOpen: (name: string) => void;
    onNew: () => void;
    newLabel?: string;
    emptyLabel?: string;
};
declare const SessionGrid: import("svelte").Component<$$ComponentProps, {}, "">;
type SessionGrid = ReturnType<typeof SessionGrid>;
export default SessionGrid;

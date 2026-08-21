import { type AnsiPalette } from '@thumbmux/core';
type $$ComponentProps = {
    session: string;
    palette: AnsiPalette;
    maxLines?: number;
    /** Opt-in preview density used by large hub cards. The historical thumbnail
     * sizing and 30-line tail remain the default. */
    density?: 'default' | 'dense';
};
declare const SessionThumb: import("svelte").Component<$$ComponentProps, {}, "">;
type SessionThumb = ReturnType<typeof SessionThumb>;
export default SessionThumb;

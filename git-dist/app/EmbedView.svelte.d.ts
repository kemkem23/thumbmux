import { type AppAdapters } from './config.js';
type $$ComponentProps = {
    session: string;
    adapters: AppAdapters;
    fontPx?: number;
    minRows?: number;
    claimGeometry?: boolean;
    fixedGeometry?: {
        columns: number;
        rows: number;
    } | null;
};
declare const EmbedView: import("svelte").Component<$$ComponentProps, {}, "">;
type EmbedView = ReturnType<typeof EmbedView>;
export default EmbedView;

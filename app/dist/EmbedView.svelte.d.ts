import { type AppAdapters } from './config';
type $$ComponentProps = {
    session: string;
    adapters: AppAdapters;
    fontPx?: number;
    minRows?: number;
    claimGeometry?: boolean;
};
declare const EmbedView: import("svelte").Component<$$ComponentProps, {}, "">;
type EmbedView = ReturnType<typeof EmbedView>;
export default EmbedView;

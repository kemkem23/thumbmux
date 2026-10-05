import { type AppAdapters } from './config.js';
type $$ComponentProps = {
    adapters: AppAdapters;
    /** Internal navigation event used when the host did not supply routes. */
    onOpen?: (name: string) => void;
};
declare const HubView: import("svelte").Component<$$ComponentProps, {}, "">;
type HubView = ReturnType<typeof HubView>;
export default HubView;

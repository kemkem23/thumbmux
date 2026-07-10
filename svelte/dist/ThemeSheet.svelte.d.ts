type $$ComponentProps = {
    open?: boolean;
    title: string;
    mode: 'dark' | 'light';
    onToggleMode: (mode: 'dark' | 'light') => void;
    swatchLabel: string;
    swatches: string[];
    currentBg: string;
    defaultBg: string;
    onPick: (hex: string) => void;
    onReset: () => void;
    customBg?: string;
    labels?: {
        dark: string;
        light: string;
        def: string;
        custom: string;
        close: string;
    };
};
declare const ThemeSheet: import("svelte").Component<$$ComponentProps, {}, "open" | "customBg">;
type ThemeSheet = ReturnType<typeof ThemeSheet>;
export default ThemeSheet;

type $$ComponentProps = {
    /** current value, owned by the host */
    enabled?: boolean;
    /** label for the `false` side (host's wording and language) */
    offLabel: string;
    /** label for the `true` side */
    onLabel: string;
    /** called with the new value only when it differs from `enabled` */
    onChange: (next: boolean) => void;
    disabled?: boolean;
    /** explanation for the state currently shown — the host picks which text,
     * so provider names and policy prose stay out of the package */
    hint?: string;
    testid?: string;
    offTestid?: string;
    onTestid?: string;
    hintTestid?: string;
    /** BCP-47 tag applied to the labels/hint so host typography rules apply */
    lang?: string;
    extraClass?: string;
};
declare const ThemeSourceChoice: import("svelte").Component<$$ComponentProps, {}, "">;
type ThemeSourceChoice = ReturnType<typeof ThemeSourceChoice>;
export default ThemeSourceChoice;

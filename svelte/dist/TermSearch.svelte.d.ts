import { type SearchDirection } from './term-search';
type TermSearchProps = {
    query: string;
    matchCount: number;
    activeIndex: number;
    error?: string | null;
    onQueryChange: (query: string) => void;
    onNavigate: (direction: SearchDirection) => void;
    onClose: () => void;
};
declare const TermSearch: import("svelte").Component<TermSearchProps, {
    focusInput: () => void;
}, "">;
type TermSearch = ReturnType<typeof TermSearch>;
export default TermSearch;

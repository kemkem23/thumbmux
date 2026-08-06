export type SearchMode = 'plain' | 'regex-lite';
export type SearchOptions = {
    mode?: SearchMode;
    caseSensitive?: boolean;
};
export type SearchMatch = {
    line: number;
    start: number;
    end: number;
};
export type SearchErrorCode = 'empty-query' | 'pattern-too-long' | 'unsupported-syntax' | 'malformed-pattern' | 'invalid-bound' | 'result-limit';
export type SearchError = {
    code: SearchErrorCode;
    message: string;
};
export type SearchResult = {
    matches: SearchMatch[];
    error: SearchError | null;
};
export declare function searchLines(rawLines: readonly string[], query: string, options?: SearchOptions): SearchResult;

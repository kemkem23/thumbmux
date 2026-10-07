export interface TerminalLinkSegment {
    lineIdx: number;
    startCol: number;
    endCol: number;
}
export interface TerminalLinkMatch {
    url: string;
    segments: TerminalLinkSegment[];
}
export declare function collectTerminalUrlSegments(rawLines: string[], startLine: number, endLine: number, cols: number): TerminalLinkMatch[];
export declare function findTerminalUrlAtCell(rawLines: string[], lineIdx: number, col: number, cols: number): string | null;

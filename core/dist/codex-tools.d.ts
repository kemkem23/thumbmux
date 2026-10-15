/**
 * Conservative Codex CLI tool/event detector.
 *
 * Codex paints semantic event headers with stable SGR signatures. This module
 * requires those signatures plus a conclusive block seal; matching visible
 * words or indentation alone is never sufficient. Phase one intentionally
 * recognises completed history only. Live, failed, malformed, and ambiguous
 * corridors remain byte-for-byte visible.
 */
import { type ToolCollapseBlock, type ToolLineRange } from './tool-projection';
export type CodexToolScreenMode = 'normal' | 'alternate' | 'unknown';
export type CodexToolDetectionOptions = Readonly<{
    /** Alternate/unknown full-screen modes always fail open. Default: normal. */
    screenMode?: CodexToolScreenMode;
    /** Inspect only this many newest physical rows. Default: 20,000. */
    maxScanLines?: number;
    /** A candidate longer than this remains raw. Default: 2,000. */
    maxBlockLines?: number;
    /** A candidate larger than this remains raw. Default: 8 Mi UTF-16 code units. */
    maxBlockChars?: number;
    /** Retain only this many newest proven blocks. Default: 512. */
    maxBlocks?: number;
    /**
     * Absolute identity of rawLines[0]. Supply the retained archive offset so a
     * block id survives prepend/eviction. Default: 0.
     */
    identityLineOffset?: number;
    /**
     * Treat physical row zero as a known hard boundary. Default false because a
     * retained tmux history segment can start inside a wrapped logical row.
     */
    leadingEdgeSealed?: boolean;
}>;
export type CodexToolDetection = Readonly<{
    provider: 'codex';
    blocks: readonly ToolCollapseBlock[];
    scanRange: ToolLineRange;
    /** False means screen mode made detection intentionally fail open. */
    enabled: boolean;
}>;
/** Detect only sealed, completed Codex tool/event blocks. */
export declare function detectCodexToolBlocks(rawLines: readonly string[], options?: CodexToolDetectionOptions): CodexToolDetection;

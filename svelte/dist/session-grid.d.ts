import type { AnsiPalette } from '@thumbmux/core';
export type GridSessionState = 'working' | 'idle';
export type GridFilterOption = {
    value: string;
    label: string;
};
export type GridOrder = 'input' | 'recent';
export type GridSession = {
    name: string;
    chip?: string;
    color?: string;
    palette?: AnsiPalette;
    /** Generic exact-match filter key; the package knows no agent names. */
    filterValue?: string;
    /** Stable generic group key plus host-localized display label. */
    groupKey?: string;
    groupLabel?: string;
    state?: GridSessionState;
    /** Visible and accessible host-localized label. */
    stateLabel?: string;
    /** Finite Unix epoch milliseconds; also the recent-sort key. */
    lastActivityAt?: number;
    /** Host-localized visible relative/absolute time. */
    lastActivityLabel?: string;
};
export type SessionGridProps = {
    sessions: GridSession[];
    palette: AnsiPalette;
    onOpen: (name: string) => void;
    onNew: () => void;
    newLabel?: string;
    emptyLabel?: string;
    loading?: boolean;
    skeletonCount?: number;
    loadingLabel?: string;
    filterOptions?: readonly GridFilterOption[];
    allFilterLabel?: string;
    searchable?: boolean;
    searchLabel?: string;
    searchPlaceholder?: string;
    groupable?: boolean;
    groupToggleLabel?: string;
    defaultGrouped?: boolean;
    ungroupedLabel?: string;
    order?: GridOrder;
};
export type DisplaySessionName = {
    full: string;
    truncated: boolean;
    head: string;
    tail: string;
};
export type PreparedGridSession = {
    session: GridSession;
    index: number;
    displayName: DisplaySessionName;
    activityDatetime: string | null;
    groupKey: string;
    groupLabel: string;
    finiteActivityAt: number | null;
};
export type GridGroup = {
    key: string;
    label: string;
    newestActivityAt: number | null;
    firstIndex: number;
    items: PreparedGridSession[];
};
export type SessionGridModel = {
    items: PreparedGridSession[];
    groups: GridGroup[];
    grouped: boolean;
};
export type BuildSessionGridModelOptions = {
    filterValue?: string;
    search?: string;
    grouped?: boolean;
    order?: GridOrder;
    ungroupedLabel?: string;
};
export declare function activityDatetime(value: number | undefined): string | null;
export declare function displayStateLabel(session: GridSession): string | null;
export declare function splitSessionName(name: string, options?: {
    maxChars?: number;
    tailChars?: number;
}): DisplaySessionName;
export declare function buildSessionGridModel(sessions: readonly GridSession[], options?: BuildSessionGridModelOptions): SessionGridModel;
export declare function contrastRatio(foreground: string, background: string): number;
export declare function readableColorOn(background: string, foreground: string, minimum?: number): string;
export declare function deriveThumbnailPalette(palette: AnsiPalette): AnsiPalette;

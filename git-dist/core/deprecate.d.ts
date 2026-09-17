/** Warn once per deprecation key for the lifetime of this module instance. */
export declare function warnDeprecated(key: string, details: Readonly<{
    since: `${number}.${number}.${number}`;
    replacement: string;
    removeNoEarlierThan: `${number}.${number}.${number}`;
}>, log?: (message: string) => void): void;
/** Clear process-local warning state. Intended for deterministic tests. */
export declare function resetDeprecationWarnings(): void;

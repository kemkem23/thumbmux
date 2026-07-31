const warnedDeprecations = new Map<string, true>();

/** Warn once per deprecation key for the lifetime of this module instance. */
export function warnDeprecated(
  key: string,
  message: string,
  log: (message: string) => void = (warning) => console.warn(warning),
): void {
  if (warnedDeprecations.has(key)) return;

  warnedDeprecations.set(key, true);
  log(message);
}

/** Clear process-local warning state. Intended for deterministic tests. */
export function resetDeprecationWarnings(): void {
  warnedDeprecations.clear();
}

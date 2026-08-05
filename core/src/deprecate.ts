const warnedDeprecations = new Map<string, true>();
const VERSION_FORMAT = /^\d+\.\d+\.\d+$/;
const SINGLE_LINE_FORMAT = /^[^\r\n]+$/;

type DeprecationVersion = `${number}.${number}.${number}`;

interface DeprecationDetails {
  readonly since: DeprecationVersion;
  readonly replacement: string;
  readonly removeNoEarlierThan: DeprecationVersion;
}

function assertVersion(value: unknown, field: string): asserts value is DeprecationVersion {
  if (typeof value !== 'string' || !VERSION_FORMAT.test(value)) {
    throw new TypeError(`warnDeprecated details.${field} must be an X.Y.Z version`);
  }
}

function assertDeprecationDetails(details: unknown): asserts details is DeprecationDetails {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    throw new TypeError('warnDeprecated details must be an object');
  }

  const candidate = details as Record<string, unknown>;
  assertVersion(candidate.since, 'since');
  if (
    typeof candidate.replacement !== 'string'
    || !SINGLE_LINE_FORMAT.test(candidate.replacement)
  ) {
    throw new TypeError(
      'warnDeprecated details.replacement must be a non-empty single-line string',
    );
  }
  assertVersion(candidate.removeNoEarlierThan, 'removeNoEarlierThan');
}

/** Warn once per deprecation key for the lifetime of this module instance. */
export function warnDeprecated(
  key: string,
  details: Readonly<{
    since: `${number}.${number}.${number}`;
    replacement: string;
    removeNoEarlierThan: `${number}.${number}.${number}`;
  }>,
  log: (message: string) => void = (warning) => console.warn(warning),
): void {
  if (typeof key !== 'string' || !SINGLE_LINE_FORMAT.test(key)) {
    throw new TypeError('warnDeprecated key must be a non-empty single-line string');
  }
  assertDeprecationDetails(details);

  if (warnedDeprecations.has(key)) return;

  // Record the key only after a successful log. A throwing logger must not
  // permanently suppress the migration warning for the module lifetime.
  log(
    `[thumbmux] ${key} is deprecated since v${details.since} — use ${details.replacement}; removal no earlier than v${details.removeNoEarlierThan}`,
  );
  warnedDeprecations.set(key, true);
}

/** Clear process-local warning state. Intended for deterministic tests. */
export function resetDeprecationWarnings(): void {
  warnedDeprecations.clear();
}

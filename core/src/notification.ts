export type AgentNotificationState = "finished" | "waiting";

export type AgentNotificationEvent = {
  id: string;
  session: string;
  state: AgentNotificationState;
  occurredAt: number;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
};

export interface AgentNotificationNormalizeOptions {
  origin?: string;
}

export const AGENT_NOTIFICATION_LIMITS = Object.freeze({
  id: 128,
  session: 256,
  state: Object.freeze(["finished", "waiting"] as const),
  title: 160,
  body: 4_096,
  tag: 128,
  url: 2_048,
  occurredAtMin: 0,
  occurredAtMax: 8_640_000_000_000_000,
});

export type AgentNotificationValidationErrorCode =
  | "invalid_record"
  | "unknown_field"
  | "invalid_field_accessor"
  | "missing_required_field"
  | "invalid_type"
  | "invalid_state"
  | "invalid_length"
  | "invalid_timestamp"
  | "invalid_url";

export class AgentNotificationValidationError extends Error {
  public readonly field: string;
  public readonly code: AgentNotificationValidationErrorCode;

  constructor(field: string, code: AgentNotificationValidationErrorCode, message: string) {
    super(message);
    this.name = "AgentNotificationValidationError";
    this.field = field;
    this.code = code;
    Object.setPrototypeOf(this, AgentNotificationValidationError.prototype);
  }
}

const ALLOWED_FIELDS = new Set([
  "id",
  "session",
  "state",
  "occurredAt",
  "title",
  "body",
  "url",
  "tag",
]);

function isOrdinaryObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) {
    count += 1;
  }
  return count;
}

function trimNormalize(value: string): string {
  return value.normalize("NFC").trim();
}

function requireOwnEnumerableDataFields(value: Record<string, unknown>): void {
  const ownKeys = Reflect.ownKeys(value);

  if (ownKeys.length !== Object.keys(value).length) {
    throw new AgentNotificationValidationError(
      "__root__",
      "invalid_record",
      "All fields must be own enumerable string data fields",
    );
  }

  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new AgentNotificationValidationError(
        "__root__",
        "unknown_field",
        "Only own enumerable string fields are allowed",
      );
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw new AgentNotificationValidationError(
        key,
        "unknown_field",
        `Unknown field ${key}`,
      );
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new AgentNotificationValidationError(
        key,
        "invalid_field_accessor",
        `Field ${key} must be an own enumerable data field`,
      );
    }
  }
}

function validateRequiredFields(value: Record<string, unknown>): void {
  for (const field of ["id", "session", "state", "occurredAt"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new AgentNotificationValidationError(
        field,
        "missing_required_field",
        `Missing required field ${field}`,
      );
    }
  }
}

function normalizeStringField(
  value: unknown,
  field: "id" | "session" | "title" | "body" | "tag",
  maxCodePoints: number,
  required: true,
): string;
function normalizeStringField(
  value: unknown,
  field: "id" | "session" | "title" | "body" | "tag",
  maxCodePoints: number,
  required: false,
): string | undefined;
function normalizeStringField(
  value: unknown,
  field: "id" | "session" | "title" | "body" | "tag",
  maxCodePoints: number,
  required: boolean,
): string | undefined {
  if (typeof value !== "string") {
    throw new AgentNotificationValidationError(
      field,
      "invalid_type",
      `Field ${field} must be a string`,
    );
  }

  const normalized = trimNormalize(value);
  if (normalized === "") {
    if (required) {
      throw new AgentNotificationValidationError(
        field,
        "invalid_length",
        `Field ${field} must not be empty`,
      );
    }
    return undefined;
  }

  if (countCodePoints(normalized) > maxCodePoints) {
    throw new AgentNotificationValidationError(
      field,
      "invalid_length",
      `Field ${field} exceeds ${maxCodePoints} code points`,
    );
  }

  return normalized;
}

function normalizeOptionalStringField(
  value: Record<string, unknown>,
  field: "title" | "body" | "tag",
  maxCodePoints: number,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, field)) return undefined;
  return normalizeStringField(value[field], field, maxCodePoints, false);
}

function parseEventState(value: unknown): AgentNotificationState {
  if (value === "finished" || value === "waiting") {
    return value;
  }
  throw new AgentNotificationValidationError(
    "state",
    "invalid_state",
    'state must be "finished" or "waiting"',
  );
}

function parseOccurredAt(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || !Number.isSafeInteger(value)
    || value < AGENT_NOTIFICATION_LIMITS.occurredAtMin
    || value > AGENT_NOTIFICATION_LIMITS.occurredAtMax
  ) {
    throw new AgentNotificationValidationError(
      "occurredAt",
      "invalid_timestamp",
      "occurredAt must be a safe integer in [0, 8640000000000000]",
    );
  }
  return value;
}

function parseHttpOrigin(origin: unknown): URL | null {
  if (typeof origin !== "string") return null;
  const normalizedOrigin = trimNormalize(origin);
  let parsed: URL;
  try {
    parsed = new URL(normalizedOrigin);
  } catch {
    return null;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== "") {
    return null;
  }

  return parsed;
}

function sameOriginNotificationUrlFromOrigin(candidate: unknown, origin: unknown): string | null {
  if (typeof candidate !== "string" || typeof origin !== "string" || !candidate) return null;

  const normalizedOrigin = trimNormalize(origin);
  const trusted = parseHttpOrigin(normalizedOrigin);
  if (!trusted) return null;

  const normalizedCandidate = trimNormalize(candidate);
  if (normalizedCandidate === "") return null;
  if (normalizedCandidate.startsWith("//")) return null;
  if (countCodePoints(normalizedCandidate) > AGENT_NOTIFICATION_LIMITS.url) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalizedCandidate, trusted);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.origin !== trusted.origin) return null;

  const canonical = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  // Pathnames that start with a second slash become protocol-relative URLs when
  // fed to openWindow/location.href (//evil.test → https://evil.test). Reject.
  if (canonical.startsWith("//")) return null;
  return canonical;
}

export function sameOriginNotificationUrl(
  candidate: string,
  origin: string,
): string | null {
  return sameOriginNotificationUrlFromOrigin(candidate, origin);
}

function normalizeUrl(value: unknown, options: AgentNotificationNormalizeOptions): string | undefined {
  if (typeof value !== "string") {
    throw new AgentNotificationValidationError(
      "url",
      "invalid_type",
      "url must be a string",
    );
  }

  const normalized = trimNormalize(value);
  if (normalized === "") return undefined;

  if (countCodePoints(normalized) > AGENT_NOTIFICATION_LIMITS.url) {
    throw new AgentNotificationValidationError(
      "url",
      "invalid_length",
      `url exceeds ${AGENT_NOTIFICATION_LIMITS.url} code points`,
    );
  }

  if (typeof options.origin !== "string" || options.origin.trim() === "") {
    throw new AgentNotificationValidationError(
      "url",
      "invalid_url",
      "url is present but options.origin is missing",
    );
  }

  const canonical = sameOriginNotificationUrlFromOrigin(normalized, options.origin);
  if (canonical === null) {
    throw new AgentNotificationValidationError(
      "url",
      "invalid_url",
      "url is not a safe same-origin HTTP(S) URL",
    );
  }

  if (countCodePoints(canonical) > AGENT_NOTIFICATION_LIMITS.url) {
    throw new AgentNotificationValidationError(
      "url",
      "invalid_length",
      `url exceeds ${AGENT_NOTIFICATION_LIMITS.url} code points`,
    );
  }

  return canonical;
}

function normalizeNotificationEvent(value: unknown, options: AgentNotificationNormalizeOptions = {}): AgentNotificationEvent {
  if (!isOrdinaryObject(value)) {
    throw new AgentNotificationValidationError(
      "__root__",
      "invalid_record",
      "Notification input must be a plain object",
    );
  }

  requireOwnEnumerableDataFields(value);
  validateRequiredFields(value);

  const normalized: AgentNotificationEvent = {
    id: normalizeStringField(value.id, "id", AGENT_NOTIFICATION_LIMITS.id, true),
    session: normalizeStringField(value.session, "session", AGENT_NOTIFICATION_LIMITS.session, true),
    state: parseEventState(value.state),
    occurredAt: parseOccurredAt(value.occurredAt),
  };

  const title = normalizeOptionalStringField(value, "title", AGENT_NOTIFICATION_LIMITS.title);
  if (title !== undefined) normalized.title = title;

  const body = normalizeOptionalStringField(value, "body", AGENT_NOTIFICATION_LIMITS.body);
  if (body !== undefined) normalized.body = body;

  const tag = normalizeOptionalStringField(value, "tag", AGENT_NOTIFICATION_LIMITS.tag);
  if (tag !== undefined) normalized.tag = tag;

  const url = Object.prototype.hasOwnProperty.call(value, "url")
    ? normalizeUrl(value.url, options)
    : undefined;
  if (url !== undefined) normalized.url = url;

  return normalized;
}

export function normalizeAgentNotificationEvent(
  value: unknown,
  options: AgentNotificationNormalizeOptions = {},
): AgentNotificationEvent {
  return normalizeNotificationEvent(value, options);
}

export function validateAgentNotificationEvent(
  value: unknown,
  options: AgentNotificationNormalizeOptions = {},
): AgentNotificationEvent {
  return normalizeNotificationEvent(value, options);
}

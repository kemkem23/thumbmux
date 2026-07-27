import { describe, expect, test } from "bun:test";
import {
  AGENT_NOTIFICATION_LIMITS,
  AgentNotificationValidationError,
  normalizeAgentNotificationEvent,
  sameOriginNotificationUrl,
  type AgentNotificationEvent,
  validateAgentNotificationEvent,
  type AgentNotificationValidationErrorCode,
} from "../src/notification";

const DEFAULT_ORIGIN = "https://example.test";

const repeatCodePoints = (value: string, count: number): string => {
  return Array.from({ length: count }, () => value).join("");
};

const makeEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "evt-001",
  session: "session-001",
  state: "finished",
  occurredAt: 1_700_000_000_000,
  ...overrides,
});

const expectValidationError = (
  run: () => unknown,
  field: string,
  code: AgentNotificationValidationErrorCode,
) => {
  let error: unknown;
  try {
    run();
  } catch (e) {
    error = e;
  }

  expect(error).toBeDefined();
  expect(error).toBeInstanceOf(AgentNotificationValidationError);
  if (error instanceof AgentNotificationValidationError) {
    expect(error.field).toBe(field);
    expect(error.code).toBe(code);
  }
};

describe("AgentNotificationEvent normalization", () => {
  test("normalizes required event fields", () => {
    const normalized = normalizeAgentNotificationEvent(makeEvent());

    expect(normalized.id).toBe("evt-001");
    expect(normalized.session).toBe("session-001");
    expect(normalized.state).toBe("finished");
    expect(normalized.occurredAt).toBe(1_700_000_000_000);
    expect(normalized.title).toBeUndefined();
    expect(normalized.body).toBeUndefined();
    expect(normalized.tag).toBeUndefined();
    expect(normalized.url).toBeUndefined();
    expect(validateAgentNotificationEvent(makeEvent())).toEqual(normalized);
  });

  test("accepts both exact states", () => {
    expect(normalizeAgentNotificationEvent(makeEvent({ state: "finished" })).state).toBe("finished");
    expect(normalizeAgentNotificationEvent(makeEvent({ state: "waiting" })).state).toBe("waiting");
  });

  test("accepts optional title/body/url/tag when valid", () => {
    const normalized = normalizeAgentNotificationEvent(
      makeEvent({
        title: "  Title  ",
        body: "  Body  ",
        tag: "  tag  ",
        url: "/inbox?x=1#frag",
      }),
      { origin: DEFAULT_ORIGIN },
    );

    expect(normalized.title).toBe("Title");
    expect(normalized.body).toBe("Body");
    expect(normalized.tag).toBe("tag");
    expect(normalized.url).toBe("/inbox?x=1#frag");
  });

  test("normalizes composed vs decomposed unicode and trims", () => {
    const decomposed = {
      id: " \u0065\u0301 ",
      session: "\u0065\u0301",
      state: "finished",
      occurredAt: 0,
      title: "  \u0065\u0301 ",
      body: "\u0065\u0301",
      tag: " \u0065\u0301 ",
    };
    const composed = {
      id: "é",
      session: "  \u00e9 ",
      state: "finished",
      occurredAt: 0,
      title: "\u00e9",
      body: " \u00e9 ",
      tag: "\u00e9",
    };

    const a = normalizeAgentNotificationEvent(decomposed);
    const b = normalizeAgentNotificationEvent(composed);

    expect(a).toEqual(b);
    expect(a.id).toBe("é");
    expect(a.session).toBe("é");
    expect(a.body).toBe("é");
    expect(a.tag).toBe("é");
  });

  test("deterministic/idempotent duplicate-neutral normalization", () => {
    const payload = makeEvent({
      id: "  evt-dup ",
      session: "  session-dup ",
      title: "  dup title ",
      body: "  ",
      tag: "  maybe  ",
      url: "/status?x=1#y",
    });
    const first = normalizeAgentNotificationEvent(payload, { origin: DEFAULT_ORIGIN });
    const second = normalizeAgentNotificationEvent(first, { origin: DEFAULT_ORIGIN });

    expect(first.id).toBe(second.id);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  test("omits optional empty normalized values", () => {
    const normalized = normalizeAgentNotificationEvent(
      makeEvent({
        title: "   ",
        body: "\t\n",
        tag: "",
        url: "  ",
      }),
      { origin: DEFAULT_ORIGIN },
    );

    const expected: AgentNotificationEvent = {
      id: "evt-001",
      session: "session-001",
      state: "finished",
      occurredAt: 1_700_000_000_000,
    };
    expect(normalized).toEqual(expected);
    expect(normalized.title).toBeUndefined();
    expect(normalized.body).toBeUndefined();
    expect(normalized.tag).toBeUndefined();
    expect(normalized.url).toBeUndefined();
  });

  test("rejects non-string optional text fields", () => {
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ title: 123 })),
      "title",
      "invalid_type",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ body: {} })),
      "body",
      "invalid_type",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ tag: false })),
      "tag",
      "invalid_type",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: 17 }), { origin: DEFAULT_ORIGIN }),
      "url",
      "invalid_type",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: undefined }), { origin: DEFAULT_ORIGIN }),
      "url",
      "invalid_type",
    );
  });

  test("rejects bad required id and session fields", () => {
    expectValidationError(
      () => normalizeAgentNotificationEvent({ session: "session", state: "finished", occurredAt: 0 }),
      "id",
      "missing_required_field",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ id: 123 })),
      "id",
      "invalid_type",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ id: "   " })),
      "id",
      "invalid_length",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ session: 999 })),
      "session",
      "invalid_type",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ session: "   " })),
      "session",
      "invalid_length",
    );
  });

  test("rejects unknown top-level fields", () => {
    expectValidationError(
      () => normalizeAgentNotificationEvent({ ...makeEvent(), extras: "nope" }),
      "extras",
      "unknown_field",
    );
  });

  test("rejects malformed records and malformed property accessors", () => {
    expectValidationError(
      () => normalizeAgentNotificationEvent(null),
      "__root__",
      "invalid_record",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent([]),
      "__root__",
      "invalid_record",
    );
    expectValidationError(
      () =>
        normalizeAgentNotificationEvent(Object.create({ session: "session-001", state: "finished", occurredAt: 0 })),
      "__root__",
      "invalid_record",
    );

    const accessorRecord = makeEvent();
    Object.defineProperty(accessorRecord, "title", {
      configurable: true,
      enumerable: true,
      get() {
        return "title";
      },
    });
    expectValidationError(
      () => normalizeAgentNotificationEvent(accessorRecord),
      "title",
      "invalid_field_accessor",
    );
  });

  test("rejects invalid state value", () => {
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ state: "waiting..." })),
      "state",
      "invalid_state",
    );
  });

  test("rejects NaN/fractional/out-of-range timestamps", () => {
    expect(
      normalizeAgentNotificationEvent(
        makeEvent({ occurredAt: AGENT_NOTIFICATION_LIMITS.occurredAtMax }),
      ).occurredAt,
    ).toBe(AGENT_NOTIFICATION_LIMITS.occurredAtMax);
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ occurredAt: Number.NaN })),
      "occurredAt",
      "invalid_timestamp",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ occurredAt: 1.5 })),
      "occurredAt",
      "invalid_timestamp",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ occurredAt: AGENT_NOTIFICATION_LIMITS.occurredAtMax + 1 })),
      "occurredAt",
      "invalid_timestamp",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ occurredAt: -1 })),
      "occurredAt",
      "invalid_timestamp",
    );
  });

  test("enforces all bounded string field code-point limits", () => {
    const bounded: Array<{ field: "id" | "session" | "title" | "body" | "tag"; limit: number }> = [
      { field: "id", limit: AGENT_NOTIFICATION_LIMITS.id },
      { field: "session", limit: AGENT_NOTIFICATION_LIMITS.session },
      { field: "title", limit: AGENT_NOTIFICATION_LIMITS.title },
      { field: "body", limit: AGENT_NOTIFICATION_LIMITS.body },
      { field: "tag", limit: AGENT_NOTIFICATION_LIMITS.tag },
    ];

    for (const { field, limit } of bounded) {
      const atLimit = repeatCodePoints("😀", limit);
      const overLimit = repeatCodePoints("😀", limit + 1);

      const normalized = normalizeAgentNotificationEvent(
        { ...makeEvent(), [field]: atLimit } as Record<string, unknown>,
      );
      expect((normalized as Record<string, unknown>)[field]).toBe(atLimit.normalize("NFC"));
      expectValidationError(
        () => normalizeAgentNotificationEvent({ ...makeEvent(), [field]: overLimit } as Record<string, unknown>),
        field,
        "invalid_length",
      );
    }
  });

  test("enforces URL code-point limit and canonical path size", () => {
    const atLimit = `/${"a".repeat(AGENT_NOTIFICATION_LIMITS.url - 1)}`;
    const overLimit = `/${"a".repeat(AGENT_NOTIFICATION_LIMITS.url)}`;

    const normalized = normalizeAgentNotificationEvent(
      makeEvent({ url: atLimit }),
      { origin: DEFAULT_ORIGIN },
    );
    expect(normalized.url).toBe(atLimit);

    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: overLimit }), { origin: DEFAULT_ORIGIN }),
      "url",
      "invalid_length",
    );
  });
});

describe("notification URL same-origin helpers", () => {
  test("accepts relative and same-origin absolute URLs and returns path/search/hash", () => {
    expect(sameOriginNotificationUrl("/inbox?x=1#section", DEFAULT_ORIGIN)).toBe("/inbox?x=1#section");
    expect(
      sameOriginNotificationUrl("https://example.test/dashboard?x=2#top", DEFAULT_ORIGIN),
    ).toBe("/dashboard?x=2#top");
  });

  test("rejects external origin and protocol-relative URLs", () => {
    expect(sameOriginNotificationUrl("https://other.test/path", DEFAULT_ORIGIN)).toBeNull();
    expect(sameOriginNotificationUrl("//example.test/path", DEFAULT_ORIGIN)).toBeNull();
  });

  test("rejects disallowed protocols and credentials", () => {
    expect(sameOriginNotificationUrl("javascript:alert(1)", DEFAULT_ORIGIN)).toBeNull();
    expect(sameOriginNotificationUrl("data:text/plain,hello", DEFAULT_ORIGIN)).toBeNull();
    expect(sameOriginNotificationUrl("mailto:a@b.test", DEFAULT_ORIGIN)).toBeNull();
    expect(sameOriginNotificationUrl("https://user:pass@example.test/path", DEFAULT_ORIGIN)).toBeNull();
  });

  test("rejects malformed URLs and malformed origin values", () => {
    expect(sameOriginNotificationUrl("https://[::1", DEFAULT_ORIGIN)).toBeNull();
    expect(sameOriginNotificationUrl("/ok", "notaurl")).toBeNull();
    expect(sameOriginNotificationUrl("/ok", "ftp://example.test")).toBeNull();
  });

  test("normalizes and validates event URLs only with an origin", () => {
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: "/ok" })),
      "url",
      "invalid_url",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: "javascript:alert(1)" }), { origin: DEFAULT_ORIGIN }),
      "url",
      "invalid_url",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: "//example.test/ok" }), { origin: DEFAULT_ORIGIN }),
      "url",
      "invalid_url",
    );
    expectValidationError(
      () => normalizeAgentNotificationEvent(makeEvent({ url: "http://example.test/ok" })),
      "url",
      "invalid_url",
    );
  });
});

describe("canonical notification URLs never escape the origin", () => {
  test("rejects absolute same-origin URLs whose canonical form is protocol-relative", () => {
    expect(sameOriginNotificationUrl("https://example.test//evil.test/x", DEFAULT_ORIGIN)).toBeNull();
    expect(sameOriginNotificationUrl("https://example.test/\\evil.test", DEFAULT_ORIGIN)).toBeNull();
  });

  test("returned URLs are origin-locked when resolved against an unrelated base", () => {
    const candidates = [
      "/inbox?x=1#f",
      "https://example.test/ok",
      "https://example.test//evil.test/x",
      "https://example.test/\\evil.test",
      "//example.test/path",
      "https://other.test/path",
      "https://example.test/a//b",
    ];

    for (const candidate of candidates) {
      const result = sameOriginNotificationUrl(candidate, DEFAULT_ORIGIN);
      if (result === null) continue;
      expect(result.startsWith("//")).toBe(false);
      expect(new URL(result, "https://unrelated.test").origin).toBe("https://unrelated.test");
    }
  });

  test("normalize rejects absolute URLs that canonicalize to protocol-relative paths", () => {
    expectValidationError(
      () =>
        normalizeAgentNotificationEvent(makeEvent({ url: "https://example.test//evil.test/x" }), {
          origin: DEFAULT_ORIGIN,
        }),
      "url",
      "invalid_url",
    );
  });

  test("accepts legitimate interior double slash paths", () => {
    expect(
      normalizeAgentNotificationEvent(makeEvent({ url: "/a//b?q=1#h" }), { origin: DEFAULT_ORIGIN }).url,
    ).toBe("/a//b?q=1#h");
    expect(sameOriginNotificationUrl("https://example.test/a//b", DEFAULT_ORIGIN)).toBe("/a//b");
  });
});

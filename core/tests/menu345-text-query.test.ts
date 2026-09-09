import { describe, expect, test } from "bun:test";
import { matchesTextQuery, type TextQueryOptions } from "../src/text-query";

// A23 — the host had two hand-rolled copies of "lowercase + includes":
//   SkillsPanel.svelte:214-219  trims the query, highlights/dims, never cuts the list
//   ManageDropdown.svelte:68-69 does not trim, filters four inventory groups
// Both must keep behaving exactly as they did. Nothing here may reach for a
// RegExp or a locale/Unicode normalizer: the old code had neither.

describe("matchesTextQuery — lowercase + includes, both directions", () => {
  test("an uppercase haystack is found by a lowercase query", () => {
    expect(matchesTextQuery("Cortex Orchestrator", "orchestrator")).toBe(true);
  });

  test("a lowercase haystack is found by an uppercase query", () => {
    expect(matchesTextQuery("cortex orchestrator", "ORCHESTRATOR")).toBe(true);
  });

  test("a substring that is simply absent does not match", () => {
    expect(matchesTextQuery("cortex orchestrator", "thumbmux")).toBe(false);
  });

  test("the match is a substring, not a prefix or a word boundary", () => {
    expect(matchesTextQuery("skill-library", "ill-lib")).toBe(true);
  });

  test("Thai text matches as a plain substring", () => {
    expect(matchesTextQuery("ตัวจับข้อความ", "จับข้อ")).toBe(true);
    expect(matchesTextQuery("ตัวจับข้อความ", "ข้อคิด")).toBe(false);
  });
});

describe("matchesTextQuery — the empty query", () => {
  // MANAGE's `if (!searchFilter) return true` is exactly String.includes(''),
  // so an empty query must keep every row of all four groups visible.
  test("an empty query matches anything", () => {
    expect(matchesTextQuery("kem-cortex-orchestrator", "")).toBe(true);
  });

  test("an empty query matches even an empty haystack", () => {
    expect(matchesTextQuery("", "")).toBe(true);
  });

  test("a non-empty query never matches an empty haystack", () => {
    expect(matchesTextQuery("", "a")).toBe(false);
  });

  test("a whitespace query with trimQuery still matches anything", () => {
    // SKILLS guards on its own trimmed term before highlighting; the matcher
    // itself stays honest to includes() and reports a match.
    expect(matchesTextQuery("kem-cortex", "   ", { trimQuery: true })).toBe(true);
  });
});

describe("matchesTextQuery — trimQuery", () => {
  test("defaults to false: surrounding spaces stay part of the query", () => {
    expect(matchesTextQuery("manage", " manage")).toBe(false);
  });

  test("an empty options object behaves like the default, not like trim", () => {
    expect(matchesTextQuery("manage", " manage", {})).toBe(false);
  });

  test("trimQuery: false is still untrimmed", () => {
    expect(matchesTextQuery("manage", " manage", { trimQuery: false })).toBe(false);
  });

  test("untrimmed, a leading space matches only where that space really is", () => {
    expect(matchesTextQuery("topic manage", " manage")).toBe(true);
  });

  test("trimQuery: true drops leading and trailing whitespace from the query", () => {
    expect(matchesTextQuery("manage", "  manage  ", { trimQuery: true })).toBe(true);
  });

  test("trimQuery: true drops tabs and newlines too", () => {
    expect(matchesTextQuery("manage", "\t\nmanage\n", { trimQuery: true })).toBe(true);
  });

  test("trimQuery: true does not touch whitespace inside the query", () => {
    expect(matchesTextQuery("skilllibrary", "skill library", { trimQuery: true })).toBe(false);
    expect(matchesTextQuery("skill library", "skill library", { trimQuery: true })).toBe(true);
  });

  test("the haystack is never trimmed, on either setting", () => {
    // The padding lives in the text, so a padded query must still find it.
    // Trimming the text would leave "padded", which contains neither query.
    expect(matchesTextQuery("  padded  ", " padded ")).toBe(true);
    expect(matchesTextQuery("padded  ", "padded ", { trimQuery: false })).toBe(true);
  });
});

describe("matchesTextQuery — no regex, no normalization", () => {
  test("a dot is a literal dot, not 'any character'", () => {
    expect(matchesTextQuery("abc", "a.c")).toBe(false);
    expect(matchesTextQuery("a.c", "a.c")).toBe(true);
  });

  test("regex metacharacters are literals and never throw", () => {
    for (const meta of ["*", "+", "?", "(", ")", "[", "]", "{", "}", "^", "$", "|", "\\"]) {
      expect(matchesTextQuery(`skill${meta}name`, meta)).toBe(true);
      expect(matchesTextQuery("skillname", meta)).toBe(false);
    }
  });

  test("an unbalanced bracket is a query, not a syntax error", () => {
    expect(matchesTextQuery("v[0.19.0", "[0.19")).toBe(true);
  });

  test("a decomposed accent does not match a precomposed one", () => {
    // Proof that no NFC/NFD normalization was added: these are different strings.
    const precomposed = "caf\u00E9";
    const decomposed = "cafe\u0301";
    expect(precomposed).not.toBe(decomposed);
    expect(matchesTextQuery(precomposed, decomposed)).toBe(false);
    expect(matchesTextQuery(precomposed, precomposed)).toBe(true);
  });

  test("case folding is plain toLowerCase, not locale-aware", () => {
    // toLocaleLowerCase('tr') would turn 'I' into 'ı' and break this.
    expect(matchesTextQuery("IZMIR", "izmir")).toBe(true);
  });
});

describe("A23 — the SKILLS shape: trim the query, highlight and dim, cut nothing", () => {
  type Chip = { name: string; badge: string; warn: string | null };

  const chips: Chip[] = [
    { name: "tokencheck", badge: "CC", warn: null },
    { name: "exec", badge: "CC+CODEX", warn: null },
    { name: "miro-board-layout", badge: "CC", warn: "INVALID RUNTIMES" },
  ];

  // Mirrors SkillsPanel.svelte:214-219 with the matcher swapped in.
  function render(filter: string) {
    const term = filter.trim().toLowerCase();
    return chips.map((chip) => {
      const haystack = `${chip.name} ${chip.badge} ${chip.warn ?? ""}`;
      const matches = term !== "" && matchesTextQuery(haystack, filter, { trimQuery: true });
      return { name: chip.name, matches, dimmed: term !== "" && !matches };
    });
  }

  test("a padded query still highlights, because SKILLS trims", () => {
    const rows = render("  exec  ");
    expect(rows.find((r) => r.name === "exec")?.matches).toBe(true);
  });

  test("the list is never cut — non-matches are dimmed, not removed", () => {
    const rows = render("exec");
    expect(rows).toHaveLength(chips.length);
    expect(rows.filter((r) => r.dimmed).map((r) => r.name)).toEqual([
      "tokencheck",
      "miro-board-layout",
    ]);
  });

  test("the badge and the warning are part of the searchable text", () => {
    expect(render("codex").find((r) => r.name === "exec")?.matches).toBe(true);
    expect(render("invalid").find((r) => r.name === "miro-board-layout")?.matches).toBe(true);
  });

  test("an empty or whitespace-only filter highlights nothing and dims nothing", () => {
    for (const filter of ["", "   "]) {
      const rows = render(filter);
      expect(rows).toHaveLength(chips.length);
      expect(rows.some((r) => r.matches)).toBe(false);
      expect(rows.some((r) => r.dimmed)).toBe(false);
    }
  });
});

describe("A23 — the MANAGE shape: no trim, four groups filtered", () => {
  const inventory = {
    shown: ["kem-cortex-orchestrator", "skill-library"],
    onDisk: ["cortex-archive"],
    onGitHub: ["thumbmux"],
    hidden: ["old-cortex-spike"],
  };

  // Mirrors ManageDropdown.svelte:68-75 with the matcher swapped in.
  function filterAll(search: string) {
    const keep = (name: string) => matchesTextQuery(name, search);
    return {
      shown: inventory.shown.filter(keep),
      onDisk: inventory.onDisk.filter(keep),
      onGitHub: inventory.onGitHub.filter(keep),
      hidden: inventory.hidden.filter(keep),
    };
  }

  const total = (r: ReturnType<typeof filterAll>) =>
    r.shown.length + r.onDisk.length + r.onGitHub.length + r.hidden.length;

  test("an empty search keeps every row of all four groups", () => {
    expect(total(filterAll(""))).toBe(5);
  });

  test("a search reaches into every group, not just the first", () => {
    const r = filterAll("cortex");
    expect(r.shown).toEqual(["kem-cortex-orchestrator"]);
    expect(r.onDisk).toEqual(["cortex-archive"]);
    expect(r.onGitHub).toEqual([]);
    expect(r.hidden).toEqual(["old-cortex-spike"]);
  });

  test("no visible results is reachable, and that is the empty-state signal", () => {
    expect(total(filterAll("nothing-here"))).toBe(0);
  });

  test("MANAGE does not trim: a padded search finds nothing here", () => {
    expect(total(filterAll(" cortex"))).toBe(0);
    expect(total(filterAll("cortex "))).toBe(0);
  });
});

describe("TextQueryOptions — the reserved option surface", () => {
  test("the type accepts trimQuery and nothing is required", () => {
    const empty: TextQueryOptions = {};
    const on: TextQueryOptions = { trimQuery: true };
    expect(matchesTextQuery("manage", " manage", empty)).toBe(false);
    expect(matchesTextQuery("manage", " manage", on)).toBe(true);
  });
});

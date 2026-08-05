import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, tick, unmount } from "./svelte-client";

import NotePanel from "../src/NotePanel.svelte";

type NotePanelProps = {
  note?: string;
  placeholder?: string;
  editable?: boolean;
  saving?: boolean;
  onSave?: (text: string) => void;
  actions?: { label: string; onTap: () => void; busy?: boolean }[];
  labels?: { edit: string; save: string; cancel: string };
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
};

const mounted: Mounted[] = [];

function mountNotePanel(props: NotePanelProps = {}): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  let app!: Record<string, unknown>;
  try {
    flushSync(() => {
      app = mount(NotePanel, { target, props }) as Record<string, unknown>;
    });
  } catch (error) {
    target.remove();
    throw error;
  }

  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
});

describe("NotePanel", () => {
  test("mounts as a real Svelte component", async () => {
    let result: Mounted | undefined;

    expect(() => {
      result = mountNotePanel();
    }).not.toThrow();
    await tick();

    expect(result?.target.querySelectorAll('[data-testid="note-panel"]')).toHaveLength(1);
  });

  test("renders the complete multiline note, including newlines", async () => {
    const note = "first line\nบรรทัดที่สอง\nthird line";
    const { target } = mountNotePanel({ note });
    await tick();

    const rendered = target.querySelector('[data-testid="note-text"]')?.textContent ?? "";
    expect(rendered).toBe(note);
    expect(rendered.split("\n")).toHaveLength(3);
  });

  test("prefills the draft with the saved note when editing starts", async () => {
    const note = "saved first line\nsaved second line";
    // A6-15: edit UI only appears when onSave is wired
    const { target } = mountNotePanel({ note, onSave: () => {} });

    const edit = target.querySelector<HTMLButtonElement>('[data-testid="note-edit"]');
    if (!edit) throw new Error("NotePanel did not render its edit button");
    flushSync(() => edit.click());
    await tick();

    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="note-draft"]');
    if (!draft) throw new Error("NotePanel did not render its draft textarea");
    expect(draft.value).toBe(note);
  });

  test("sends the value entered in the DOM exactly once when saved", async () => {
    const saved: string[] = [];
    const { target } = mountNotePanel({
      note: "original note",
      onSave: (text) => saved.push(text),
    });

    const edit = target.querySelector<HTMLButtonElement>('[data-testid="note-edit"]');
    if (!edit) throw new Error("NotePanel did not render its edit button");
    flushSync(() => edit.click());
    await tick();

    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="note-draft"]');
    if (!draft) throw new Error("NotePanel did not render its draft textarea");
    flushSync(() => {
      draft.value = "edited first line\nedited second line";
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();

    const valueEnteredInDom = draft.value;
    const save = target.querySelector<HTMLButtonElement>('[data-testid="note-save"]');
    if (!save) throw new Error("NotePanel did not render its save button");
    flushSync(() => save.click());
    await tick();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(valueEnteredInDom);
  });

  test("trims surrounding whitespace before saving", async () => {
    const saved: string[] = [];
    const { target } = mountNotePanel({
      note: "original note",
      onSave: (text) => saved.push(text),
    });

    const edit = target.querySelector<HTMLButtonElement>('[data-testid="note-edit"]');
    if (!edit) throw new Error("NotePanel did not render its edit button");
    flushSync(() => edit.click());
    await tick();

    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="note-draft"]');
    if (!draft) throw new Error("NotePanel did not render its draft textarea");
    flushSync(() => {
      draft.value = "  padded  ";
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();

    const save = target.querySelector<HTMLButtonElement>('[data-testid="note-save"]');
    if (!save) throw new Error("NotePanel did not render its save button");
    flushSync(() => save.click());
    await tick();

    expect(saved).toEqual(["padded"]);
  });

  test("mounts safely for empty and undefined notes", async () => {
    const cases: NotePanelProps[] = [{ note: "" }, { note: undefined }];

    for (const props of cases) {
      const { target } = mountNotePanel(props);
      await tick();

      expect(target.querySelectorAll('[data-testid="note-panel"]')).toHaveLength(1);
      const text = target.querySelector<HTMLElement>('[data-testid="note-text"]');
      expect(text?.textContent).toBe("no note yet");
      expect(text?.classList.contains("empty")).toBe(true);
    }
  });
});

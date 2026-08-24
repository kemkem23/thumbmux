import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  copyServerRuntimeAssets,
  TERMINAL_PTY_WAL_PROXY_ASSET,
} from "../scripts/copy-runtime-assets";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(contents = "#!/usr/bin/env python3\nprint('proxy fixture')\n", mode = 0o755): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-runtime-assets-"));
  roots.push(root);
  const sourceDirectory = join(root, "src", "integrations");
  mkdirSync(sourceDirectory, { recursive: true });
  const source = join(sourceDirectory, TERMINAL_PTY_WAL_PROXY_ASSET);
  writeFileSync(source, contents, { mode });
  chmodSync(source, mode);
  return root;
}

describe("server runtime asset build", () => {
  test("copies the exact Python helper beside the bundled server entrypoint", () => {
    const root = fixture();
    const target = copyServerRuntimeAssets(root);

    expect(target).toBe(join(root, "dist", TERMINAL_PTY_WAL_PROXY_ASSET));
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target)).toEqual(
      readFileSync(join(root, "src", "integrations", TERMINAL_PTY_WAL_PROXY_ASSET)),
    );
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  test("fails closed when the source helper is empty, malformed, or not executable", () => {
    expect(() => copyServerRuntimeAssets(fixture("", 0o755))).toThrow("is empty");
    expect(() => copyServerRuntimeAssets(fixture("print('missing shebang')\n", 0o755)))
      .toThrow("expected Python 3 shebang");
    expect(() => copyServerRuntimeAssets(fixture(undefined, 0o644)))
      .toThrow("not executable by every runtime user");
  });
});

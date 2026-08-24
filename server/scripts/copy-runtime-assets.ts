import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";

export const TERMINAL_PTY_WAL_PROXY_ASSET = "terminal-pty-wal-proxy.py";

const DEFAULT_SERVER_ROOT = resolve(import.meta.dir, "..");
const PYTHON_SHEBANG = "#!/usr/bin/env python3\n";
const PUBLISHED_MODE = 0o755;

function assertRuntimeAsset(path: string, label: string, requireExecutable: boolean): Buffer {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (metadata.size === 0) throw new Error(`${label} is empty: ${path}`);
  if ((metadata.mode & 0o444) !== 0o444) throw new Error(`${label} is not readable by every runtime user: ${path}`);
  if (requireExecutable && (metadata.mode & 0o111) !== 0o111) {
    throw new Error(`${label} is not executable by every runtime user: ${path}`);
  }
  const contents = readFileSync(path);
  if (!contents.subarray(0, Buffer.byteLength(PYTHON_SHEBANG)).equals(Buffer.from(PYTHON_SHEBANG))) {
    throw new Error(`${label} does not start with the expected Python 3 shebang: ${path}`);
  }
  if (contents.includes(0)) throw new Error(`${label} contains a NUL byte: ${path}`);
  return contents;
}

/**
 * Copy non-JavaScript runtime helpers into server/dist after the bundle is built.
 * The asset is written under its final basename because the bundled resolver uses
 * import.meta.url and must work unchanged in server/dist and aggregate git-dist.
 */
export function copyServerRuntimeAssets(serverRoot = DEFAULT_SERVER_ROOT): string {
  const source = resolve(serverRoot, "src", "integrations", TERMINAL_PTY_WAL_PROXY_ASSET);
  const targetDirectory = resolve(serverRoot, "dist");
  const target = resolve(targetDirectory, TERMINAL_PTY_WAL_PROXY_ASSET);
  const temporary = `${target}.tmp-${process.pid}`;
  const expected = assertRuntimeAsset(source, "terminal PTY WAL proxy source asset", true);

  mkdirSync(targetDirectory, { recursive: true });
  rmSync(temporary, { force: true });
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, PUBLISHED_MODE);
    const copied = assertRuntimeAsset(temporary, "copied terminal PTY WAL proxy asset", true);
    if (!copied.equals(expected)) throw new Error(`copied runtime asset differs from source: ${temporary}`);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }

  const published = assertRuntimeAsset(target, "published terminal PTY WAL proxy asset", true);
  if (!published.equals(expected)) throw new Error(`published runtime asset differs from source: ${target}`);
  return target;
}

if (import.meta.main) {
  const target = copyServerRuntimeAssets();
  console.log(`copied server runtime asset: ${target}`);
}

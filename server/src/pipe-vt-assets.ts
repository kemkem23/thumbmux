/**
 * Names and pinned vendor hash of the pipe-vt worker assets.
 *
 * This file imports nothing on purpose: `scripts/copy-runtime-assets.ts` runs
 * at build time and reads these constants, and the cage's docs staging policy
 * pins this file by hash as a build adapter. Anything added here runs during
 * every package build.
 */

export const PIPE_VT_VENDOR_SHA256 = "626c68240ce421066a4c915fca0ca0b44576a274fc14d89cae85e6105a79940d";
export const PIPE_VT_WORKER_FILE = "pipe-vt-worker.py";
export const PIPE_VT_VENDOR_FILE = "pipe-vt-vendor.zip";
export const PIPE_VT_LICENSE_FILE = "pipe-vt-LICENSE.txt";

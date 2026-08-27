import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertLocalDemoUrl,
  assertThumbmuxMediaRuntime,
  assertThumbmuxPlaywrightRuntime,
} from '../e2e/test-runtime-guard';

const token = '0123456789abcdef0123456789abcdef';

describe('thumbmux e2e runtime admission', () => {
  test('accepts only an authenticated ephemeral numeric loopback URL', () => {
    expect(assertLocalDemoUrl(`http://127.0.0.1:49123/?t=${token}`))
      .toBe(`http://127.0.0.1:49123/?t=${token}`);
    for (const url of [
      `http://127.0.0.1:47779/?t=${token}`,
      `http://127.0.0.1:47780/?t=${token}`,
      `http://127.0.0.1:1/?t=${token}`,
      `http://localhost:49123/?t=${token}`,
      `https://127.0.0.1:49123/?t=${token}`,
      'http://127.0.0.1:49123/',
    ]) {
      expect(() => assertLocalDemoUrl(url)).toThrow('ephemeral 127.0.0.1');
    }
  });

  test('forged GitHub/disposable markers do not replace the filesystem attestation', () => {
    const forged: NodeJS.ProcessEnv = {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_REPOSITORY: 'kemkem23/thumbmux',
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_WORKSPACE: '/home/runner/work/thumbmux/thumbmux',
      RUNNER_TEMP: '/home/runner/work/_temp',
      USER: 'runner',
      LOGNAME: 'runner',
      THUMBMUX_GUARD_PROVIDER: 'github-hosted',
      THUMBMUX_TEST_SCOPE: 'e2e',
      THUMBMUX_TEST_RUN_ID: token,
      THUMBMUX_TEST_ATTESTATION: '/tmp/forged-runtime-attestation',
      THUMBMUX_CONTAINER: 'b'.repeat(64),
      THUMBMUX_GUARD_DOCKER_ID: 'forged-docker',
      THUMBMUX_GUARD_DOCKER_ROOT: '/var/lib/docker',
      THUMBMUX_GUARD_DOCKER_HOST: 'unix:///var/run/docker.sock',
      THUMBMUX_GUARD_DOCKER_SOCKET_IDENTITY: '1:2:3:660',
    };
    expect(() => assertThumbmuxPlaywrightRuntime(forged))
      .toThrow(/GitHub-hosted disposable-job heuristic|runner paths|checkout\/runtime paths/);
    expect(() => assertThumbmuxMediaRuntime({
      ...forged,
      THUMBMUX_TEST_SCOPE: 'media',
      THUMBMUX_TEST_ATTESTATION: '/tmp/forged-media-attestation',
    })).toThrow(/GitHub-hosted disposable-job heuristic|runner paths|checkout\/runtime paths/);
  });

  test('the media browser driver checks scope/container/output before launch', () => {
    const driver = readFileSync(resolve(import.meta.dir, 'capture-media.ts'), 'utf8');
    const guard = driver.indexOf('assertThumbmuxDockerContainer("media")');
    const launch = driver.indexOf('chromium.launch');
    expect(guard).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(guard);
    expect(driver).toContain('assertLocalDemoUrl(process.env.DEMO_URL)');
    expect(driver).not.toContain('?? "/tmp/thumbmux-media-artifacts"');
  });

  test('the former direct host-tmux proof is an unconditional historical failure', () => {
    const proof = readFileSync(
      resolve(import.meta.dir, '../e2e/proof-archive-live-seam.mjs'),
      'utf8',
    );
    expect(proof).toContain('disabled unsafe historical proof');
    expect(proof).not.toContain('execFileSync');
    expect(proof).not.toContain('tmux kill-session');
  });

  test('local parity enters the canonical sandbox before any package lifecycle', () => {
    const parity = readFileSync(resolve(import.meta.dir, 'ci-parity.sh'), 'utf8');
    const runner = parity.indexOf('ops/testing/run-isolated-command.sh');
    const install = parity.indexOf('bun install --frozen-lockfile');
    expect(runner).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(runner);
    expect(parity).toContain('assert_hard_test_sandbox command');
    expect(parity).toContain('INCOMPLETE — full parity requires disposable public CI');
  });

  test('local parity pins the exact ordered command-sandbox ABI v2 before the central verifier', () => {
    const parity = readFileSync(resolve(import.meta.dir, 'ci-parity.sh'), 'utf8');
    const guard = readFileSync(resolve(import.meta.dir, 'test-runtime-guard.sh'), 'utf8');
    const abiStart = guard.indexOf('thumbmux_assert_command_sandbox_abi_v2()');
    const abiEnd = guard.indexOf('thumbmux_refuse_local_dangerous_lane()', abiStart);
    const abi = guard.slice(abiStart, abiEnd);
    const schema = [
      "'version=2'",
      "'kind=command'",
      '^host-netns=net:',
      '^host-mntns=mnt:',
      '^host-pidns=pid:',
      '^host-ipcns=ipc:',
      '^source-head=',
      '^source-tree=',
    ];
    expect(abiStart).toBeGreaterThan(-1);
    expect(abiEnd).toBeGreaterThan(abiStart);
    expect(abi).toContain('/run/kemcortex-isolated-command');
    expect(abi).toContain('${#lines[@]}" == 8');
    let previous = -1;
    for (const field of schema) {
      const current = abi.indexOf(field);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(abi).not.toContain('version=1');

    const abiCall = parity.indexOf(
      'thumbmux_assert_command_sandbox_abi_v2 /run/kemcortex-isolated-command',
    );
    const centralVerifier = parity.indexOf('assert_hard_test_sandbox command');
    const install = parity.indexOf('bun install --frozen-lockfile');
    expect(abiCall).toBeGreaterThan(-1);
    expect(centralVerifier).toBeGreaterThan(abiCall);
    expect(install).toBeGreaterThan(centralVerifier);
    expect(parity).toContain('INCOMPLETE — command sandbox ABI v2 attestation failed');
  });

  test('Docker and host-tmux entrypoints admit runtime before first lifecycle call', () => {
    const e2e = readFileSync(resolve(import.meta.dir, '../e2e/run-container.sh'), 'utf8');
    const media = readFileSync(resolve(import.meta.dir, 'capture-media.sh'), 'utf8');
    const smoke = readFileSync(resolve(import.meta.dir, 'smoke-git-dist.sh'), 'utf8');
    const contracts = readFileSync(resolve(import.meta.dir, 'contract-fixtures.sh'), 'utf8');
    for (const [source, lifecycle] of [
      [e2e, 'docker run --detach'],
      [media, 'docker run --detach'],
      [smoke, '/usr/bin/timeout 240 /usr/bin/docker run'],
      [contracts, 'if [[ -n "$(fixture_sessions)" ]]'],
    ] as const) {
      const admission = source.indexOf('thumbmux_prepare_test_runtime');
      expect(admission).toBeGreaterThan(-1);
      // Shell function bodies are definitions, not lifecycle execution. Start
      // at the admission call so a pre-admission helper definition cannot be
      // mistaken for an executed tmux/Docker operation.
      const firstLifecycle = source.indexOf(lifecycle, admission);
      expect(firstLifecycle).toBeGreaterThan(admission);
    }
    expect(media).not.toContain('docker ps -a');
    expect(contracts).not.toContain('tmux kill-session');
  });

  test('dangerous shell entrypoints use privileged fixed Bash and scrub hooks before admission', () => {
    const entrypoints = [
      '../e2e/run-container.sh',
      'capture-media.sh',
      'ci-parity.sh',
      'contract-fixtures.sh',
      'media-scenes/stage.sh',
      'private-test-tmux.sh',
      'smoke-git-dist.sh',
      'test-runtime-guard.sh',
    ];
    for (const relativePath of entrypoints) {
      const source = readFileSync(resolve(import.meta.dir, relativePath), 'utf8');
      const admission = source.indexOf('thumbmux_prepare_test_runtime');
      expect(source.startsWith('#!/usr/bin/bash -p\n')).toBe(true);
      expect(source.indexOf('PATH=/usr/bin:/bin')).toBeGreaterThan(-1);
      expect(source.indexOf('unset BASH_ENV ENV CDPATH GLOBIGNORE')).toBeGreaterThan(-1);
      if (admission >= 0) {
        expect(source.indexOf('PATH=/usr/bin:/bin')).toBeLessThan(admission);
        expect(source.indexOf('unset BASH_ENV ENV CDPATH GLOBIGNORE')).toBeLessThan(admission);
      }
    }
    const action = readFileSync(
      resolve(import.meta.dir, '../.github/actions/verify-gate/action.yml'),
      'utf8',
    );
    expect(action).not.toContain('shell: bash');
    expect(action).toContain('shell: /usr/bin/bash --noprofile --norc -p -e -o pipefail {0}');
  });

  test('public runners transfer committed archives and reject production ports', () => {
    const e2e = readFileSync(resolve(import.meta.dir, '../e2e/run-container.sh'), 'utf8');
    const media = readFileSync(resolve(import.meta.dir, 'capture-media.sh'), 'utf8');
    const parity = readFileSync(resolve(import.meta.dir, 'ci-parity.sh'), 'utf8');
    for (const source of [e2e, media]) {
      expect(source).toContain('thumbmux_emit_frozen_source_archive');
      expect(source).not.toContain('tar -C "$PACKAGE_ROOT"');
      expect(source).toContain('47779|47780)');
    }
    expect(parity).toContain('thumbmux_emit_frozen_source_archive');
    expect(parity).toContain('THUMBMUX_PUBLIC_EXPORT_ATTESTATION');
    expect(parity).toContain('write-tree');
    expect(parity).not.toContain('mktemp -d -t thumbmux-ci-parity');
  });

  test('e2e tmux operations use exact session, window, and pane targets', () => {
    const helpers = readFileSync(resolve(import.meta.dir, '../e2e/helpers.ts'), 'utf8');
    expect(helpers).toContain('shellQuote(`=${session}`)');
    expect(helpers).toContain('shellQuote(`=${session}:0.0`)');
    expect(helpers).not.toContain('shellQuote(`=${session}:0`)');
    expect(helpers).not.toContain('shellQuote(session)} history-limit');
    expect(helpers).not.toContain('shellQuote(session)} -p -S');
  });

  test('every package tmux command is forced through one explicit private socket', () => {
    const shim = readFileSync(resolve(import.meta.dir, 'private-test-tmux.sh'), 'utf8');
    expect(shim).toContain('/usr/bin/env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR /usr/bin/tmux -S "$socket"');
    expect(shim).toContain('caller socket selector -%s is forbidden');
    expect(shim).not.toContain('TMUX_TMPDIR:-');
  });
});

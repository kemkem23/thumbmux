import { afterEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { flushSync, mount, tick, unmount } from './svelte-client';
import DpadSheet from '../src/DpadSheet.svelte';
import {
  DEFAULT_DPAD_PLACEMENT,
  resolveDpadPlacement,
  type DpadPlacement,
} from '../src/dpad';

type Mounted = { app: Record<string, unknown>; target: HTMLElement };
const mounted: Mounted[] = [];

function mountPad(props: {
  open?: boolean;
  placement?: DpadPlacement;
  onKey?: (seq: string) => void;
}): Mounted {
  const target = document.createElement('div');
  target.style.cssText = 'position:relative;width:390px;height:664px;';
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(DpadSheet as Component, {
      target,
      props: {
        open: props.open ?? true,
        placement: props.placement,
        onKey: props.onKey ?? (() => {}),
      },
    }) as Record<string, unknown>;
  });
  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch { /* already torn down */ }
    entry.target.remove();
  }
});

describe('resolveDpadPlacement', () => {
  test('stock default is bottom-left', () => {
    expect(DEFAULT_DPAD_PLACEMENT).toBe('bottom-left');
    expect(resolveDpadPlacement(undefined)).toBe('bottom-left');
    expect(resolveDpadPlacement(null)).toBe('bottom-left');
    expect(resolveDpadPlacement('middle')).toBe('bottom-left');
  });

  test('accepts all four corners', () => {
    for (const corner of ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const) {
      expect(resolveDpadPlacement(corner)).toBe(corner);
    }
  });
});

describe('DpadSheet placement', () => {
  test('omitted placement keeps bottom-left data attribute', async () => {
    const { target } = mountPad({});
    await tick();
    const pad = target.querySelector<HTMLElement>('[data-testid="dpad-sheet"]');
    expect(pad).not.toBeNull();
    expect(pad?.getAttribute('data-placement')).toBe('bottom-left');
  });

  test('each corner sets data-placement', async () => {
    for (const corner of ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const) {
      const entry = mountPad({ placement: corner });
      await tick();
      const pad = entry.target.querySelector<HTMLElement>('[data-testid="dpad-sheet"]');
      expect(pad?.getAttribute('data-placement'), corner).toBe(corner);
      unmount(entry.app);
      entry.target.remove();
      mounted.pop();
    }
  });

  test('arrow buttons still emit CSI sequences', async () => {
    const keys: string[] = [];
    const { target } = mountPad({
      placement: 'top-right',
      onKey: (seq) => keys.push(seq),
    });
    await tick();
    flushSync(() => {
      target.querySelector<HTMLButtonElement>('[data-testid="dpad-up"]')?.click();
      target.querySelector<HTMLButtonElement>('[data-testid="dpad-down"]')?.click();
      target.querySelector<HTMLButtonElement>('[data-testid="dpad-left"]')?.click();
      target.querySelector<HTMLButtonElement>('[data-testid="dpad-right"]')?.click();
      target.querySelector<HTMLButtonElement>('[data-testid="dpad-enter"]')?.click();
      target.querySelector<HTMLButtonElement>('[data-testid="dpad-esc"]')?.click();
    });
    expect(keys).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C', '\r', '\x1b']);
  });
});

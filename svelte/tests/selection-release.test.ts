/**
 * The selection release is a document-level capture listener, so these tests
 * drive real DOM: a viewport element carrying TermView's own `data-testid`,
 * a real `Selection` from happy-dom, and real dispatched events. Asserting on
 * the module's helpers alone would not prove the listener is registered in the
 * capture phase, which is the only reason the release works at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  STOCK_SCROLL_CONTROL_SELECTORS,
  installTerminalSelectionRelease,
  isScrollIntent,
  releasableTerminalSelection,
} from '../src/selection-release';

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

function install(options?: Parameters<typeof installTerminalSelectionRelease>[0]): () => void {
  const dispose = installTerminalSelectionRelease(options);
  disposers.push(dispose);
  return dispose;
}

/** A viewport with pane text, plus the stock scroll controls outside it. */
function buildTerminal(): {
  viewport: HTMLElement;
  paneText: Text;
  search: HTMLElement;
  searchText: Text;
  field: HTMLInputElement;
  scrollBottom: HTMLElement;
  outside: HTMLElement;
  outsideText: Text;
} {
  document.body.innerHTML = `
    <div data-testid="mtv">
      <div class="mtv-rows"><span id="row">pane output line</span></div>
      <div class="mtv-search"><span id="hit">search hit</span></div>
    </div>
    <input id="composer" />
    <button data-testid="demo-scroll-bottom">bottom</button>
    <button data-testid="fab">FAB</button>
    <p id="outside">unrelated page text</p>
  `;
  const viewport = document.querySelector('[data-testid="mtv"]') as HTMLElement;
  return {
    viewport,
    paneText: document.getElementById('row')!.firstChild as Text,
    search: document.querySelector('.mtv-search') as HTMLElement,
    searchText: document.getElementById('hit')!.firstChild as Text,
    field: document.getElementById('composer') as HTMLInputElement,
    scrollBottom: document.querySelector('[data-testid="demo-scroll-bottom"]') as HTMLElement,
    outside: document.getElementById('outside') as HTMLElement,
    outsideText: document.getElementById('outside')!.firstChild as Text,
  };
}

function selectText(node: Text): Selection {
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.data.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function wheel(): void {
  document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
}

/**
 * happy-dom's TouchEvent does not populate `touches` from the init dict, so the
 * lists are attached explicitly. The handler reads `touches.length`,
 * `touches[0]` and `changedTouches[0]` — nothing else.
 */
function touchStart(target: EventTarget, points: Array<{ x: number; y: number }>): void {
  const event = new Event('touchstart', { bubbles: true }) as Event & {
    touches: unknown;
    changedTouches: unknown;
  };
  const list = points.map((p) => ({ clientX: p.x, clientY: p.y }));
  Object.defineProperty(event, 'touches', { value: list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  target.dispatchEvent(event);
}

describe('releasableTerminalSelection', () => {
  test('claims a selection anchored in the pane', () => {
    const dom = buildTerminal();
    selectText(dom.paneText);
    const active = releasableTerminalSelection();
    expect(active).not.toBeNull();
    expect(active!.range.toString()).toBe('pane output line');
  });

  test('leaves the terminal search overlay alone even though it is inside the viewport', () => {
    const dom = buildTerminal();
    expect(dom.search.closest('[data-testid="mtv"]')).toBe(dom.viewport);
    selectText(dom.searchText);
    expect(releasableTerminalSelection()).toBeNull();
  });

  test('leaves selections outside any terminal alone', () => {
    const dom = buildTerminal();
    selectText(dom.outsideText);
    expect(releasableTerminalSelection()).toBeNull();
  });

  test('an empty or collapsed selection is not claimable', () => {
    buildTerminal();
    window.getSelection()?.removeAllRanges();
    expect(releasableTerminalSelection()).toBeNull();
  });
});

describe('isScrollIntent', () => {
  test('the pane itself and the stock scroll controls are scroll intents', () => {
    const dom = buildTerminal();
    expect(isScrollIntent(dom.paneText.parentElement)).toBe(true);
    expect(isScrollIntent(dom.scrollBottom)).toBe(true);
  });

  test('any other control is not', () => {
    buildTerminal();
    expect(isScrollIntent(document.querySelector('[data-testid="fab"]'))).toBe(false);
    expect(isScrollIntent(null)).toBe(false);
  });

  test('a host control counts only once it is named', () => {
    document.body.innerHTML = '<button class="kx-jump">jump</button>';
    const button = document.querySelector('.kx-jump')!;
    expect(isScrollIntent(button)).toBe(false);
    expect(
      isScrollIntent(button, [...STOCK_SCROLL_CONTROL_SELECTORS, '.kx-jump'].join(', ')),
    ).toBe(true);
  });
});

describe('installTerminalSelectionRelease', () => {
  test('a wheel releases a pane selection', () => {
    const dom = buildTerminal();
    install();
    const selection = selectText(dom.paneText);
    expect(selection.isCollapsed).toBe(false);
    wheel();
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  test('a wheel does not touch a selection outside the terminal', () => {
    const dom = buildTerminal();
    install();
    selectText(dom.outsideText);
    wheel();
    expect(window.getSelection()?.toString()).toBe('unrelated page text');
  });

  test('nothing is released before install, and nothing after dispose', () => {
    const dom = buildTerminal();
    selectText(dom.paneText);
    wheel();
    expect(window.getSelection()?.toString()).toBe('pane output line');

    const dispose = install();
    dispose();
    selectText(dom.paneText);
    wheel();
    expect(window.getSelection()?.toString()).toBe('pane output line');
  });

  test('two installs share one pair of listeners and survive one disposer', () => {
    const dom = buildTerminal();
    const first = install();
    install();
    first();

    selectText(dom.paneText);
    wheel();
    // The second holder is still installed, so the release still happens.
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  test('a disposer called twice does not uninstall a sibling holder', () => {
    const dom = buildTerminal();
    const first = install();
    install();
    first();
    first();

    selectText(dom.paneText);
    wheel();
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  test('a touch in the pane releases; a touch on an unrelated control does not', () => {
    const dom = buildTerminal();
    install();

    selectText(dom.paneText);
    touchStart(dom.viewport, [{ x: 5000, y: 5000 }]);
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);

    selectText(dom.paneText);
    touchStart(document.querySelector('[data-testid="fab"]')!, [{ x: 5000, y: 5000 }]);
    expect(window.getSelection()?.toString()).toBe('pane output line');
  });

  test('a two-finger touch is a pinch and never releases', () => {
    const dom = buildTerminal();
    install();
    selectText(dom.paneText);
    touchStart(dom.viewport, [{ x: 5000, y: 5000 }, { x: 5100, y: 5100 }]);
    expect(window.getSelection()?.toString()).toBe('pane output line');
  });

  test('a host scroll control releases only once it is declared', () => {
    document.body.innerHTML = `
      <div data-testid="mtv"><span id="row">pane output line</span></div>
      <button class="kx-jump">jump</button>
    `;
    const paneText = document.getElementById('row')!.firstChild as Text;
    const jump = document.querySelector('.kx-jump')!;

    const stock = install();
    selectText(paneText);
    touchStart(jump, [{ x: 5000, y: 5000 }]);
    expect(window.getSelection()?.toString()).toBe('pane output line');
    stock();

    install({ scrollControlSelectors: ['.kx-jump'] });
    selectText(paneText);
    touchStart(jump, [{ x: 5000, y: 5000 }]);
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });
});

/**
 * @thumbmux/core — framework-free primitives of the thumbmux terminal stack.
 *
 * ansi-html       SGR → HTML incremental renderer (the 120Hz engine's parser)
 * terminal-link   URL detection across wrapped pane lines → tappable ranges
 * terminal-scroll merge successive pane captures without scroll jumps
 * prompt-scan     extract the user's submitted prompts from raw pane text
 * surface         derive a full readable surface from one background color
 * cells           terminal cell widths (Thai/CJK/emoji) → cursor column math
 * keys            desktop KeyboardEvent → terminal byte sequences (+ bracketed paste)
 * sgr-mouse       SGR mouse-forwarding math for alt-screen TUIs (wheel/click/hit-test)
 */
export * from './ansi-html';
export * from './terminal-link';
export * from './terminal-scroll';
export * from './prompt-scan';
export * from './surface';
export * from './protocol';
export * from './launch';
export * from './upload';
export * from './cells';
export * from './copy';
export * from './prefs';
export * from './keys';
export * from './sgr-mouse';

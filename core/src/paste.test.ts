import { describe, expect, test } from 'bun:test';

import { pasteInfo, utf8ByteLength } from './paste';

describe('utf8ByteLength', () => {
  test('counts ASCII bytes', () => {
    expect(utf8ByteLength('abc123')).toBe(6);
  });

  test('counts line ending bytes literally', () => {
    expect(utf8ByteLength('a\r\nb\rc\n')).toBe(7);
  });

  test('counts two-byte code points', () => {
    expect(utf8ByteLength('\u00e9')).toBe(2);
  });

  test('counts three-byte code points', () => {
    expect(utf8ByteLength('\u0e2a')).toBe(3);
  });

  test('counts four-byte code points', () => {
    expect(utf8ByteLength('\u{1f600}')).toBe(4);
  });

  test('counts mixed text bytes', () => {
    expect(utf8ByteLength('a\u00e9\u0e2a\u{1f600}')).toBe(10);
  });

  test('matches TextEncoder behavior for a lone surrogate', () => {
    expect(utf8ByteLength('\ud800')).toBe(3);
  });
});

describe('pasteInfo line thresholds', () => {
  test('returns null for a single short line', () => {
    expect(pasteInfo('hello')).toBeNull();
  });

  test('returns null for five LF-separated lines by default', () => {
    expect(pasteInfo('1\n2\n3\n4\n5')).toBeNull();
  });

  test('warns at exactly six LF-separated lines by default', () => {
    const text = '1\n2\n3\n4\n5\n6';
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 6,
      byteLength: 11,
      reason: 'multiline',
    });
  });

  test('warns at exactly six CRLF-separated lines by default', () => {
    const text = '1\r\n2\r\n3\r\n4\r\n5\r\n6';
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 6,
      byteLength: 16,
      reason: 'multiline',
    });
  });

  test('warns at exactly six CR-separated lines by default', () => {
    const text = '1\r2\r3\r4\r5\r6';
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 6,
      byteLength: 11,
      reason: 'multiline',
    });
  });

  test('counts mixed newline forms with CRLF as one separator', () => {
    const text = '1\r\n2\r3\n4\r\n5\n6';
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 6,
      byteLength: 13,
      reason: 'multiline',
    });
  });

  test('counts a trailing newline as an extra line', () => {
    const text = '1\n2\n3\n4\n5\n';
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 6,
      byteLength: 10,
      reason: 'multiline',
    });
  });
});

describe('pasteInfo byte thresholds', () => {
  test('returns null one byte below the default byte threshold', () => {
    expect(pasteInfo('a'.repeat(4095))).toBeNull();
  });

  test('warns at exactly the default byte threshold', () => {
    const text = 'a'.repeat(4096);
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 1,
      byteLength: 4096,
      reason: 'large',
    });
  });

  test('warns above the default byte threshold', () => {
    const text = 'a'.repeat(4097);
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 1,
      byteLength: 4097,
      reason: 'large',
    });
  });

  test('uses UTF-8 bytes rather than UTF-16 length for the byte threshold', () => {
    const text = '\u00e9'.repeat(2048);
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 1,
      byteLength: 4096,
      reason: 'large',
    });
  });

  test('reports multiline-large when both thresholds match', () => {
    const text = `${'a'.repeat(4096)}\n1\n2\n3\n4\n5`;
    expect(pasteInfo(text)).toEqual({
      text,
      lineCount: 6,
      byteLength: 4106,
      reason: 'multiline-large',
    });
  });
});

describe('pasteInfo threshold options', () => {
  test('warnLines 0 disables the line threshold', () => {
    expect(pasteInfo('1\n2\n3\n4\n5\n6', { warnLines: 0 })).toBeNull();
  });

  test('negative warnLines disables the line threshold', () => {
    expect(pasteInfo('1\n2\n3\n4\n5\n6', { warnLines: -1 })).toBeNull();
  });

  test('warnBytes 0 disables the byte threshold', () => {
    expect(pasteInfo('a'.repeat(4096), { warnBytes: 0 })).toBeNull();
  });

  test('negative warnBytes disables the byte threshold', () => {
    expect(pasteInfo('a'.repeat(4096), { warnBytes: -1 })).toBeNull();
  });

  test('disabled line threshold still allows a byte warning', () => {
    const text = 'a'.repeat(4096);
    expect(pasteInfo(text, { warnLines: 0 })).toEqual({
      text,
      lineCount: 1,
      byteLength: 4096,
      reason: 'large',
    });
  });

  test('disabled byte threshold still allows a line warning', () => {
    const text = '1\n2\n3\n4\n5\n6';
    expect(pasteInfo(text, { warnBytes: 0 })).toEqual({
      text,
      lineCount: 6,
      byteLength: 11,
      reason: 'multiline',
    });
  });

  test('disabling both thresholds returns null for multiline large text', () => {
    const text = `${'a'.repeat(4096)}\n1\n2\n3\n4\n5`;
    expect(pasteInfo(text, { warnLines: 0, warnBytes: 0 })).toBeNull();
  });

  test('custom warnLines uses inclusive threshold comparison', () => {
    const text = 'a\nb';
    expect(pasteInfo(text, { warnLines: 2 })).toEqual({
      text,
      lineCount: 2,
      byteLength: 3,
      reason: 'multiline',
    });
  });

  test('custom warnBytes uses inclusive threshold comparison', () => {
    const text = 'abc';
    expect(pasteInfo(text, { warnBytes: 3 })).toEqual({
      text,
      lineCount: 1,
      byteLength: 3,
      reason: 'large',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { highlightSpans } from '../lib/highlight';

describe('highlightSpans', () => {
  it('empty needle returns single non-hit span', () => {
    expect(highlightSpans('hello', '')).toEqual([{ hit: false, text: 'hello' }]);
  });

  it('no match returns single non-hit span', () => {
    expect(highlightSpans('hello world', 'xyz')).toEqual([{ hit: false, text: 'hello world' }]);
  });

  it('single match splits into pre / hit / post', () => {
    expect(highlightSpans('foo bar baz', 'bar')).toEqual([
      { hit: false, text: 'foo ' },
      { hit: true, text: 'bar' },
      { hit: false, text: ' baz' },
    ]);
  });

  it('multi match alternates', () => {
    expect(highlightSpans('a-b-c-b', 'b')).toEqual([
      { hit: false, text: 'a-' },
      { hit: true, text: 'b' },
      { hit: false, text: '-c-' },
      { hit: true, text: 'b' },
    ]);
  });

  it('case-insensitive match preserves original casing in output', () => {
    expect(highlightSpans('Foo bar FOO', 'foo')).toEqual([
      { hit: true, text: 'Foo' },
      { hit: false, text: ' bar ' },
      { hit: true, text: 'FOO' },
    ]);
  });
});

import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { useSession } from '../state/session';

function fireKey(opts: KeyboardEventInit & { key: string }, target?: EventTarget) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
  if (target) Object.defineProperty(ev, 'target', { value: target });
  window.dispatchEvent(ev);
  return ev;
}

const ALL_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

describe('useGlobalShortcuts', () => {
  beforeEach(() => {
    useSession.setState({
      metadata: {
        path: '/x',
        total: 0,
        time_range: null,
        level_counts: {},
        scopes: [],
        scope_counts: {},
        template_id: 'json-lines',
      },
      spec: { levels: ['error'], text_search: 'foo' },
      helpOpen: false,
      selectedEntry: null,
      rotationKind: null,
      follow: false,
    });
  });

  it('? toggles help when not typing', () => {
    renderHook(() => useGlobalShortcuts());
    fireKey({ key: '?' });
    expect(useSession.getState().helpOpen).toBe(true);
    fireKey({ key: '?' });
    expect(useSession.getState().helpOpen).toBe(false);
  });

  it('? does NOT toggle help when typing in an input', () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey({ key: '?' }, input);
    expect(useSession.getState().helpOpen).toBe(false);
    document.body.removeChild(input);
  });

  it('⌘F dispatches lv:focus-keyword CustomEvent', () => {
    renderHook(() => useGlobalShortcuts());
    const spy = vi.fn();
    window.addEventListener('lv:focus-keyword', spy);
    fireKey({ key: 'f', metaKey: true });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('lv:focus-keyword', spy);
  });

  it('⌘K resets all filter fields on spec', () => {
    renderHook(() => useGlobalShortcuts());
    fireKey({ key: 'k', metaKey: true });
    const { spec } = useSession.getState();
    expect(spec.levels).toEqual(ALL_LEVELS);
    expect(spec.scope_filter).toBeNull();
    expect(spec.scope_in).toBeNull();
    expect(spec.text_search).toBeNull();
    expect(spec.time_range).toBeNull();
  });

  it('Esc closes help first, then rotationDialog, then drawer (in priority order)', () => {
    useSession.setState({
      helpOpen: true,
      rotationKind: 'Truncated',
      selectedEntry: {
        line_no: 1,
        line_count: 1,
        timestamp: null,
        level: 'info',
        scope: null,
        message: '',
        fields: {},
        raw: '',
      },
    });
    renderHook(() => useGlobalShortcuts());

    fireKey({ key: 'Escape' });
    expect(useSession.getState().helpOpen).toBe(false);
    expect(useSession.getState().rotationKind).toBe('Truncated');
    expect(useSession.getState().selectedEntry).not.toBeNull();

    fireKey({ key: 'Escape' });
    expect(useSession.getState().rotationKind).toBeNull();
    expect(useSession.getState().selectedEntry).not.toBeNull();

    fireKey({ key: 'Escape' });
    expect(useSession.getState().selectedEntry).toBeNull();
  });
});

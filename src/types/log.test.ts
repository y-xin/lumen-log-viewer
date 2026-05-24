import { describe, expect, it } from 'vitest';
import { logSourceToUri, logSourceFromUri, type LogSource } from './log';

describe('LogSource URI', () => {
  it('local roundtrip', () => {
    const s: LogSource = { kind: 'local', path: '/var/log/a.log' };
    expect(logSourceToUri(s)).toBe('file:///var/log/a.log');
    expect(logSourceFromUri('file:///var/log/a.log')).toEqual(s);
  });

  it('remote default port omitted', () => {
    const s: LogSource = { kind: 'remote', host: 'prod-1', user: 'kim', port: 22, path: '/var/log/x' };
    expect(logSourceToUri(s)).toBe('ssh://kim@prod-1/var/log/x');
    expect(logSourceFromUri('ssh://kim@prod-1/var/log/x')).toEqual(s);
  });

  it('remote non-default port', () => {
    const s: LogSource = { kind: 'remote', host: 'p', user: 'k', port: 2222, path: '/a' };
    expect(logSourceToUri(s)).toBe('ssh://k@p:2222/a');
    expect(logSourceFromUri('ssh://k@p:2222/a')).toEqual(s);
  });

  it('legacy bare path treated as local', () => {
    expect(logSourceFromUri('/var/log/old', { allowLegacyPath: true }))
      .toEqual({ kind: 'local', path: '/var/log/old' });
  });
});

import { describe, it, expect } from 'vitest';
import { compareVersions, isNewerThanCompatible, KNOWN_COMPATIBLE_CLAUDE_VERSION } from '../claudeCompat';

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically (2.1.9 < 2.1.218)', () => {
    expect(compareVersions('2.1.9', '2.1.218')).toBe(-1);
    expect(compareVersions('2.1.218', '2.1.9')).toBe(1);
  });
  it('compares minor numerically (2.10 > 2.9)', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1);
  });
  it('treats missing segments as zero (2.1 == 2.1.0)', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
  });
  it('equal versions', () => {
    expect(compareVersions('2.1.218', '2.1.218')).toBe(0);
  });
});

describe('isNewerThanCompatible', () => {
  it('is false for the pinned version and older', () => {
    expect(isNewerThanCompatible(KNOWN_COMPATIBLE_CLAUDE_VERSION)).toBe(false);
    expect(isNewerThanCompatible('2.0.0')).toBe(false);
  });
  it('is true for a newer patch or minor', () => {
    expect(isNewerThanCompatible('2.1.999')).toBe(true);
    expect(isNewerThanCompatible('3.0.0')).toBe(true);
  });
});

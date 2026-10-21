import { describe, expect, it } from 'vitest';
import { usesMobileInput } from '../../src/web/lib/mobile-input';

describe('composer device policy', () => {
  it.each([
    ['iPhone', 'iPhone', 5, true],
    ['iPad', 'iPad', 5, true],
    ['iPod', 'iPod', 5, true],
    ['Mozilla/5.0 (Linux; Android 16)', 'Linux armv8l', 5, true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'MacIntel', 5, true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'MacIntel', 0, false],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10, false],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64', 10, false],
  ])(
    '%s on %s with %s touch points → mobile=%s',
    (userAgent, platform, maxTouchPoints, expected) => {
      expect(usesMobileInput({ userAgent, platform, maxTouchPoints })).toBe(expected);
    },
  );

  it('accepts a mobile UA client hint but does not mistake a tablet hint for desktop', () => {
    expect(
      usesMobileInput({
        userAgent: '',
        platform: '',
        maxTouchPoints: 0,
        userAgentData: { mobile: true },
      }),
    ).toBe(true);
    expect(
      usesMobileInput({
        userAgent: 'Android',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
        userAgentData: { mobile: false },
      }),
    ).toBe(true);
  });
});

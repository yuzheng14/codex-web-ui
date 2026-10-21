type InputNavigator = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & {
  userAgentData?: { mobile: boolean };
};

/** A conservative device policy, not detection of an individual key's source.
 * Width, orientation and touch support alone must never change desktop shortcuts.
 * Mobile hardware keyboards intentionally share the safer button-to-send policy.
 */
export function usesMobileInput(device: InputNavigator): boolean {
  return (
    device.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod/i.test(device.userAgent) ||
    (device.platform === 'MacIntel' && device.maxTouchPoints > 1)
  );
}

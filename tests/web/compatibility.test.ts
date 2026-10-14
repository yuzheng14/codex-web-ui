import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../src/shared/types';
import {
  canConfirmCompatibility,
  compatibilityConfirmationInput,
  compatibilityFingerprint,
  operationNeedsCompatibilityConfirmation,
  shouldOpenCompatibilityDialog,
} from '../../src/web/lib/compatibility';

const system: SystemInfo = {
  ready: true,
  connection: 'ready',
  codexVersion: '0.200.0',
  verifiedVersion: '0.162.1',
  compatibility: 'unverified',
  compatibilityConfirmation: 'required',
  codexEpoch: 'current-runtime',
  authenticated: true,
  authMode: 'local',
  models: [],
  capabilities: [],
  demo: false,
};

describe('compatibility confirmation policy', () => {
  it('does not reopen a cancelled warning on polling, but supports an explicit reopen', () => {
    const fingerprint = compatibilityFingerprint(system);
    expect(shouldOpenCompatibilityDialog(system, undefined)).toBe(true);
    expect(shouldOpenCompatibilityDialog({ ...system }, fingerprint)).toBe(false);
    expect(shouldOpenCompatibilityDialog(system, fingerprint, fingerprint)).toBe(true);
  });

  it.each([
    { codexEpoch: 'restarted-runtime' },
    { codexVersion: '0.201.0' },
    { verifiedVersion: '0.163.0' },
  ])('requires a new decision when runtime identity changes: %j', (change) => {
    const dismissed = compatibilityFingerprint(system);
    expect(shouldOpenCompatibilityDialog({ ...system, ...change }, dismissed)).toBe(true);
  });

  it('closes an open warning when another tab confirms without marking its version verified', () => {
    const confirmed = { ...system, compatibilityConfirmation: 'confirmed' as const };
    expect(
      shouldOpenCompatibilityDialog(confirmed, undefined, compatibilityFingerprint(system)),
    ).toBe(false);
    expect(confirmed.compatibility).toBe('unverified');
    expect(
      shouldOpenCompatibilityDialog(
        { ...system, compatibility: 'verified', compatibilityConfirmation: 'not-required' },
        undefined,
      ),
    ).toBe(false);
  });

  it('blocks dispatch and human answers while retaining interruption and diagnostic recovery', () => {
    for (const kind of ['create', 'fork', 'resume', 'send', 'steer', 'resolve']) {
      expect(operationNeedsCompatibilityConfirmation(kind, system)).toBe(true);
      expect(operationNeedsCompatibilityConfirmation(kind, { ...system, demo: true })).toBe(true);
      expect(
        operationNeedsCompatibilityConfirmation(kind, {
          ...system,
          compatibilityConfirmation: 'confirmed',
        }),
      ).toBe(false);
    }
    for (const kind of ['interrupt', 'reconcile', 'confirmCompatibility']) {
      expect(operationNeedsCompatibilityConfirmation(kind, system)).toBe(false);
    }
  });

  it('permits confirmation only for a ready authenticated runtime with a live connection', () => {
    expect(canConfirmCompatibility(system, 'connected', false)).toBe(true);
    expect(canConfirmCompatibility({ ...system, ready: false }, 'connected', false)).toBe(false);
    expect(canConfirmCompatibility({ ...system, authenticated: false }, 'connected', false)).toBe(
      false,
    );
    expect(canConfirmCompatibility({ ...system, authenticated: null }, 'connected', false)).toBe(
      false,
    );
    expect(canConfirmCompatibility({ ...system, codexVersion: null }, 'connected', false)).toBe(
      false,
    );
    expect(canConfirmCompatibility(system, 'disconnected', false)).toBe(false);
    expect(canConfirmCompatibility(system, 'connected', true)).toBe(false);
    expect(
      canConfirmCompatibility(
        { ...system, compatibilityConfirmation: 'confirmed' },
        'connected',
        false,
      ),
    ).toBe(false);
  });

  it('allows a fresh explicit decision after an uncertain receipt without reusing its operation ID', () => {
    const fingerprint = compatibilityFingerprint(system)!;
    const input = compatibilityConfirmationInput(fingerprint, { ...system }, 'connected', false);
    expect(input).toEqual({
      codexEpoch: system.codexEpoch,
      codexVersion: system.codexVersion,
      verifiedVersion: system.verifiedVersion,
      confirm: true,
    });
    // workspace.run allocates a new identity; stale receipts never become the authorization source.
    expect(input).not.toHaveProperty('clientOperationId');
    expect(
      compatibilityConfirmationInput(
        fingerprint,
        { ...system, compatibilityConfirmation: 'confirmed' },
        'connected',
        false,
      ),
    ).toBeUndefined();
  });

  it('does not authorize a restarted or unavailable runtime from a previously displayed warning', () => {
    const fingerprint = compatibilityFingerprint(system)!;
    expect(
      compatibilityConfirmationInput(
        fingerprint,
        { ...system, codexEpoch: 'new-runtime' },
        'connected',
        false,
      ),
    ).toBeUndefined();
    expect(
      compatibilityConfirmationInput(fingerprint, { ...system, ready: false }, 'connected', false),
    ).toBeUndefined();
    expect(
      compatibilityConfirmationInput(fingerprint, undefined, 'connected', false),
    ).toBeUndefined();
  });
});

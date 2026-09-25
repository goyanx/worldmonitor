/**
 * `VITE_DISABLE_AUTH=true` builds: no sign-in, no upsell, no client-side caps.
 *
 * A self-hosted stack has no Clerk, Convex or Dodo backend, so every "Sign in"
 * and "Upgrade to Pro" control in the browser leads nowhere. The flag removes
 * them. The rules below are what "removes them" has to mean, and each one is a
 * place where the honest answer differs from the default product:
 *
 *   - a premium panel with no data says NOT IMPLEMENTED, and offers no action,
 *     rather than asking for a payment that cannot be made here;
 *   - client-side-only takeaways (export, the dashboard tab cap) stop applying,
 *     because they exist to sell a plan that does not exist in this build;
 *   - a server denial is terminal rather than routed to an upsell.
 *
 * `vitest.dom.config.mts` pins the flag OFF for the rest of the suite, which
 * asserts the default product. These tests mock the module instead, so both
 * paths are covered in the same run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authDisabled = vi.hoisted(() => ({ value: true }));

vi.mock('@/config/auth-mode', () => ({
  isAuthDisabled: () => authDisabled.value,
  AUTH_DISABLED_UNAVAILABLE_COPY: 'NOT IMPLEMENTED',
  AUTH_DISABLED_UNAVAILABLE_DETAIL:
    'NOT IMPLEMENTED — this feed has no self-hosted data source configured.',
}));

vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({ present: false }),
}));

vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => null,
  isEntitlementActive: () => false,
  isEntitled: () => false,
}));

import { PanelGateReason, getPanelGateReason, hasPremiumAccess } from '@/services/panel-gating';
import {
  resolveAvailableExportFormats,
  resolveExportLock,
  resolveTabCap,
} from '@/services/gates/export-resolver';

/** A signed-out visitor on a stack with no entitlement backend. */
const ANON_SESSION = { user: null, isPending: false } as never;

/** The shape both export-resolver entry points take. */
const ANON_GATE_INPUT = {
  gateActive: true,
  desktopKeyPresent: false,
  authPending: false,
  signedIn: false,
  features: null,
  billingState: null,
} as never;

beforeEach(() => {
  authDisabled.value = true;
});

describe('premium panels in an auth-disabled build', () => {
  it('reports UNAVAILABLE rather than ANONYMOUS, so no sign-in CTA is reachable', () => {
    expect(getPanelGateReason(ANON_SESSION, true)).toBe(PanelGateReason.UNAVAILABLE);
  });

  it('still reports ANONYMOUS when the flag is off — the default product is unchanged', () => {
    authDisabled.value = false;
    expect(getPanelGateReason(ANON_SESSION, true)).toBe(PanelGateReason.ANONYMOUS);
  });

  it('leaves non-premium panels ungated either way', () => {
    expect(getPanelGateReason(ANON_SESSION, false)).toBe(PanelGateReason.NONE);
  });

  it('does not fabricate premium access — the server still decides what it serves', () => {
    // The flag removes the *upsell*, not the entitlement. A build that claimed
    // premium access here would send panels to fetch routes that 401, which is
    // how an empty panel turns into an error state instead of NOT IMPLEMENTED.
    expect(hasPremiumAccess(ANON_SESSION)).toBe(false);
  });
});

describe('client-side takeaways in an auth-disabled build', () => {
  it('does not lock data export', () => {
    expect(resolveExportLock(ANON_GATE_INPUT)).toBeNull();
  });

  it('offers every export format', () => {
    expect(resolveAvailableExportFormats(ANON_GATE_INPUT)).toEqual(
      expect.arrayContaining(['csv', 'json', 'pdf']),
    );
  });

  it('does not cap dashboard tabs, however many are already open', () => {
    expect(resolveTabCap(ANON_GATE_INPUT, 99)).toMatchObject({ allowed: true, cap: null });
  });

  it('restores the anonymous export lock and tab cap when the flag is off', () => {
    authDisabled.value = false;
    expect(resolveExportLock(ANON_GATE_INPUT)).toBe('anonymous');
    expect(resolveAvailableExportFormats(ANON_GATE_INPUT)).toEqual([]);
    expect(resolveTabCap(ANON_GATE_INPUT, 99)).toMatchObject({ allowed: false });
  });
});

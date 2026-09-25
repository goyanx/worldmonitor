/**
 * Build-time switch that turns off browser sign-in and premium gating.
 *
 * Set `VITE_DISABLE_AUTH=true` at build time for self-hosted or internal
 * deployments that have no Clerk / Convex / Dodo backend. With the flag on:
 *
 *   - Clerk never loads and the header Sign In / Create Account controls are
 *     not rendered, so the session settles as anonymous immediately.
 *   - Premium panels show a neutral "Data unavailable" state instead of
 *     Sign In / Upgrade CTAs. An operator `WORLDMONITOR_API_KEY` (or tester
 *     key) still unlocks them exactly as before.
 *   - Premium denials from the server render as unavailable, never as upsells.
 *   - Purely client-side Pro takeaways (data export, dashboard tab cap,
 *     historical playback) are not capped.
 *
 * Client-only by design: the server keeps enforcing API keys and entitlements,
 * so `/api/mcp` and every premium route still authenticate with the
 * `X-WorldMonitor-Key` header validated against `WORLDMONITOR_VALID_KEYS`.
 */

function readFlag(): boolean {
  try {
    const raw = import.meta.env.VITE_DISABLE_AUTH;
    return raw === 'true' || raw === '1';
  } catch {
    return false;
  }
}

const AUTH_DISABLED = readFlag();

export function isAuthDisabled(): boolean {
  return AUTH_DISABLED;
}

/**
 * Copy for a premium surface that cannot load in an auth-disabled build.
 * English literal, like the other self-host-only strings: this build has no
 * translated upsell copy to replace.
 *
 * Deliberately blunt rather than a soft "unavailable": in a self-hosted build
 * the panel is not withheld pending payment, the backing feed simply is not
 * wired up, and the label should say so.
 */
export const AUTH_DISABLED_UNAVAILABLE_COPY = 'NOT IMPLEMENTED';

/**
 * Longer form for surfaces with room for a sentence (panel bodies, export
 * menu). Names the reason so a self-hoster knows where to look.
 */
export const AUTH_DISABLED_UNAVAILABLE_DETAIL =
  'NOT IMPLEMENTED — this feed has no self-hosted data source configured.';

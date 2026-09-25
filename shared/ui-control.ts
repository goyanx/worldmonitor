/**
 * Remote dashboard control — the contract shared by the MCP tool, the bridge
 * endpoint and the browser applier.
 *
 * The dashboard already exposes ~33 UI actions (panels, map/globe, tabs,
 * search) as WebMCP tools. Those live in the PAGE: they are registered into
 * `navigator.modelContext`, which only exists when a WebMCP-capable agent host
 * runs inside the browser. An agent connected to `/mcp` over HTTP is a
 * different process on the other side of a network boundary and can never see
 * them.
 *
 * This is the missing hop. An MCP caller enqueues a command here; the open
 * dashboard polls for it, runs it through the SAME WebMCP handler the
 * in-browser path uses, and posts the result back. No UI behaviour is
 * reimplemented — the bridge only moves an intent across the process boundary.
 *
 * SECURITY. This lets a holder of the operator API key move a UI the user is
 * looking at, so:
 *   - It is off unless `WM_UI_REMOTE_CONTROL=true` (server) and the page was
 *     built with `VITE_UI_REMOTE_CONTROL=true` (browser). Both, not either.
 *   - Only the actions in `UI_CONTROL_ACTIONS` can cross. The allowlist is
 *     closed by construction: anything not named here is refused before it
 *     reaches the browser, so adding a WebMCP tool does not silently widen the
 *     remote surface.
 *   - Nothing that touches an account or destroys user data is on it. No
 *     sign-in, no tab deletion, no follow/unfollow.
 *   - Commands expire. A queue that nobody drains must not replay an hour of
 *     stale intent at the next dashboard that happens to open.
 */

/** Redis keys. Prefixed by `applyRedisKeyPrefix` at the call site, as usual. */
export const UI_CONTROL_QUEUE_KEY = 'ui-control:queue:v1';
export const UI_CONTROL_RESULT_PREFIX = 'ui-control:result:v1:';
export const UI_CONTROL_PRESENCE_KEY = 'ui-control:presence:v1';
/**
 * Input schemas for the allowlisted actions, published by the dashboard.
 *
 * The authoritative schemas live in the page (`src/services/webmcp.ts`), which
 * the API layer may not import. Rather than restate them here — where they would
 * drift silently, and did: `lat`/`lon` were documented as
 * `latitude`/`longitude` — the browser publishes what it actually accepts.
 */
export const UI_CONTROL_SCHEMAS_KEY = 'ui-control:schemas:v1';

/**
 * How long a queued command stays meaningful.
 *
 * Short on purpose. "Focus Iran" issued two minutes ago is a reasonable thing
 * to still apply; the same command surfacing after an hour, on a dashboard the
 * user has since navigated elsewhere, is a surprise rather than a service.
 */
export const UI_CONTROL_COMMAND_TTL_SECONDS = 120;

/** Result readback window — long enough for a caller to poll, short enough not to accumulate. */
export const UI_CONTROL_RESULT_TTL_SECONDS = 300;

/** How long a dashboard poll counts as "a dashboard is open". */
export const UI_CONTROL_PRESENCE_TTL_SECONDS = 30;

/**
 * Queue ceiling. A caller scripting a loop against an unattended stack would
 * otherwise grow this without bound; the browser drains one poll at a time.
 */
export const UI_CONTROL_MAX_QUEUE = 32;

/** Commands handed to the browser in one poll. */
export const UI_CONTROL_POLL_BATCH = 8;

/**
 * Actions permitted to cross the bridge, mapped to the WebMCP tool that runs
 * them (`src/config/webmcp.ts::WEBMCP_SPA_TOOL`).
 *
 * Deliberately a subset of what the page can do. Excluded, and why:
 *   - `open_sign_in`, `get_access_context` — account surface, and meaningless
 *     in an auth-disabled build.
 *   - `set_country_followed` — mutates a user preference that outlives the
 *     session; a remote caller should not edit someone's follow list.
 *   - `delete_dashboard_tab`, `rename_dashboard_tab`, `create_dashboard_tab` —
 *     destroy or restructure saved layout. Selecting a tab is reversible in one
 *     click; deleting one is not.
 */
export const UI_CONTROL_ACTIONS = Object.freeze({
  // Map and globe
  set_map_view: 'set_map_view',
  set_map_layers: 'set_map_layers',
  set_map_mode: 'set_map_mode',
  focus_country: 'focus_country',
  set_time_range: 'set_time_range',
  list_map_layers: 'list_map_layers',
  // Panels
  open_dashboard_panel: 'open_dashboard_panel',
  set_panel_enabled: 'set_panel_enabled',
  set_panel_collapsed: 'set_panel_collapsed',
  set_panel_fullscreen: 'set_panel_fullscreen',
  move_panel: 'move_panel',
  get_panel_layout: 'get_panel_layout',
  list_dashboard_panels: 'list_dashboard_panels',
  // Tabs and navigation
  list_dashboard_tabs: 'list_dashboard_tabs',
  select_dashboard_tab: 'select_dashboard_tab',
  switch_monitor: 'switch_monitor',
  open_country_brief: 'openCountryBrief',
  open_settings: 'open_settings',
  open_alerts: 'open_alerts',
  // Missions and search
  list_mission_presets: 'list_mission_presets',
  apply_mission_preset: 'apply_mission_preset',
  search_dashboard: 'search_dashboard',
  // Read-back
  get_dashboard_context: 'get_dashboard_context',
} as const);

export type UiControlAction = keyof typeof UI_CONTROL_ACTIONS;

export const UI_CONTROL_ACTION_NAMES = Object.keys(UI_CONTROL_ACTIONS) as UiControlAction[];

/** Actions that only read — safe to call without changing what the user sees. */
export const UI_CONTROL_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'get_dashboard_context',
  'get_panel_layout',
  'list_map_layers',
  'list_dashboard_panels',
  'list_dashboard_tabs',
  'list_mission_presets',
  'search_dashboard',
]);

export function isUiControlAction(value: unknown): value is UiControlAction {
  // Prototype-safe lookup without Object.hasOwn: this module is compiled
  // against the repo's shared lib target, which predates it.
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(UI_CONTROL_ACTIONS, value);
}

export interface UiControlCommand {
  id: string;
  action: UiControlAction;
  /** Forwarded verbatim to the WebMCP tool's `execute`. */
  args: Record<string, unknown>;
  /** Epoch ms. The browser drops anything older than the TTL. */
  issuedAt: number;
}

export interface UiControlResult {
  id: string;
  action: string;
  ok: boolean;
  /** Whatever the WebMCP tool returned, or an error description. */
  result?: unknown;
  error?: string;
  completedAt: number;
}

/** Has this command outlived its usefulness? */
export function isCommandExpired(command: UiControlCommand, now = Date.now()): boolean {
  return now - command.issuedAt > UI_CONTROL_COMMAND_TTL_SECONDS * 1000;
}

/**
 * Parse and validate one queued entry.
 *
 * Returns null rather than throwing: a malformed entry is something to drop and
 * carry on from, not a reason to stall the whole queue. The browser is the
 * party that must never crash here.
 */
export function parseUiControlCommand(raw: unknown): UiControlCommand | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id) return null;
  if (!isUiControlAction(c.action)) return null;
  if (typeof c.issuedAt !== 'number' || !Number.isFinite(c.issuedAt)) return null;
  const args = c.args;
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) return null;
  return {
    id: c.id,
    action: c.action,
    args: (args as Record<string, unknown> | undefined) ?? {},
    issuedAt: c.issuedAt,
  };
}

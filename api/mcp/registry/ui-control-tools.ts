/**
 * Remote dashboard control — the MCP half of the bridge.
 *
 * Every other tool in this registry reads data. These two reach across into a
 * browser the user has open and move its interface, which makes them the first
 * tools here with `readOnlyHint: false`. That is not a technicality: a caller
 * that treats them as reads will surprise someone watching the screen.
 *
 * The actions themselves are not implemented here. The dashboard already has
 * ~33 WebMCP handlers for panels, map/globe, tabs and search; `control_dashboard`
 * only carries an intent across the process boundary to them. See
 * `shared/ui-control.ts` for the allowlist and the reasoning behind it.
 *
 * Disabled unless `WM_UI_REMOTE_CONTROL=true` on the server AND the page was
 * built with `VITE_UI_REMOTE_CONTROL=true`. Both halves, because either one
 * alone is a queue nobody drains.
 */

import { buildAuthHeaders } from '../auth';
import { fetchMcpDownstream } from '../downstream';
import { assertToolFetchOk } from '../billing-denial';
import {
  UI_CONTROL_ACTION_NAMES,
  UI_CONTROL_READ_ONLY_ACTIONS,
  UI_CONTROL_RESULT_PREFIX,
} from '../../../shared/ui-control';
import { readJsonFromUpstash } from '../../_upstash-json.js';
import type { McpAuthContext, McpToolExecutionContext, ToolDef } from '../types';

const BRIDGE_PATH = '/api/ui-control/bridge';

/** Longest a caller may ask us to wait for the browser to finish. */
const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 5_000;
/** How often to re-read the result key while waiting. */
const POLL_INTERVAL_MS = 400;

// `execution` is required-but-nullable, matching fetchMcpDownstream itself. An
// optional parameter here would let a caller omit it and silently drop the
// loopback transport token — see tests/mcp-registry-downstream.test.mjs.
async function postBridge(
  body: Record<string, unknown>,
  base: string,
  context: McpAuthContext,
  execution: McpToolExecutionContext | undefined,
): Promise<Record<string, unknown>> {
  const url = `${base}${BRIDGE_PATH}`;
  const payload = JSON.stringify(body);
  const auth = await buildAuthHeaders(context, 'POST', url, payload);
  const response = await fetchMcpDownstream(url, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  }, execution);
  await assertToolFetchOk(response, 'ui-control');
  return response.json() as Promise<Record<string, unknown>>;
}

export const CONTROL_DASHBOARD_TOOL: ToolDef = {
  name: 'control_dashboard',
  _outputBudgetBytes: 32768,
  description: 'Drive the open WorldMonitor dashboard: map view and layers, globe/flat mode, panels, tabs, missions, search. Queues one action for the browser to run and returns what it did. Requires a dashboard to be open with remote control enabled.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...UI_CONTROL_ACTION_NAMES],
        description: 'The UI action to run. Read-only actions (get_dashboard_context, get_panel_layout, list_*, search_dashboard) inspect without changing anything; the rest alter what the user sees.',
      },
      args: {
        type: 'object',
        description: 'Arguments for the action, passed through unchanged. Call get_dashboard_control_status for the exact input schema of every action — the dashboard publishes what it actually accepts, so do not guess argument names.',
        additionalProperties: true,
      },
      wait_ms: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_WAIT_MS,
        description: `How long to wait for the browser's result, in ms. Default ${DEFAULT_WAIT_MS}. 0 queues and returns immediately — use it for fire-and-forget, but then you learn nothing about whether it worked.`,
      },
    },
    required: ['action'],
  },
  outputSchema: {
    type: 'object',
    required: ['queued', 'action'],
    properties: {
      queued: { type: 'boolean', description: 'The command reached the queue.' },
      action: { type: 'string' },
      id: { type: 'string', description: 'Command id, for correlating a later result.' },
      dashboardOpen: { type: 'boolean', description: 'Whether a dashboard polled recently. False means nothing is listening.' },
      completed: { type: 'boolean', description: 'The browser reported back within wait_ms.' },
      ok: { type: 'boolean', description: 'The action succeeded in the browser. Absent when not completed.' },
      result: { description: 'Whatever the dashboard action returned.' },
      error: { type: 'string', description: 'Why the action failed in the browser.' },
      readOnly: { type: 'boolean', description: 'True when this action only inspects the UI.' },
      warning: { type: 'string' },
    },
  },
  // NOT read-only: this is the first tool in the registry that mutates
  // user-visible state. destructiveHint stays false because the allowlist
  // excludes anything that deletes or overwrites saved work — the worst case is
  // a view the user can change back. Not idempotent: replaying `move_panel`
  // moves it again. openWorld because the outcome depends on a browser session
  // this server does not own.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const action = typeof params.action === 'string' ? params.action : '';
    if (!UI_CONTROL_ACTION_NAMES.includes(action as never)) {
      return { queued: false, action, error: 'unknown action', available: UI_CONTROL_ACTION_NAMES };
    }
    const args = (params.args && typeof params.args === 'object' && !Array.isArray(params.args))
      ? params.args as Record<string, unknown>
      : {};
    const waitMs = Number.isInteger(params.wait_ms)
      ? Math.min(Math.max(params.wait_ms as number, 0), MAX_WAIT_MS)
      : DEFAULT_WAIT_MS;

    const queued = await postBridge({ op: 'enqueue', action, args }, base, context, execution);
    const readOnly = UI_CONTROL_READ_ONLY_ACTIONS.has(action);
    const id = typeof queued.id === 'string' ? queued.id : '';
    const head = {
      queued: queued.ok === true,
      action,
      id,
      dashboardOpen: queued.dashboardOpen === true,
      readOnly,
      ...(typeof queued.warning === 'string' ? { warning: queued.warning } : {}),
    };
    if (!head.queued || !id || waitMs === 0) return { ...head, completed: false };

    // Poll the result key rather than holding a socket open through the bridge:
    // the browser may take a moment to reach its next poll, and a long-held
    // connection would be the first thing an edge timeout kills.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const stored = await readJsonFromUpstash(`${UI_CONTROL_RESULT_PREFIX}${id}`).catch(() => null);
      if (stored && typeof stored === 'object') {
        const r = stored as Record<string, unknown>;
        // Two different "ok"s meet here. `r.ok` says the handler did not
        // throw; the handler's own payload says whether the ACTION was
        // accepted — a rejected argument comes back as a structured
        // {ok:false, reason} rather than an exception. Reporting only the
        // outer one would tell a caller its command succeeded when the
        // dashboard had refused it.
        const inner = (r.result && typeof r.result === 'object')
          ? r.result as Record<string, unknown>
          : null;
        const actionRejected = inner?.ok === false;
        return {
          ...head,
          completed: true,
          ok: r.ok === true && !actionRejected,
          ...(r.result === undefined ? {} : { result: r.result }),
          ...(typeof r.error === 'string' ? { error: r.error } : {}),
          ...(actionRejected && typeof inner?.message === 'string'
            ? { error: inner.message as string }
            : {}),
        };
      }
    }
    return {
      ...head,
      completed: false,
      warning: head.dashboardOpen
        ? 'Queued, but the dashboard did not report back in time. It may still run.'
        : 'No dashboard has polled recently — the command is queued but may never run.',
    };
  },
  // The bridge is an internal transport, not a published REST operation, so it
  // is deliberately absent from the OpenAPI spec and this stays empty. See the
  // RpcToolDef._apiPaths contract, case (a).
  _apiPaths: [],
};

export const DASHBOARD_CONTROL_STATUS_TOOL: ToolDef = {
  name: 'get_dashboard_control_status',
  _outputBudgetBytes: 4096,
  description: 'Whether a WorldMonitor dashboard is currently listening for remote control commands, and the catalog of actions it accepts. Call this before control_dashboard to avoid queueing into an empty room.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: {
    type: 'object',
    required: ['enabled', 'actions'],
    properties: {
      enabled: { type: 'boolean', description: 'Remote control is switched on server-side.' },
      dashboardOpen: { type: 'boolean', description: 'A dashboard polled within the presence window.' },
      actions: { type: 'array', items: { type: 'string' } },
      readOnlyActions: { type: 'array', items: { type: 'string' } },
      schemas: { type: 'object', description: 'Per-action JSON Schema, published by the open dashboard. Authoritative — use it instead of guessing argument names.', additionalProperties: true },
      hint: { type: 'string' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _execute: async (_params, base, context, execution) => {
    // A no-op poll would consume queued commands the browser should get, so ask
    // by enqueuing nothing: the bridge reports presence on an unknown op too.
    let enabled = true;
    let dashboardOpen = false;
    let schemas: Record<string, unknown> | null = null;
    try {
      const status = await postBridge({ op: 'status' }, base, context, execution);
      dashboardOpen = status.dashboardOpen === true;
      if (status.schemas && typeof status.schemas === 'object') {
        schemas = status.schemas as Record<string, unknown>;
      }
    } catch {
      enabled = false;
    }
    return {
      enabled,
      dashboardOpen,
      actions: UI_CONTROL_ACTION_NAMES,
      readOnlyActions: [...UI_CONTROL_READ_ONLY_ACTIONS],
      ...(schemas ? { schemas } : {}),
      ...(enabled
        ? {}
        : { hint: 'Set WM_UI_REMOTE_CONTROL=true and rebuild with VITE_UI_REMOTE_CONTROL=true.' }),
    };
  },
  _apiPaths: [],
};

export const UI_CONTROL_TOOLS: ToolDef[] = [CONTROL_DASHBOARD_TOOL, DASHBOARD_CONTROL_STATUS_TOOL];

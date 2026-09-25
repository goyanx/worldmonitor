/**
 * Browser half of the remote dashboard-control bridge.
 *
 * The dashboard's UI actions already exist as WebMCP tools, reachable only by an
 * agent running inside this page. This poller lets an agent on the other side of
 * `/mcp` reach the same handlers: it drains commands the MCP tool queued, runs
 * each one through `buildWebMcpTools`, and posts the result back.
 *
 * It reuses `buildWebMcpTools` rather than re-deriving anything. That function
 * is what `registerWebMcpTools` hands to `navigator.modelContext`, so the remote
 * path and the in-browser path execute byte-identical handlers — including their
 * validation, their gating and their abort semantics. A second implementation
 * would drift on the first change to either.
 *
 * Off unless the page was built with `VITE_UI_REMOTE_CONTROL=true`. The server
 * must also set `WM_UI_REMOTE_CONTROL=true`; with only one of the two the
 * bridge answers 503 and this backs off to its idle cadence forever, which is
 * the intended inert state rather than an error worth surfacing.
 */

import {
  UI_CONTROL_ACTIONS,
  isCommandExpired,
  type UiControlCommand,
} from '../../shared/ui-control';
import type { UiControlAction } from '../../shared/ui-control';
import { buildWebMcpTools, type WebMcpAppBindings } from '@/services/webmcp';

/** Cadence while a dashboard is idle and nothing is queued. */
const IDLE_POLL_MS = 2_000;
/** Cadence just after work arrives — an agent issuing a sequence should not wait 2s per step. */
const ACTIVE_POLL_MS = 400;
/** How long to stay on the fast cadence after the last command. */
const ACTIVE_WINDOW_MS = 10_000;
/** Backoff ceiling after repeated transport failures. */
const MAX_BACKOFF_MS = 30_000;
/** A single UI action may not hang the poll loop. */
const ACTION_TIMEOUT_MS = 20_000;

const BRIDGE_URL = '/api/ui-control/bridge';

function remoteControlEnabled(): boolean {
  try {
    const raw = import.meta.env.VITE_UI_REMOTE_CONTROL;
    return raw === 'true' || raw === '1';
  } catch {
    return false;
  }
}

async function postBridge(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Same-origin only. This endpoint must never be reachable cross-origin
      // with credentials attached.
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Run one command through the WebMCP handler that owns it.
 *
 * Errors are captured and reported, never thrown: a failing action must ack so
 * the waiting MCP caller learns what happened instead of timing out blind.
 */
async function runCommand(
  command: UiControlCommand,
  tools: ReturnType<typeof buildWebMcpTools>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const toolName = UI_CONTROL_ACTIONS[command.action];
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return { ok: false, error: `no handler for ${command.action}` };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ACTION_TIMEOUT_MS);
  try {
    const result = await tool.execute(command.args, { signal: abort.signal });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start polling. Returns a stop function, or null when the feature is off.
 *
 * `bindings` is the same object `registerWebMcpTools` receives; it may be a
 * promise that settles once the app has mounted.
 */
export function startRemoteUiControl(
  bindings: WebMcpAppBindings | Promise<WebMcpAppBindings>,
): (() => void) | null {
  if (!remoteControlEnabled()) return null;
  if (typeof fetch !== 'function') return null;

  const controller = new AbortController();
  const tools = buildWebMcpTools(bindings);
  let failures = 0;
  let lastCommandAt = 0;
  // Published once, on the first successful poll. The MCP side cannot import
  // this module's schemas — api/ may not reach into src/ — so the only way an
  // agent learns that set_map_view takes `lat`/`lon` rather than
  // `latitude`/`longitude` is for the page to say so.
  let schemasPublished = false;

  const actionSchemas = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [action, toolName] of Object.entries(UI_CONTROL_ACTIONS)) {
      const tool = tools.find((t) => t.name === toolName);
      if (tool?.inputSchema) out[action as UiControlAction] = tool.inputSchema;
    }
    return out;
  };

  const nextDelay = (): number => {
    if (failures > 0) {
      // Exponential, capped. A stack whose bridge is disabled sits here quietly.
      return Math.min(IDLE_POLL_MS * 2 ** Math.min(failures, 5), MAX_BACKOFF_MS);
    }
    return Date.now() - lastCommandAt < ACTIVE_WINDOW_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  };

  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, nextDelay()));
      if (controller.signal.aborted) return;

      // A hidden tab should not keep claiming commands: it would drain them away
      // from a visible dashboard the user is actually watching.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') continue;

      const response = await postBridge({
        op: 'poll',
        ...(schemasPublished ? {} : { schemas: actionSchemas() }),
      });
      if (!response) { failures += 1; continue; }
      failures = 0;
      schemasPublished = true;

      const commands = Array.isArray(response.commands) ? response.commands : [];
      if (commands.length === 0) continue;
      lastCommandAt = Date.now();

      for (const entry of commands as UiControlCommand[]) {
        if (controller.signal.aborted) return;
        // Re-check expiry here as well as server-side: the command may have sat
        // in this batch while earlier ones ran.
        if (isCommandExpired(entry)) {
          await postBridge({ op: 'ack', id: entry.id, action: entry.action, ok: false, error: 'expired' });
          continue;
        }
        const outcome = await runCommand(entry, tools);
        await postBridge({
          op: 'ack',
          id: entry.id,
          action: entry.action,
          ok: outcome.ok,
          ...(outcome.result === undefined ? {} : { result: outcome.result }),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        });
      }
    }
  };

  void loop();
  return () => controller.abort();
}

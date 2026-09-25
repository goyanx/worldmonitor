/**
 * Server↔browser bridge for remote dashboard control.
 *
 * Three operations on one route, selected by the `op` field. They have
 * different callers and different trust, which is the whole reason the split
 * matters:
 *
 *   enqueue — the MCP tool. Authenticated with the operator API key. Pushes a
 *             validated command onto the queue.
 *   poll    — the open dashboard, same-origin. Drains the queue and renews the
 *             presence marker.
 *   ack     — the open dashboard. Publishes a result the MCP caller can read.
 *
 * `poll` and `ack` are deliberately NOT key-authenticated. The browser has no
 * operator key and must never be given one; its authority is that it is the
 * dashboard the user already has open. That does mean anyone who can reach this
 * origin can drain the queue — which is why the whole feature is off unless
 * `WM_UI_REMOTE_CONTROL=true`, and why it is documented as a trusted-network
 * feature for a self-hosted stack rather than something to expose publicly.
 *
 * Draining is destructive by design: a command is delivered to exactly one
 * poller. Two dashboards open means each gets a share, not a copy. Broadcast
 * would mean "focus Iran" firing twice and no way to report which one the
 * caller meant.
 */

import {
  UI_CONTROL_MAX_QUEUE,
  UI_CONTROL_POLL_BATCH,
  UI_CONTROL_PRESENCE_KEY,
  UI_CONTROL_PRESENCE_TTL_SECONDS,
  UI_CONTROL_QUEUE_KEY,
  UI_CONTROL_RESULT_PREFIX,
  UI_CONTROL_RESULT_TTL_SECONDS,
  UI_CONTROL_SCHEMAS_KEY,
  isCommandExpired,
  isUiControlAction,
  parseUiControlCommand,
  type UiControlCommand,
  type UiControlResult,
} from '../../shared/ui-control';
import { redisPipeline, setCachedData, readJsonFromUpstash } from '../_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../_api-key.js';

export const config = { runtime: 'edge' };

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Cap the body: a command is a few hundred bytes, never a payload. */
const MAX_BODY_BYTES = 16_384;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Is remote control switched on?
 *
 * Fails CLOSED and says so explicitly rather than 404ing, because "the feature
 * is off" and "you got the URL wrong" are very different things to debug.
 */
function remoteControlEnabled(): boolean {
  return process.env.WM_UI_REMOTE_CONTROL === 'true';
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }
  if (!remoteControlEnabled()) {
    return json({
      error: 'Remote dashboard control is disabled.',
      hint: 'Set WM_UI_REMOTE_CONTROL=true on the server and rebuild the frontend with VITE_UI_REMOTE_CONTROL=true.',
    }, 503);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  switch (body.op) {
    case 'enqueue': return enqueue(req, body);
    case 'poll': return poll(body);
    case 'ack': return ack(body);
    case 'status': return status();
    default:
      return json({ error: 'unknown op', expected: ['enqueue', 'poll', 'ack', 'status'] }, 400);
  }
}

/** MCP side: validate, then queue. */
async function enqueue(req: Request, body: Record<string, unknown>): Promise<Response> {
  const auth = await validateApiKey(req, { forceKey: true });
  if (!auth?.valid) {
    return json({ error: 'API key required', detail: auth?.error ?? null }, 401);
  }

  const action = body.action;
  if (!isUiControlAction(action)) {
    return json({ error: 'unknown or disallowed action', action: String(action ?? '') }, 400);
  }
  const args = body.args;
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return json({ error: 'args must be an object' }, 400);
  }

  const command: UiControlCommand = {
    id: crypto.randomUUID(),
    action,
    args: (args as Record<string, unknown> | undefined) ?? {},
    issuedAt: Date.now(),
  };

  // LTRIM after LPUSH bounds the queue at the head, so a flood drops the OLDEST
  // pending commands rather than rejecting the newest. The most recent intent is
  // the one worth keeping.
  const results = await redisPipeline([
    ['LPUSH', UI_CONTROL_QUEUE_KEY, JSON.stringify(command)],
    ['LTRIM', UI_CONTROL_QUEUE_KEY, '0', String(UI_CONTROL_MAX_QUEUE - 1)],
    ['EXPIRE', UI_CONTROL_QUEUE_KEY, String(UI_CONTROL_RESULT_TTL_SECONDS)],
  ]);
  if (results === null) return json({ error: 'queue write failed' }, 502);

  // Tell the caller whether anything is actually listening. Queuing into an
  // empty room succeeds at the storage layer and still achieves nothing, and an
  // agent that cannot tell those apart will report success for a no-op.
  const presence = await readJsonFromUpstash(UI_CONTROL_PRESENCE_KEY).catch(() => null);
  const dashboardOpen = presence !== null && presence !== undefined;

  return json({
    ok: true,
    id: command.id,
    action: command.action,
    dashboardOpen,
    ...(dashboardOpen ? {} : {
      warning: 'No dashboard has polled recently — the command is queued but may never run.',
    }),
  });
}

/** Browser side: drain up to a batch, renewing presence. */
async function poll(body: Record<string, unknown>): Promise<Response> {
  // The dashboard publishes the schemas it actually accepts on its first poll
  // (and whenever they change). Stored with a generous TTL so `status` can
  // answer even during a brief gap between dashboards.
  if (body.schemas && typeof body.schemas === 'object') {
    await setCachedData(UI_CONTROL_SCHEMAS_KEY, body.schemas, 3600).catch(() => false);
  }

  // RPOP takes from the tail, so commands run oldest-first even though LPUSH
  // writes at the head.
  const commands: UiControlCommand[] = [];
  const pipeline = Array.from({ length: UI_CONTROL_POLL_BATCH }, () => ['RPOP', UI_CONTROL_QUEUE_KEY]);
  const results = await redisPipeline([
    ...pipeline,
    ['SET', UI_CONTROL_PRESENCE_KEY, String(Date.now()), 'EX', String(UI_CONTROL_PRESENCE_TTL_SECONDS)],
  ]);
  if (results === null) return json({ commands: [] });

  const now = Date.now();
  let expired = 0;
  for (const entry of results.slice(0, UI_CONTROL_POLL_BATCH)) {
    const value = (entry as { result?: unknown })?.result ?? entry;
    if (value === null || value === undefined) continue;
    const command = parseUiControlCommand(value);
    // A malformed entry is dropped, not retried — see parseUiControlCommand.
    if (!command) continue;
    if (isCommandExpired(command, now)) { expired += 1; continue; }
    commands.push(command);
  }

  return json({ commands, ...(expired ? { expired } : {}) });
}

/**
 * Is anyone listening?
 *
 * Deliberately NOT a poll: asking "is a dashboard there" must not consume the
 * commands that dashboard is meant to receive.
 */
async function status(): Promise<Response> {
  const [presence, schemas] = await Promise.all([
    readJsonFromUpstash(UI_CONTROL_PRESENCE_KEY).catch(() => null),
    readJsonFromUpstash(UI_CONTROL_SCHEMAS_KEY).catch(() => null),
  ]);
  return json({
    enabled: true,
    dashboardOpen: presence !== null && presence !== undefined,
    ...(schemas && typeof schemas === 'object' ? { schemas } : {}),
  });
}

/** Browser side: publish a result for the MCP caller to read. */
async function ack(body: Record<string, unknown>): Promise<Response> {
  const id = body.id;
  if (typeof id !== 'string' || !id) return json({ error: 'id required' }, 400);

  const result: UiControlResult = {
    id,
    action: typeof body.action === 'string' ? body.action : 'unknown',
    ok: body.ok === true,
    ...(body.result === undefined ? {} : { result: body.result }),
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
    completedAt: Date.now(),
  };

  const written = await setCachedData(
    `${UI_CONTROL_RESULT_PREFIX}${id}`,
    result,
    UI_CONTROL_RESULT_TTL_SECONDS,
  );
  return written ? json({ ok: true }) : json({ error: 'result write failed' }, 502);
}

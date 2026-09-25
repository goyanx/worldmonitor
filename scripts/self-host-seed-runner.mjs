#!/usr/bin/env node

/**
 * Self-hosted ingestion scheduler.
 *
 * The Docker image ships nginx + the local API server, and nothing else. The
 * dashboard reads every panel out of Redis, and on Railway that Redis is filled
 * by dozens of independent seed services on their own crons. A self-hosted
 * stack has none of them, so Redis stays empty and effectively every panel
 * renders as having no data — which reads like a broken build rather than a
 * missing ingestion tier.
 *
 * This runs the subset of those services that need no vendor credentials: they
 * pull from free public APIs (USGS, GDELT, ECB, Eurostat, IMF, World Bank,
 * Ember, and friends) straight into the local Redis. No paid subscription and
 * no upstream WorldMonitor account is involved — the deployment becomes its own
 * data source.
 *
 * `scripts/railway-services.json` is the single source of truth for which
 * services exist, what each one needs, and how often it runs. Selection is
 * derived from it rather than hand-listed here, so a new seeder is picked up
 * without editing this file, and one that grows a credential requirement drops
 * out on its own.
 *
 * Opt-in: set WM_SELF_HOST_SEEDING=true. Off by default so an operator who
 * points the image at a Redis someone else is already seeding does not get two
 * writers racing on the same keys.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const REGISTRY = join(HERE, 'railway-services.json');

/**
 * Supplied by the container, not by the seeder's own credentials. A service
 * asking only for these is asking for the Redis it is about to write to.
 */
const REDIS_ENV = new Set([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'REDIS_URL',
  'REDIS_TOKEN',
]);

/**
 * Long-running queue consumers, not cron seeders. They need Convex and an LLM
 * provider to do anything, and they never terminate, so the sequential runner
 * below would stall on the first one.
 */
const NOT_SEEDERS = new Set(['deep-forecast-worker', 'scenario-worker', 'simulation-worker']);

/** Cadence for a registry entry that declares no cron. */
const DEFAULT_INTERVAL_MIN = 360;

/** A single seeder may not hold the queue forever. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function log(...args) {
  console.log(`[self-host-seed ${new Date().toISOString()}]`, ...args);
}

/**
 * Match one cron field against a value.
 *
 * Deliberately partial: it covers `*`, step, comma-list and plain-number
 * forms, which is every form the registry actually uses. Anything else is
 * rejected by isCronSupported and the caller falls back to the default
 * interval — a seeder running on a misparsed schedule is worse than one
 * running on a conservative fixed cadence.
 */
function matchCronField(field, value) {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    return /^\d+$/.test(part) && Number(part) === value;
  });
}

function isCronSupported(schedule) {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => f === '*' || /^(\d+|\*\/\d+)(,(\d+|\*\/\d+))*$/.test(f));
}

function cronMatches(schedule, date) {
  const [min, hour, dom, mon, dow] = schedule.trim().split(/\s+/);
  return (
    matchCronField(min, date.getUTCMinutes())
    && matchCronField(hour, date.getUTCHours())
    && matchCronField(dom, date.getUTCDate())
    && matchCronField(mon, date.getUTCMonth() + 1)
    && matchCronField(dow, date.getUTCDay())
  );
}

/** Registry entries this container can actually run. */
function selectRunnable(registry) {
  const seen = new Set();
  const selected = [];
  const skipped = [];

  for (const svc of registry) {
    const entry = svc.entry ?? '';
    if (!entry.startsWith('scripts/seed-') || !entry.endsWith('.mjs')) continue;
    if (NOT_SEEDERS.has(svc.service)) continue;
    // The registry lists a couple of services twice (one row per cron arm).
    if (seen.has(entry)) continue;
    seen.add(entry);

    const missing = (svc.requiredEnv ?? [])
      .filter((name) => !REDIS_ENV.has(name))
      .filter((name) => !process.env[name]);
    if (missing.length > 0) {
      skipped.push({ service: svc.service, missing });
      continue;
    }

    const schedule = svc.cronSchedule && isCronSupported(svc.cronSchedule) ? svc.cronSchedule : null;
    selected.push({
      service: svc.service,
      entry,
      schedule,
      intervalMin: schedule ? null : DEFAULT_INTERVAL_MIN,
      lastRunMs: 0,
    });
  }

  return { selected, skipped };
}

function runSeeder(task) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(REPO_ROOT, task.entry)], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tail = '';
    const capture = (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      log(`${task.service}: TIMEOUT after ${RUN_TIMEOUT_MS / 1000}s, killing`);
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) {
        log(`${task.service}: ok (${secs}s)`);
      } else {
        // A failing upstream is normal and self-correcting — the next tick
        // retries. Log the tail so it is diagnosable without being fatal.
        log(`${task.service}: exit ${code} (${secs}s)\n${tail.trim()}`);
      }
      resolveRun();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`${task.service}: spawn failed — ${err.message}`);
      resolveRun();
    });
  });
}

function isDue(task, now) {
  if (task.schedule) return cronMatches(task.schedule, now);
  return now.getTime() - task.lastRunMs >= task.intervalMin * 60 * 1000;
}

async function main() {
  if (process.env.WM_SELF_HOST_SEEDING !== 'true') {
    log('WM_SELF_HOST_SEEDING is not "true" — self-hosted ingestion disabled, exiting.');
    return;
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    log('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are required. Exiting.');
    process.exitCode = 1;
    return;
  }

  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const { selected, skipped } = selectRunnable(registry);

  log(`${selected.length} credential-free seeders selected, ${skipped.length} skipped.`);
  for (const task of selected) {
    log(`  run  ${task.service.padEnd(36)} ${task.schedule ?? `every ${task.intervalMin}m`}`);
  }
  for (const s of skipped) {
    log(`  skip ${s.service.padEnd(36)} needs ${s.missing.join(', ')}`);
  }
  if (selected.length === 0) return;

  // Cold start: a fresh container has an empty Redis and every panel is blank,
  // so fill once immediately instead of waiting out each cron.
  log('Initial pass — filling an empty Redis.');
  for (const task of selected) {
    await runSeeder(task);
    task.lastRunMs = Date.now();
  }
  log('Initial pass complete.');

  // One tick per minute, sequential so a self-hosted box is never running a
  // dozen feed fetches at once.
  for (;;) {
    const now = new Date();
    await new Promise((r) => setTimeout(r, (60 - now.getUTCSeconds()) * 1000));

    const tick = new Date();
    for (const task of selected) {
      if (!isDue(task, tick)) continue;
      await runSeeder(task);
      task.lastRunMs = Date.now();
    }
  }
}

main().catch((err) => {
  log('fatal:', err?.stack ?? err);
  process.exitCode = 1;
});

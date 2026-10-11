import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { readJsonFromUpstash } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const REDIS_KEY = 'maritime:vessels-from-news:v1';

let cached = null;
let cachedAt = 0;
const CACHE_TTL = 300_000;

let negUntil = 0;
const NEG_TTL = 60_000;

const THREAT_LEVELS = new Set(['critical', 'high', 'medium', 'low']);

// Keep only what the map reads, and drop any record without a usable position:
// a marker at a defaulted 0,0 would claim a ship in the Gulf of Guinea.
export function toWebVessel(vessel) {
  if (!vessel || !Number.isFinite(vessel.lat) || !Number.isFinite(vessel.lon)) return null;
  if (Math.abs(vessel.lat) > 90 || Math.abs(vessel.lon) > 180) return null;
  return {
    id: String(vessel.id ?? ''),
    name: String(vessel.name ?? ''),
    lat: vessel.lat,
    lon: vessel.lon,
    location: String(vessel.port ?? ''),
    threatLevel: THREAT_LEVELS.has(vessel.threat_level) ? vessel.threat_level : 'low',
    articleTitle: String(vessel.article_title ?? ''),
    articleUrl: String(vessel.article_url ?? ''),
    reportedAt: Number.isFinite(vessel.article_ts) ? vessel.article_ts : 0,
  };
}

async function fetchVessels() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;
  if (now < negUntil) return null;

  let raw;
  // Seeder-owned key: scripts/seed-maritime-vessels-from-news.mjs publishes it bare.
  try { raw = await readJsonFromUpstash(REDIS_KEY, 3_000, true); } catch { raw = null; }

  if (!Array.isArray(raw)) {
    negUntil = now + NEG_TTL;
    return null;
  }

  cached = { vessels: raw.map(toWebVessel).filter(Boolean) };
  cachedAt = now;
  return cached;
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }

  const publicCorsHeaders = getPublicCorsHeaders('GET, OPTIONS');

  const data = await fetchVessels();

  if (!data) {
    return jsonResponse(
      { error: 'Vessel news data temporarily unavailable' },
      503,
      { 'Cache-Control': 'no-cache, no-store', ...corsHeaders },
    );
  }

  return jsonResponse(
    data,
    200,
    {
      'Cache-Control': 's-maxage=300, stale-while-revalidate=300, stale-if-error=3600',
      ...publicCorsHeaders,
    },
  );
}

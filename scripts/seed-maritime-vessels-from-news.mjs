#!/usr/bin/env node

/**
 * Extract vessel positions from GMA News RSS and populate
 * the maritime:vessels-from-news:v1 Redis key for map visualization.
 *
 * Fetches GMA News RSS feed, filters for maritime keywords, extracts lat/lon
 * from a port lookup table, and stores vessel markers for the map layer.
 *
 * Redis keys written:
 *   maritime:vessels-from-news:v1       — JSON array of vessel records
 *   seed-meta:maritime:vessels-from-news — Freshness metadata
 *
 * @notification-source: none (this seeder does not publish notifications)
 */

import {
  loadEnvFile,
  readCanonicalValue,
  runSeed,
} from './_seed-utils.mjs';
import { decodeHtmlEntities } from './_html-entities.mjs';

loadEnvFile(import.meta.url);

// Major port coordinates database (lat, lon)
const MAJOR_PORTS = {
  'Singapore': { lat: 1.3521, lon: 103.8198 },
  'Rotterdam': { lat: 51.9226, lon: 4.2719 },
  'Shanghai': { lat: 31.2304, lon: 121.4737 },
  'Dubai': { lat: 25.2048, lon: 55.2708 },
  'Hong Kong': { lat: 22.3193, lon: 114.1694 },
  'Suez Canal': { lat: 30.5, lon: 32.3 },
  'Panama Canal': { lat: 9.0, lon: -79.6 },
  'Malacca Strait': { lat: 3.0, lon: 101.5 },
  'Port Said': { lat: 31.265, lon: 32.302 },
  'Port Kelang': { lat: 3.1926, lon: 101.5265 },
  'Colombo': { lat: 6.9271, lon: 79.8612 },
  'Busan': { lat: 35.0973, lon: 129.0331 },
  'Manila': { lat: 14.5995, lon: 120.9842 },
  'Bangkok': { lat: 13.5505, lon: 100.4954 },
  'Singapore Strait': { lat: 1.3521, lon: 103.8198 },
  'Strait of Hormuz': { lat: 26.1, lon: 56.5 },
  // South China Sea / Philippine waters — the feed's home beat.
  'Scarborough Shoal': { lat: 15.15, lon: 117.76 },
  'Bajo de Masinloc': { lat: 15.15, lon: 117.76 },
  'Panatag Shoal': { lat: 15.15, lon: 117.76 },
  'Ayungin Shoal': { lat: 9.74, lon: 115.87 },
  'Second Thomas Shoal': { lat: 9.74, lon: 115.87 },
  'Escoda Shoal': { lat: 9.75, lon: 116.48 },
  'Sabina Shoal': { lat: 9.75, lon: 116.48 },
  'Pag-asa Island': { lat: 11.05, lon: 114.28 },
  'Thitu Island': { lat: 11.05, lon: 114.28 },
  'Mischief Reef': { lat: 9.9, lon: 115.53 },
  'Pag-asa': { lat: 11.05, lon: 114.28 },
  'Kota Island': { lat: 10.67, lon: 114.42 },
  'Loaita': { lat: 10.67, lon: 114.42 },
  'Parola Island': { lat: 11.45, lon: 114.35 },
  'Likas Island': { lat: 11.08, lon: 115.02 },
  'Lawak Island': { lat: 10.73, lon: 115.8 },
  'Patag Island': { lat: 10.82, lon: 115.82 },
  'Panata Island': { lat: 10.72, lon: 114.53 },
  'Rizal Reef': { lat: 8.37, lon: 115.23 },
  'Rozul Reef': { lat: 10.62, lon: 116.17 },
  'Julian Felipe Reef': { lat: 9.99, lon: 114.65 },
  'Whitsun Reef': { lat: 9.99, lon: 114.65 },
  'Subi Reef': { lat: 10.92, lon: 114.08 },
  'Fiery Cross': { lat: 9.55, lon: 112.89 },
  'Recto Bank': { lat: 11.45, lon: 116.83 },
  'Reed Bank': { lat: 11.45, lon: 116.83 },
  'Kalayaan': { lat: 11.05, lon: 114.28 },
  'Zambales': { lat: 15.3, lon: 119.9 },
  'Batanes': { lat: 20.45, lon: 121.97 },
  'Spratly': { lat: 10.0, lon: 114.5 },
  'West Philippine Sea': { lat: 12.5, lon: 117.5 },
  'WPS': { lat: 12.5, lon: 117.5 },
  'South China Sea': { lat: 13.0, lon: 114.5 },
  'Taiwan Strait': { lat: 24.5, lon: 119.5 },
  'Luzon Strait': { lat: 20.5, lon: 121.5 },
  'Subic': { lat: 14.79, lon: 120.27 },
  'Batangas': { lat: 13.75, lon: 121.05 },
  'Palawan': { lat: 9.75, lon: 118.75 },
  'Cebu': { lat: 10.3, lon: 123.9 },
  'Zamboanga': { lat: 6.9, lon: 122.07 },
  'Red Sea': { lat: 20.0, lon: 38.5 },
  'Bab el-Mandeb': { lat: 12.6, lon: 43.3 },
  'Gulf of Aden': { lat: 12.5, lon: 47.5 },
  'Black Sea': { lat: 43.5, lon: 34.0 },
  'Hormuz': { lat: 26.1, lon: 56.5 },
  'Gulf of Oman': { lat: 24.5, lon: 58.5 },
  'Persian Gulf': { lat: 26.5, lon: 52.0 },
  'Arabian Sea': { lat: 16.0, lon: 64.0 },
  'Baltic Sea': { lat: 57.5, lon: 19.5 },
  'Gulf of Guinea': { lat: 2.5, lon: 3.0 },
};

// A headline counts as a vessel report only when it names a vessel. Whole words
// only: substring matching turned "report", "support" and "leadership" into ships.
const VESSEL_TERM_RE = /\b(container ?ships?|bulk carriers?|cargo (?:ships?|vessels?)|oil tankers?|tankers?|freighters?|warships?|battleships?|destroyers?|frigates?|corvettes?|submarines?|aircraft carriers?|coast guard|navy (?:ships?|vessels?|boats?)|militia (?:vessels?|ships?|boats?)|sampans?|fishing (?:boats?|vessels?)|trawlers?|tugboats?|barges?|ferr(?:y|ies)|motorboats?|speedboats?|bancas?|boats?|vessels?|ships?|flotilla|fleet)\b/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest names first so "Singapore Strait" wins over "Singapore".
const PLACE_MATCHERS = Object.entries(MAJOR_PORTS)
  .sort(([a], [b]) => b.length - a.length)
  .map(([name, coords]) => ({ name, coords, re: new RegExp(`\\b${escapeRegExp(name)}\\b`, name === 'WPS' ? '' : 'i') }));

const THREAT_LEVEL_KEYWORDS = {
  critical: ['attack', 'struck', 'strike', 'bomb', 'missile', 'disabled', 'catches fire', 'on fire', 'seized', 'hijacked', 'water cannon', 'rammed', 'ramming', 'collision', 'collide', 'fired on', 'sunk', 'sinks', 'emergency'],
  high: ['drive away', 'drives away', 'drove away', 'harass', 'blocked', 'blocks', 'intrusion', 'incursion', 'swarm', 'shadow', 'challenge', 'disrupted', 'stranded', 'grounded', 'damage', 'incident'],
  medium: ['monitor', 'spotted', 'sighted', 'patrol', 'delayed', 'congestion', 'rerouted', 'shortage', 'closure'],
  low: ['vessel', 'ship', 'cargo'],
};

const THREAT_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// The digest the dashboard's news panels are built from. Reading it means a
// vessel story the user can see in a panel is a story this seeder considers.
const NEWS_DIGEST_KEY = 'news:digest:v1:full:en';

async function fetchDigestItems() {
  const digest = await readCanonicalValue(NEWS_DIGEST_KEY);
  const categories = digest?.categories ?? {};
  const items = [];
  for (const bucket of Object.values(categories)) {
    for (const item of bucket?.items ?? []) {
      if (!item?.title || !item?.link) continue;
      items.push({
        title: decodeHtmlEntities(String(item.title)).trim(),
        link: String(item.link),
        pubDate: Number.isFinite(item.publishedAt) ? new Date(item.publishedAt).toISOString() : '',
        rawDescription: decodeHtmlEntities(String(item.snippet ?? '')),
      });
    }
  }
  console.log(`  Read ${items.length} items from the news digest`);
  return items;
}

/**
 * Extract threat level from article title
 */
function extractThreatLevel(title) {
  const titleLower = title.toLowerCase();

  if (THREAT_LEVEL_KEYWORDS.critical.some(kw => titleLower.includes(kw))) {
    return 'critical';
  }
  if (THREAT_LEVEL_KEYWORDS.high.some(kw => titleLower.includes(kw))) {
    return 'high';
  }
  if (THREAT_LEVEL_KEYWORDS.medium.some(kw => titleLower.includes(kw))) {
    return 'medium';
  }
  return 'low';
}

/**
 * Name the vessel when the headline does (hull prefix or quoted name);
 * otherwise fall back to the vessel term it used.
 */
function extractVesselName(title) {
  const hull = title.match(/\b(?:BRP|MV|M\/V|MT|M\/T|USS|HMS|CCG|FV|F\/B)\s+[A-Z0-9][\w'-]*(?:\s+[A-Z0-9][\w'-]*){0,2}/);
  if (hull) return hull[0];
  const term = title.match(VESSEL_TERM_RE);
  if (!term) return 'Unnamed vessel';
  return term[1].charAt(0).toUpperCase() + term[1].slice(1).toLowerCase();
}

/**
 * Fetch and parse GMA News RSS feed (mirrored from seed-gma-news-rss.mjs)
 */
async function fetchGmaNewsRss() {
  console.log('Fetching GMA News RSS feed...');
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  try {
    const response = await fetch('https://data.gmanetwork.com/gno/rss/news/feed.xml', {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xmlText = await response.text();
    console.log(`  Fetched ${xmlText.length} bytes of XML`);

    // Dependency-free item extraction: the self-host runtime image ships no
    // XML parser (see docker/runtime-package.json), same as seed-climate-news.
    const readTag = (block, tag) => {
      const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!match) return '';
      return decodeHtmlEntities(match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
    };

    if (!/<rss\b/i.test(xmlText)) {
      throw new Error('Invalid RSS format: missing rss element');
    }

    const items = [];
    const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    for (let match = itemRe.exec(xmlText); match; match = itemRe.exec(xmlText)) {
      const block = match[1];
      items.push({
        title: readTag(block, 'title'),
        description: readTag(block, 'description'),
        link: readTag(block, 'link') || readTag(block, 'guid'),
        pubDate: readTag(block, 'pubDate') || readTag(block, 'dc:date'),
      });
    }
    if (items.length === 0) {
      console.warn('  No items found in RSS feed');
    }

    console.log(`  Found ${items.length} items in RSS feed`);

    // Helper functions from seed-gma-news-rss.mjs
    function sanitizeTitle(title) {
      if (typeof title !== 'string') return '';
      return title
        .replace(/<[^>]*>/g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 500)
        .trim();
    }

    function normalizePublishedAt(value) {
      if (!value) return undefined;
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
    }

    function categorizeStory(title) {
      const lower = (title || '').toLowerCase();
      const categories = [
        { keywords: ['war', 'attack', 'missile', 'troops', 'airstrike', 'combat', 'military'], cat: 'conflict', threat: 'critical' },
        { keywords: ['killed', 'dead', 'casualties', 'massacre', 'shooting'], cat: 'violence', threat: 'high' },
        { keywords: ['protest', 'uprising', 'riot', 'unrest', 'coup'], cat: 'unrest', threat: 'high' },
        { keywords: ['sanctions', 'tensions', 'escalation', 'threat'], cat: 'geopolitical', threat: 'elevated' },
        { keywords: ['crisis', 'emergency', 'disaster', 'collapse'], cat: 'crisis', threat: 'high' },
        { keywords: ['earthquake', 'flood', 'hurricane', 'wildfire', 'tsunami'], cat: 'natural_disaster', threat: 'elevated' },
        { keywords: ['election', 'vote', 'parliament', 'legislation'], cat: 'political', threat: 'moderate' },
        { keywords: ['market', 'economy', 'trade', 'tariff', 'inflation'], cat: 'economic', threat: 'moderate' },
      ];

      for (const { keywords, cat, threat } of categories) {
        if (keywords.some(kw => lower.includes(kw))) {
          return { category: cat, threatLevel: threat };
        }
      }
      return { category: 'general', threatLevel: 'moderate' };
    }

    const digestItems = items.map(item => {
      const title = item.title || '';
      const description = item.description || item['content:encoded'] || item.encoded || '';
      const link = item.link || item.guid || '';
      const pubDate = item.pubDate || item['dc:date'] || item.date || '';
      const source = item.source || 'GMA News';

      const cleanTitle = sanitizeTitle(title);
      const cleanLink = typeof link === 'string' ? link.trim() : '';
      const cleanPubDate = typeof pubDate === 'string' ? pubDate.trim() : '';

      if (!cleanTitle || !cleanLink) {
        return null;
      }

      const { category, threatLevel } = categorizeStory(cleanTitle);
      const countryCode = null; // we don't need country code for vessel extraction

      return {
        title: cleanTitle,
        source: typeof source === 'string' ? source.trim() : 'GMA News',
        link: cleanLink,
        pubDate: cleanPubDate || new Date().toISOString(),
        isAlert: false,
        tier: 2,
        threat: { level: threatLevel, source: 'keyword' },
        importanceScore: 0.5,
        credibilityScore: 0.7,
        corroborationCount: 1,
        storyMeta: {
          sourceCount: 1,
          uniqueSourceCount: 1,
        },
        category,
        threatLevel,
        countryCode,
        rawDescription: description.substring(0, 500),
      };
    }).filter(Boolean);

    console.log(`  Processed ${digestItems.length} valid digest items`);
    return digestItems;
  } catch (error) {
    console.error(`  Failed to fetch GMA News RSS: ${error.message}`);
    throw error;
  }
}

/**
 * Extract vessels from maritime news
 */
async function extractVesselsFromNews() {
  // Either source may be down; only fail the run when both are.
  const [digest, gma] = await Promise.allSettled([fetchDigestItems(), fetchGmaNewsRss()]);
  if (digest.status === 'rejected') console.warn(`  News digest unavailable: ${digest.reason?.message}`);
  if (digest.status === 'rejected' && gma.status === 'rejected') throw gma.reason;
  const newsItems = [
    ...(digest.status === 'fulfilled' ? digest.value : []),
    ...(gma.status === 'fulfilled' ? gma.value : []),
  ];

  // A vessel report needs both a vessel term and a place we can put on the map.
  // The headline is authoritative; the description only helps locate it.
  // One marker per place: outlets re-reporting the same incident would
  // otherwise stack identical markers on one point.
  const byPlace = new Map();
  const seenTitles = new Set();
  for (const article of newsItems) {
    const title = article.title || '';
    if (!VESSEL_TERM_RE.test(title)) continue;
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);

    const description = (article.rawDescription || '').replace(/<[^>]*>/g, ' ');
    const place = PLACE_MATCHERS.find(({ re }) => re.test(title))
      || PLACE_MATCHERS.find(({ re }) => re.test(description));
    if (!place) continue;

    const coordKey = `${place.coords.lat},${place.coords.lon}`;
    const ts = new Date(article.pubDate || Date.now()).getTime();
    const threat = extractThreatLevel(title);
    const existing = byPlace.get(coordKey);
    if (existing) {
      existing.report_count += 1;
      if (THREAT_RANK[threat] > THREAT_RANK[existing.threat_level]) existing.threat_level = threat;
      if (ts <= existing.article_ts) continue;
    }
    byPlace.set(coordKey, {
      // Stable per place so a re-seed does not mint a new marker identity.
      id: `news-vessel-${place.name.replace(/\s+/g, '-').toLowerCase()}`,
      name: extractVesselName(title),
      lat: place.coords.lat,
      lon: place.coords.lon,
      port: place.name,
      source: 'news-maritime-intel',
      article_url: article.link || '',
      article_title: title,
      article_ts: ts,
      threat_level: existing ? existing.threat_level : threat,
      report_count: existing ? existing.report_count : 1,
    });
  }

  return [...byPlace.values()];
}

/**
 * Main seeder function - returns the data to be stored
 */
async function run() {
  console.log('[seed-maritime-vessels-from-news] Starting extraction...');

  const vessels = await extractVesselsFromNews();

  if (vessels.length === 0) {
    console.warn('[seed-maritime-vessels-from-news] No vessels extracted');
    // Return empty array; runSeed will still write it (or we could exit early)
    return [];
  }

  console.log(`[seed-maritime-vessels-from-news] Extracted ${vessels.length} vessels`);
  // Return the array; runSeed will handle storing to CANONICAL_KEY with TTL and metadata
  return vessels;
}

// Boilerplate for direct execution
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) {
  runSeed('maritime', 'maritime-vessels-from-news', 'maritime:vessels-from-news:v1', run, {
    validateFn: (data) => {
      // Accept any array (even empty) – we just want to know it ran
      return Array.isArray(data);
    },
    ttlSeconds: 7200, // 2 hours
    sourceVersion: 'maritime-vessels-from-news-v1',
    declareRecords: (data) => Array.isArray(data) ? data.length : 0,
    schemaVersion: 1,
    maxStaleMin: 120, // 2 hours acceptable staleness
    preserveKeys: [],
    publishTransform: (data) => {
      // We are adding to the digest key directly; no transformation needed
      return data;
    },
    afterPublish: async (data) => {
      console.log(`  Maritime vessels from news seeder completed: ${Array.isArray(data) ? data.length : 0} vessels`);
      return {};
    },
    afterValidationSkip: async (data, context) => {
      return {};
    },
  }).catch(async (err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    await import('./lib/llm-telemetry.cjs').then(({ flushPendingLlmEvents }) => flushPendingLlmEvents());
    process.exit(1);
  });
}

export { run };

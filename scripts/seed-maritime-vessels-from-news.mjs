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
  runSeed,
} from './_seed-utils.mjs';

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
};

// News keywords indicating maritime vessel presence
const VESSEL_KEYWORDS = [
  'container ship', 'bulk carrier', 'tanker', 'cargo vessel', 'freighter',
  'containership', 'vessel', 'ship', 'shipping', 'maritime',
  'port', 'strait', 'canal', 'passage', 'shipping route',
  'merchant', 'cargo', 'import', 'export'
];

const THREAT_LEVEL_KEYWORDS = {
  critical: ['attack', 'struck', 'seized', 'hijacked', 'incident', 'emergency'],
  high: ['disrupted', 'stranded', 'grounded', 'collision', 'damage'],
  medium: ['delayed', 'congestion', 'rerouted', 'shortage', 'closure'],
  low: ['vessel', 'ship', 'cargo'],
};

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
 * Extract vessel name from article title
 */
function extractVesselName(title) {
  // Look for quoted vessel names or vessel type + name patterns
  const quotedMatch = title.match(/['"“]([^'”"]*)(?:ship|vessel|freighter)['"”]|(?:vessel|ship)\\s+[\"'']?([^'\"\".,;:!?]+)[\"'']?/i);
  if (quotedMatch) {
    return quotedMatch[1] || quotedMatch[2] || 'Unnamed vessel';
  }

  // Fallback: use first 3 words if they contain a vessel keyword
  const words = title.split(/\s+/);
  for (let i = 0; i < Math.min(3, words.length); i++) {
    if (VESSEL_KEYWORDS.some(kw => title.toLowerCase().includes(kw))) {
      return words.slice(0, Math.min(i + 2, words.length)).join(' ');
    }
  }

  return 'Unnamed vessel';
}

/**
 * Fetch and parse GMA News RSS feed (mirrored from seed-gma-news-rss.mjs)
 */
async function fetchGmaNewsRss() {
  console.log('Fetching GMA News RSS feed...');
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  try {
    const response = await fetch('https://data.gmanews.tv/gno/rss/news/feed.xml', {
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

    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({
      attributeNamePrefix : "@_",
      attrNodeName: "attr",
      textNodeName : "#text",
      ignoreAttributes : false,
      ignoreNameSpace : false,
      allowBooleanAttributes : false,
      parseNodeValue : true,
      parseAttributeValue : false,
      trimValues: true,
      cdataTagName: "__cdata",
      cdataPositionChar: "\\c",
      duplicateAttributeName: "_1",
      duplicateAttributeValue: "_2",
      parseTrueNumberOnly: false,
      arrayMode: false,
      ignoreWhitespace : true,
      attrsAsObject: true,
      stripWhiteSpace: true,
    });

    const jsonResult = parser.parse(xmlText);

    // Extract items from RSS structure
    const rss = jsonResult.rss || jsonResult.RSS;
    if (!rss) {
      throw new Error('Invalid RSS format: missing rss element');
    }

    const channel = rss.channel;
    if (!channel) {
      throw new Error('Invalid RSS format: missing channel element');
    }

    let items = channel.item;
    if (!items) {
      console.warn('  No items found in RSS feed');
      items = [];
    } else if (!Array.isArray(items)) {
      items = [items];
    }

    console.log(`  Found ${items.length} items in RSS feed`);

    // Helper functions from seed-gma-news-rss.mjs
    function sanitizeTitle(title) {
      if (typeof title !== 'string') return '';
      return title
        .replace(/<[^>]*>/g, '')
        .replace(/[\\x00-\\x1f\\x7f]/g, '')
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
  try {
    const newsItems = await fetchGmaNewsRss();

    // Filter for maritime-relevant articles
    const maritimeNews = newsItems.filter(item =>
      VESSEL_KEYWORDS.some(kw =>
        (item.title || '').toLowerCase().includes(kw)
      )
    );

    // Build vessel records
    const vessels = [];
    for (const article of maritimeNews) {
      const title = article.title || '';
      const lowerTitle = title.toLowerCase();

      // Try to match a known port/straits name
      let matched = false;
      for (const [portName, coords] of Object.entries(MAJOR_PORTS)) {
        if (lowerTitle.includes(portName.toLowerCase())) {
          vessels.push({
            id: `news-vessel-${portName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            name: extractVesselName(title),
            lat: coords.lat,
            lon: coords.lon,
            port: portName,
            source: 'news-maritime-intel',
            article_url: article.link || '',
            article_title: title,
            article_ts: new Date(article.pubDate || article.date || Date.now()).getTime(),
            threat_level: extractThreatLevel(title),
          });
          matched = true;
          break; // one match per article
        }
      }

      // If no known port matched, we skip (could optionally use a fallback)
    }

    return vessels;
  } catch (err) {
    console.error('[seed-maritime-vessels-from-news] Extraction failed:', err.message);
    throw err;
  }
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

#!/usr/bin/env node

import { loadEnvFile, runSeed, httpRetryError, withRetry } from './_seed-utils.mjs';
import { CHROME_UA } from './_seed-utils.mjs';
import { XMLParser } from 'fast-xml-parser';

// Import from the scripts mirror (`scripts/shared/`) — NOT the repo-root
// `shared/`. Railway services with nixpacks `rootDirectory=scripts` only
// package files under scripts/; a `../shared/` import resolves to
// `/shared/...` at runtime which is absent in the container and crashes
// the seeder on startup. The local pattern is the `./shared/geo-extract.mjs`
// line above. PR #3836 review caught this. See skill
// railway-deploy-gotchas/reference/nixpacks-root-dir-scripts-cross-dir-import-escape.
import { extractCountryCode } from './shared/geo-extract.mjs';

const BRIEF_VALIDATOR_MODE =
  process.env.BRIEF_VALIDATOR_MODE === 'shadow' ? 'shadow' : 'enforce';

const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) loadEnvFile(import.meta.url);

const PROTO_TO_LEVEL = {
  THREAT_LEVEL_CRITICAL: 'critical',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_UNSPECIFIED: 'info',
};

function normalizeThreat(threat) {
  if (!threat) return undefined;
  const level = PROTO_TO_LEVEL[threat.level] ?? threat.level;
  return { ...threat, level };
}

const CANONICAL_KEY = 'news:digest:v1:full:en';
const CACHE_TTL = 3600; // 1h
const MAX_HEADLINE_LEN = 500;
const INSIGHTS_SOURCE_VERSION = 'navalnews-brah-mos-v1';

function sanitizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/[\\x00-\\x1f\\x7f]/g, '')
    .slice(0, MAX_HEADLINE_LEN)
    .trim();
}

function clipText(value, maxLen) {
  const text = typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
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

/**
 * Extract coordinates for BrahMos-related Philippine defense news
 * Based on known locations mentioned in Naval News articles
 */
function extractBrahMosLocation(title, description) {
  const combined = `${title || ''} ${description || ''}`.toLowerCase();
  
  // Western Luzon BrahMos base (Zambales area) - approx 15.5°N, 120.0°E
  if (combined.includes('western luzon') || 
      combined.includes('zambales') || 
      combined.includes('camp cape bojeador') ||
      (combined.includes('brahmos') && combined.includes('luzon'))) {
    return { lat: 15.5, lon: 120.0 };
  }
  
  // Northern Luzon BrahMos activation (Cape Bojeador area) 
  if (combined.includes('northern luzon') || 
      combined.includes('cape bojeador') ||
      (combined.includes('brahmos') && combined.includes('northern'))) {
    return { lat: 18.5, lon: 120.6 }; // Approximate Cape Bojeador coordinates
  }
  
  // General Philippines/SCS references
  if (combined.includes('philippine') || 
      combined.includes('philippines') ||
      combined.includes('south china sea') ||
      combined.includes('scs') ||
      combined.includes('west philippine sea') ||
      combined.includes('wps')) {
    // Return general Philippines center if no specific location
    return { lat: 12.8797, lon: 121.7740 };
  }
  
  return null; // No specific location found
}

/**
 * Fetch and parse Naval News RSS feed for BrahMos/Coastal Defense Regiment updates
 */
async function fetchNavalNewsRss() {
  console.log('Fetching Naval News RSS feed...');
  
  try {
    const response = await fetch('https://www.navalnews.com/feed/', {
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
    
    // Parse XML to JSON using fast-xml-parser
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
    
    // Convert to digest items format
    const digestItems = items.map(item => {
      // Handle common RSS field variations
      const title = item.title || '';
      const description = item.description || item['content:encoded'] || item.encoded || '';
      const link = item.link || item.guid || '';
      const pubDate = item.pubDate || item['dc:date'] || item.date || '';
      const source = item.source || 'Naval News';
      
      // Clean up CDATA and HTML if needed
      const cleanTitle = sanitizeTitle(title);
      const cleanLink = typeof link === 'string' ? link.trim() : '';
      const cleanPubDate = typeof pubDate === 'string' ? pubDate.trim() : '';
      
      // Skip if no title or link
      if (!cleanTitle || !cleanLink) {
        return null;
      }
      
      // Determine threat level and category from title/description
      const { category, threatLevel } = categorizeStory(cleanTitle);
      
      // Extract country code from title (focus on Philippines/SCS)
      const countryCode = extractCountryCode(cleanTitle) || 
                         (cleanTitle.toLowerCase().includes('philippine') || 
                          cleanTitle.toLowerCase().includes('philippines') || 
                          cleanTitle.toLowerCase().includes('pinoy') ||
                          cleanTitle.toLowerCase().includes('manila') ||
                          cleanTitle.toLowerCase().includes('luzon') ||
                          cleanTitle.toLowerCase().includes('visayas') ||
                          cleanTitle.toLowerCase().includes('mindanao') ||
                          cleanTitle.toLowerCase().includes('south china sea') ||
                          cleanTitle.toLowerCase().includes('scs') ||
                          cleanTitle.toLowerCase().includes('west philippine sea') ||
                          cleanTitle.toLowerCase().includes('wps')) ? 'PH' : null;
      
      // Extract location for BrahMos-related news
      const location = extractBrahMosLocation(cleanTitle, description);
      
      return {
        title: cleanTitle,
        source: typeof source === 'string' ? source.trim() : 'Naval News',
        link: cleanLink,
        pubDate: cleanPubDate || new Date().toISOString(),
        isAlert: false,
        tier: 2,
        threat: normalizeThreat({ level: threatLevel, source: 'keyword' }),
        importanceScore: 0.6, // Slightly higher for defense news
        credibilityScore: 0.8, // Good credibility for specialized defense news
        corroborationCount: 1,
        storyMeta: {
          sourceCount: 1,
          uniqueSourceCount: 1,
        },
        // Additional fields for processing
        category,
        threatLevel,
        countryCode,
        // Location fields for map visualization
        latitude: location ? location.lat : undefined,
        longitude: location ? location.lon : undefined,
        locationName: location ? 
          (location.lat === 15.5 && location.lon === 120.0 ? 'Western Luzon BrahMos Base' :
           location.lat === 18.5 && location.lon === 120.6 ? 'Northern Luzon BrahMos Activation (Cape Bojeador)' :
           'Philippines General Area') : undefined,
        rawDescription: description.substring(0, 500),
      };
    }).filter(Boolean);
    
    console.log(`  Processed ${digestItems.length} valid digest items`);
    const withLocation = digestItems.filter(item => item.latitude !== undefined && item.longitude !== undefined).length;
    console.log(`  Items with location data: ${withLocation}`);
    return digestItems;
    
  } catch (error) {
    console.error(`  Failed to fetch Naval News RSS: ${error.message}`);
    throw error;
  }
}

/**
 * Main seeding function
 */
async function run() {
  console.log('Starting Naval News RSS seeder (BrahMos focus with location tracking)...');
  
  const items = await fetchNavalNewsRss();
  
  if (items.length === 0) {
    console.warn('  No items to seed from Naval News RSS');
    return {
      items: [],
      generatedAt: new Date().toISOString(),
      source: 'Naval News RSS',
      version: INSIGHTS_SOURCE_VERSION,
    };
  }
  
  // Construct digest in expected format
  const digest = {
    items,
    generatedAt: new Date().toISOString(),
    source: 'Naval News RSS',
    version: INSIGHTS_SOURCE_VERSION,
    feedUrl: 'https://www.navalnews.com/feed/',
    fetchedAt: new Date().toISOString(),
  };
  
  console.log(`  Seeding ${items.length} items to ${CANONICAL_KEY}`);
  return digest;
}

if (_isDirectRun) {
  runSeed('news', 'navalnews-brah-mos', CANONICAL_KEY, run, {
    validateFn: (data) => {
      if (!data || !Array.isArray(data.items)) {
        return false;
      }
      return data.items.length > 0;
    },
    ttlSeconds: CACHE_TTL,
    sourceVersion: INSIGHTS_SOURCE_VERSION,
    declareRecords: (data) => {
      return Array.isArray(data?.items) ? data.items.length : 0;
    },
    schemaVersion: 1,
    maxStaleMin: 30,
    preserveKeys: [],
    publishTransform: (data) => {
      return data;
    },
    afterPublish: async (data) => {
      const runMeta = data?.[Symbol.for('worldmonitor.insightsRunMeta')];
      console.log(`  Naval News BrahMos seeder completed: ${data?.items?.length || 0} items`);
      return {};
    },
    afterValidationSkip: async (data, context) => {
      return {};
    },
  }).catch(async (err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    await import('./lib/llm-telemetry.cjs').then(({ flushPendingLlmEvents }) => flushPendingLlmEvents());
    process.exit(1);
  });
}

export { run };
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

// Hallucination validator rollout mode (PR-2 of brief-content-quality
// regressions). `shadow` = log violations to Sentry but ship the LLM
// output unchanged (default, safe). `enforce` = on violation, replace
// the LLM summary with the source headline. Flip via Railway env after
// the 7-day shadow window confirms <5% violation rate.
// #4921: enforce is the DEFAULT — the shadow window measured its
// false-positive rate; shipping detected hallucinations was the residual
// risk. Set BRIEF_VALIDATOR_MODE=shadow to revert during an incident.
const BRIEF_VALIDATOR_MODE =
  process.env.BRIEF_VALIDATOR_MODE === 'shadow' ? 'shadow' : 'enforce';

// True only when run directly as a cron entry (node seed-gma-news-rss.mjs), false
// when imported by tests — so importing the module doesn't load .env or fire a
// live seed. Mirrors seed-forecasts.mjs.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) loadEnvFile(import.meta.url);

// Digest items store proto enum strings (THREAT_LEVEL_HIGH etc.) from toProtoItem().
// Normalize to client-side lowercase values before propagating into insights output.
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

const CANONICAL_KEY = 'news:digest:v1:full:en'; // Add to main English digest
// Alternative: create a language-specific key like 'news:digest:v1:full:en:gma'
// But adding to main digest ensures clustering with other sources

const CACHE_TTL = 3600; // 1h — frequent enough for news, respects source
const MAX_HEADLINE_LEN = 500;
const INSIGHTS_SOURCE_VERSION = 'gma-news-rss-v1';

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
 * Fetch and parse GMA News RSS feed
 */
async function fetchGmaNewsRss() {
  console.log('Fetching GMA News RSS feed...');
  
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
    
    // Parse XML to JSON using fast-xml-parser
    const parser = new XMLParser({
      attributeNamePrefix : "@_",
      attrNodeName: "attr", //default is 'false'
      textNodeName : "#text",
      ignoreAttributes : false,
      ignoreNameSpace : false,
      allowBooleanAttributes : false,
      parseNodeValue : true,
      parseAttributeValue : false,
      trimValues: true,
      cdataTagName: "__cdata", //default is 'false'
      cdataPositionChar: "\\c",
      duplicateAttributeName: "_1",
      duplicateAttributeValue: "_2",
      parseTrueNumberOnly: false,
      arrayMode: false, //"strict"
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
      const source = item.source || 'GMA News';
      
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
      
      // Extract country code from title (focus on Philippines)
      const countryCode = extractCountryCode(cleanTitle) || 
                         (cleanTitle.toLowerCase().includes('philippine') || 
                          cleanTitle.toLowerCase().includes('philippines') || 
                          cleanTitle.toLowerCase().includes('pinoy') ||
                          cleanTitle.toLowerCase().includes('manila') ||
                          cleanTitle.toLowerCase().includes('luzon') ||
                          cleanTitle.toLowerCase().includes('visayas') ||
                          cleanTitle.toLowerCase().includes('mindanao')) ? 'PH' : null;
      
      return {
        title: cleanTitle,
        source: typeof source === 'string' ? source.trim() : 'GMA News',
        link: cleanLink,
        pubDate: cleanPubDate || new Date().toISOString(),
        isAlert: false, // RSS doesn't typically have alert flags
        tier: 2, // Default tier for news feed
        threat: normalizeThreat({ level: threatLevel, source: 'keyword' }),
        importanceScore: 0.5, // Default middle importance
        credibilityScore: 0.7, // Reasonable credibility for established news source
        corroborationCount: 1, // Single source initially, clustering will handle corroboration
        storyMeta: {
          sourceCount: 1,
          uniqueSourceCount: 1,
        },
        // Additional fields for processing
        category,
        threatLevel,
        countryCode,
        rawDescription: description.substring(0, 500), // Truncate for storage
      };
    }).filter(Boolean); // Remove null items
    
    console.log(`  Processed ${digestItems.length} valid digest items`);
    return digestItems;
    
  } catch (error) {
    console.error(`  Failed to fetch GMA News RSS: ${error.message}`);
    throw error;
  }
}

/**
 * Main seeding function
 */
async function run() {
  console.log('Starting GMA News RSS seeder...');
  
  const items = await fetchGmaNewsRss();
  
  if (items.length === 0) {
    console.warn('  No items to seed from GMA News RSS');
    return {
      items: [],
      generatedAt: new Date().toISOString(),
      source: 'GMA News RSS',
      version: INSIGHTS_SOURCE_VERSION,
    };
  }
  
  // Construct digest in expected format
  const digest = {
    items,
    generatedAt: new Date().toISOString(),
    source: 'GMA News RSS',
    version: INSIGHTS_SOURCE_VERSION,
    // Optional metadata
    feedUrl: 'https://data.gmanews.tv/gno/rss/news/feed.xml',
    fetchedAt: new Date().toISOString(),
  };
  
  console.log(`  Seeding ${items.length} items to ${CANONICAL_KEY}`);
  return digest;
}

if (_isDirectRun) {
  runSeed('news', 'gma-news-rss', CANONICAL_KEY, run, {
    validateFn: (data) => {
      // Validate that we have items and required structure
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
    preserveKeys: [], // No special keys to preserve
    publishTransform: (data) => {
      // Pass through unchanged - we're adding to existing digest
      return data;
    },
    afterPublish: async (data) => {
      const runMeta = data?.[Symbol.for('worldmonitor.insightsRunMeta')];
      console.log(`  GMA News RSS seeder completed: ${data?.items?.length || 0} items`);
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
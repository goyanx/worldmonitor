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

/*
 * PCG Challenges Chinese Research Vessel News Seeder for WorldMonitor
 * Fetches news via Google News RSS for specific query
 * Integrates with WorldMonitor's insights pipeline
 */

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

// True only when run directly as a cron entry (node seed-pcg-chinese-vessel.mjs), false
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
const CACHE_TTL = 3600; // 1h — frequent enough for news, respects source
const MAX_HEADLINE_LEN = 500;
const INSIGHTS_SOURCE_VERSION = 'pcg-chinese-vessel-news-v1';

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
 * Fetch and parse Google News RSS for PCG Chinese research vessel query
 */
async function fetchPcgChineseVesselNews() {
  console.log('Fetching PCG Chinese Vessel news via Google News RSS...');
  
  try {
    const response = await fetch('https://news.google.com/rss/search?q=PCG+challenges+Chinese+research+vessel+Manila+Times&hl=en-PH&gl=PH&ceid=PH:en', {
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
      // Extract title and clean it (remove source suffix if present)
      let title = item.title || '';
      if (title.includes(' - Manila Times')) {
        title = title.replace(' - Manila Times', '');
      } else if (title.includes('| Manila Times')) {
        title = title.replace('| Manila Times', '');
      }
      // Also remove common Google News suffixes
      if (title.includes(' - Google News')) {
        title = title.replace(' - Google News', '');
      }
      
      // Extract source from the source tag or from title cleaning
      let source = 'Manila Times'; // default
      if (item.source && item.source['#text']) {
        source = item.source['#text'];
      } else if (item.source && typeof item.source === 'object' && item.source['#text']) {
        source = item.source['#text'];
      }
      
      // Extract link
      const link = item.link || '';
      
      // Extract publication date
      const pubDate = item.pubDate || item['dc:date'] || item.date || '';
      
      // Extract description/snippet
      let description = item.description || item['content:encoded'] || item.encoded || '';
      // Clean HTML tags from description if present
      description = description.replace(/<[^>]*>/g, '').trim();
      
      // Extract categories/topics (if available)
      const categories = item.category ? (Array.isArray(item.category) ? item.category : [item.category]) : [];
      
      // Skip if no title or link
      if (!title || !link) {
        return null;
      }
      
      // Determine threat level and category from title/description
      const { category, threatLevel } = categorizeStory(title);
      
      // Extract country code from title (focus on Philippines)
      const countryCode = extractCountryCode(title) || 
                         (title.toLowerCase().includes('philippine') || 
                          title.toLowerCase().includes('philippines') || 
                          title.toLowerCase().includes('pinoy') ||
                          title.toLowerCase().includes('manila') ||
                          title.toLowerCase().includes('luzon') ||
                          title.toLowerCase().includes('visayas') ||
                          title.toLowerCase().includes('mindanao')) ? 'PH' : null;
      
      return {
        title: title.trim(),
        source: typeof source === 'string' ? source.trim() : 'Manila Times',
        link: typeof link === 'string' ? link.trim() : '',
        pubDate: typeof pubDate === 'string' ? pubDate.trim() : new Date().toISOString(),
        isAlert: false, // RSS doesn't typically have alert flags
        tier: 2, // Default tier for news feed
        threat: normalizeThreat({ level: threatLevel, source: 'keyword' }),
        importanceScore: 0.7, // Slightly higher importance for specific incident
        credibilityScore: 0.8, // Good credibility for established news source via Google News
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
    console.error(`  Failed to fetch PCG Chinese Vessel news RSS: ${error.message}`);
    throw error;
  }
}

/**
 * Main seeding function
 */
async function run() {
  console.log('Starting PCG Chinese Vessel News seeder...');
  
  const items = await fetchPcgChineseVesselNews();
  
  if (items.length === 0) {
    console.warn('  No items to seed from PCG Chinese Vessel News RSS');
    return {
      items: [],
      generatedAt: new Date().toISOString(),
      source: 'PCG Chinese Vessel News RSS',
      version: INSIGHTS_SOURCE_VERSION,
    };
  }
  
  // Construct digest in expected format
  const digest = {
    items,
    generatedAt: new Date().toISOString(),
    source: 'PCG Chinese Vessel News RSS',
    version: INSIGHTS_SOURCE_VERSION,
    // Optional metadata
    feedUrl: 'https://news.google.com/rss/search?q=PCG+challenges+Chinese+research+vessel+Manila+Times&hl=en-PH&gl=PH&ceid=PH:en',
    fetchedAt: new Date().toISOString(),
  };
  
  console.log(`  Seeding ${items.length} items to ${CANONICAL_KEY}`);
  return digest;
}

if (_isDirectRun) {
  runSeed('news', 'pcg-chinese-vessel-news', CANONICAL_KEY, run, {
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
      console.log(`  PCG Chinese Vessel News seeder completed: ${data?.items?.length || 0} items`);
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
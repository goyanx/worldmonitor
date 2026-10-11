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
const INSIGHTS_SOURCE_VERSION = 'philippine-maritime-agencies-v1';

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
 * Extract agency and location information for Philippine maritime agency news
 */
function extractPhilippineMaritimeAgencyInfo(title, description) {
  const combined = `${title || ''} ${description || ''}`.toLowerCase();
  
  // Agency detection
  const agencies = [];
  const agencyDetails = {
    'philippine coast guard': { 
      name: 'Philippine Coast Guard (PCG)', 
      role: 'Civilian maritime law enforcement, patrol, search & rescue, maritime security',
      wps_involvement: 'Primary visible civilian patrol force in the WPS',
      icon: '🚤',
      color: '#0066CC'  // Navy blue
    },
    'philippine navy': { 
      name: 'Philippine Navy (PN)', 
      role: 'Military/territorial defense',
      wps_involvement: 'Patrols and defends Philippine territory/EEZ, especially when military capability is required',
      icon: '⚓',
      color: '#003366'  // Dark navy
    },
    'bfar': { 
      name: 'BFAR – Bureau of Fisheries and Aquatic Resources', 
      role: 'Fisheries enforcement and protection of Filipino fishermen',
      wps_involvement: 'Operates fisheries patrol vessels and supports fishermen in WPS',
      icon: '🐟',
      color: '#009900'  // Green
    },
    'pnp maritime group': { 
      name: 'PNP Maritime Group', 
      role: 'Police enforcement at sea',
      wps_involvement: 'Smuggling, crime, illegal fishing, law enforcement, typically nearer coastal waters',
      icon: '👮‍♂️',
      color: '#660066'  // Purple
    },
    'national maritime center': { 
      name: 'National Maritime Center (NMC)', 
      role: 'Maritime-domain awareness and coordination',
      wps_involvement: 'Coordinates information and maritime-security activities among agencies',
      icon: '📡',
      color: '#666666'  // Gray
    }
  };
  
  // Check for agency mentions
  let detectedAgency = null;
  for (const [key, details] of Object.entries(agencyDetails)) {
    if (combined.includes(key)) {
      detectedAgency = { key, ...details };
      break;
    }
  }
  
  // Location extraction for WPS/Philippine maritime areas
  const location = extractMaritimeLocation(combined);
  
  return { agency: detectedAgency, location };
}

/**
 * Extract coordinates for Philippine maritime locations mentioned in news
 */
function extractMaritimeLocation(text) {
  // Known WPS/Philippine maritime locations with approximate coordinates
  const locations = [
    // Kalayaan Island Group (Spratly Islands)
    { name: 'Kalayaan Island Group', lat: 10.5, lon: 114.0, keywords: ['kalayaan', 'spratly'] },
    { name: 'Kota Island', lat: 10.8, lon: 114.4, keywords: ['kota island'] },
    { name: 'Thitu Island', lat: 11.0, lon: 114.3, keywords: ['thitu', 'tieman'] },
    { name: 'West Philippine Sea', lat: 14.0, lon: 118.0, keywords: ['west philippine sea', 'wps', 'south china sea', 'scs'] },
    { name: 'Luzon Strait', lat: 20.0, lon: 121.0, keywords: ['luzon strait'] },
    { name: 'Batanes', lat: 20.4, lon: 121.8, keywords: ['batanes', 'itbayat'] },
    { name: 'Zambales', lat: 15.0, lon: 120.0, keywords: ['zambales', 'western luzon'] },
    { name: 'Cape Bojeador', lat: 18.5, lon: 120.6, keywords: ['cape bojeador', 'northern luzon'] },
    { name: 'Manila Bay', lat: 14.5, lon: 120.8, keywords: ['manila bay'] },
    { name: 'Palawan', lat: 9.5, lon: 118.5, keywords: ['palawan'] },
    { name: 'Visayas', lat: 10.5, lon: 124.0, keywords: ['visayas', 'central philippines'] },
    { name: 'Mindanao', lat: 8.0, lon: 125.0, keywords: ['mindanao', 'southern philippines'] }
  ];
  
  // Find best matching location
  let bestMatch = null;
  let maxMatches = 0;
  
  for (const loc of locations) {
    let matchCount = 0;
    for (const keyword of loc.keywords) {
      if (text.includes(keyword)) {
        matchCount++;
      }
    }
    if (matchCount > maxMatches) {
      maxMatches = matchCount;
      bestMatch = loc;
    }
  }
  
  // If we found a good match, return its coordinates
  if (bestMatch && maxMatches > 0) {
    return {
      lat: bestMatch.lat,
      lon: bestMatch.lon,
      locationName: bestMatch.name
    };
  }
  
  // Fallback: if text mentions Philippines but no specific location, use general Philippines center
  if (text.includes('philippine') || text.includes('philippines') || text.includes('pinoy')) {
    return {
      lat: 12.8797,
      lon: 121.7740,
      locationName: 'Philippines General Area'
    };
  }
  
  return null; // No specific location found
}

/**
 * Fetch and parse Philippine maritime agency news from multiple sources
 */
async function fetchPhilippineMaritimeNews() {
  console.log('Fetching Philippine maritime agency news...');
  
  // Define news sources to monitor
  const sources = [
    {
      name: 'GMA News',
      url: 'https://data.gmanetwork.com/gno/rss/news/feed.xml',
      agencyFocus: ['philippine coast guard', 'philippine navy', 'bfar', 'pnp maritime', 'national maritime center']
    },
    {
      name: 'ABS-CBN News (via Google News)',
      url: 'https://news.google.com/rss/search?q=Philippine+Coast+Guard+OR+Philippine+Navy+OR+BFAR+OR+PNP+Maritime+Group+OR+National+Maritime+Center&hl=en-PH&gl=PH&ceid=PH:en',
      agencyFocus: ['philippine coast guard', 'philippine navy', 'bfar', 'pnp maritime', 'national maritime center']
    },
    {
      name: 'Manila Times (via Google News)',
      url: 'https://news.google.com/rss/search?q=West+Philippine+Sea+OR+South+China+Sea+OR+Kalayaan+ISlands&hl=en-PH&gl=PH&ceid=PH:en',
      agencyFocus: ['philippine coast guard', 'philippine navy', 'bfar', 'pnp maritime', 'national maritime center']
    }
  ];
  
  let allItems = [];
  
  for (const source of sources) {
    try {
      console.log(`  Fetching from ${source.name}...`);
      const response = await fetch(source.url, {
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
      console.log(`    Fetched ${xmlText.length} bytes of XML`);
      
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
        console.warn(`    Invalid RSS format from ${source.name}: missing rss element`);
        continue;
      }
      
      const channel = rss.channel;
      if (!channel) {
        console.warn(`    Invalid RSS format from ${source.name}: missing channel element`);
        continue;
      }
      
      let items = channel.item;
      if (!items) {
        console.warn(`    No items found in ${source.name} RSS feed`);
        items = [];
      } else if (!Array.isArray(items)) {
        items = [items];
      }
      
      console.log(`    Found ${items.length} items in ${source.name} RSS feed`);
      
      // Convert to digest items format with agency detection
      const digestItems = items.map(item => {
        // Handle common RSS field variations
        const title = item.title || '';
        const description = item.description || item['content:encoded'] || item.encoded || '';
        const link = item.link || item.guid || '';
        const pubDate = item.pubDate || item['dc:date'] || item.date || '';
        const sourceName = item.source || source.name;
        
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
        
        // Extract agency and location info
        const agencyInfo = extractPhilippineMaritimeAgencyInfo(cleanTitle, description);
        
        return {
          title: cleanTitle,
          source: typeof sourceName === 'string' ? sourceName.trim() : sourceName,
          link: cleanLink,
          pubDate: cleanPubDate || new Date().toISOString(),
          isAlert: false,
          tier: 2,
          threat: normalizeThreat({ level: threatLevel, source: 'keyword' }),
          importanceScore: 0.7, // Higher importance for agency-specific maritime news
          credibilityScore: 0.8, // Good credibility for Philippine news sources
          corroborationCount: 1,
          storyMeta: {
            sourceCount: 1,
            uniqueSourceCount: 1,
          },
          // Additional fields for processing
          category,
          threatLevel,
          countryCode,
          // Agency-specific fields
          agencyName: agencyInfo.agency ? agencyInfo.agency.name : undefined,
          agencyRole: agencyInfo.agency ? agencyInfo.agency.role : undefined,
          agencyWPSInvolvement: agencyInfo.agency ? agencyInfo.agency.wps_involvement : undefined,
          agencyIcon: agencyInfo.agency ? agencyInfo.agency.icon : undefined,
          agencyColor: agencyInfo.agency ? agencyInfo.agency.color : undefined,
          // Location fields for map visualization
          latitude: agencyInfo.location ? agencyInfo.location.lat : undefined,
          longitude: agencyInfo.location ? agencyInfo.location.lon : undefined,
          locationName: agencyInfo.location ? agencyInfo.location.locationName : undefined,
          rawDescription: description.substring(0, 500),
        };
      }).filter(Boolean);
      
      console.log(`    Processed ${digestItems.length} valid digest items from ${source.name}`);
      allItems = allItems.concat(digestItems);
      
    } catch (error) {
      console.error(`  Failed to fetch from ${source.name}: ${error.message}`);
      // Continue with other sources even if one fails
      continue;
    }
  }
  
  console.log(`  Total processed items from all sources: ${allItems.length}`);
  const withAgency = allItems.filter(item => item.agencyName !== undefined).length;
  const withLocation = allItems.filter(item => item.latitude !== undefined && item.longitude !== undefined).length;
  console.log(`  Items with agency info: ${withAgency}`);
  console.log(`  Items with location data: ${withLocation}`);
  
  return allItems;
}

/**
 * Main seeding function
 */
async function run() {
  console.log('Starting Philippine Maritime Agencies seeder...');
  
  const items = await fetchPhilippineMaritimeNews();
  
  if (items.length === 0) {
    console.warn('  No items to seed from Philippine maritime news sources');
    return {
      items: [],
      generatedAt: new Date().toISOString(),
      source: 'Philippine Maritime Agencies RSS',
      version: INSIGHTS_SOURCE_VERSION,
    };
  }
  
  // Construct digest in expected format
  const digest = {
    items,
    generatedAt: new Date().toISOString(),
    source: 'Philippine Maritime Agencies RSS',
    version: INSIGHTS_SOURCE_VERSION,
  };
  
  console.log(`  Seeding ${items.length} items to ${CANONICAL_KEY}`);
  return digest;
}

if (_isDirectRun) {
  runSeed('news', 'philippine-maritime-agencies', CANONICAL_KEY, run, {
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
      console.log(`  Philippine Maritime Agencies seeder completed: ${data?.items?.length || 0} items`);
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
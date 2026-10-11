import { loadEnvFile } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const MAJOR_PORTS = {
  'Singapore': { lat: 1.3521, lon: 103.8198 },
  'Hong Kong': { lat: 22.3193, lon: 114.1694 },
  'Shanghai': { lat: 31.2304, lon: 121.4737 },
  'Suez Canal': { lat: 30.5, lon: 32.3 },
  'Panama Canal': { lat: 9.0, lon: -79.6 },
  'Malacca Strait': { lat: 3.0, lon: 101.5 },
  'Manila': { lat: 14.5995, lon: 120.9842 },
  'Kota Island': { lat: 8.22, lon: 117.2 }, // approximate
  'West Philippine Sea': { lat: 13.0, lon: 118.0 }, // approximate center
};

const VESSEL_KEYWORDS = [
  'container ship', 'bulk carrier', 'tanker', 'cargo vessel', 'freighter',
  'containership', 'vessel', 'ship', 'shipping', 'maritime',
  'port', 'strait', 'canal', 'passage', 'shipping route',
  'merchant', 'cargo', 'import', 'export', 'militia vessel'
];

function extractThreatLevel(title) {
  const titleLower = title.toLowerCase();
  if (titleLower.includes('attack') || titleLower.includes('struck') || titleLower.includes('seized') || titleLower.includes('hijacked') || titleLower.includes('incident') || titleLower.includes('emergency')) return 'critical';
  if (titleLower.includes('disrupted') || titleLower.includes('stranded') || titleLower.includes('grounded') || titleLower.includes('collision') || titleLower.includes('damage')) return 'high';
  if (titleLower.includes('delayed') || titleLower.includes('congestion') || titleLower.includes('rerouted') || titleLower.includes('shortage') || titleLower.includes('closure')) return 'medium';
  return 'low';
}

function extractVesselName(title) {
  const quotedMatch = title.match(/['"“]([^'”"]*)(?:ship|vessel|freighter)['"”]|(?:vessel|ship)\\s+[\"'']?([^'\"\".,;:!?]+)[\"'']?/i);
  if (quotedMatch) return quotedMatch[1] || quotedMatch[2] || 'Unnamed vessel';
  const words = title.split(/\s+/);
  for (let i = 0; i < Math.min(3, words.length); i++) {
    if (VESSEL_KEYWORDS.some(kw => title.toLowerCase().includes(kw))) {
      return words.slice(0, Math.min(i + 2, words.length)).join(' ');
    }
  }
  return 'Unnamed vessel';
}

async function fetchGmaNewsRss() {
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  const response = await fetch('https://data.gmanews.tv/gno/rss/news/feed.xml', {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const xmlText = await response.text();
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
  const rss = jsonResult.rss || jsonResult.RSS;
  const channel = rss.channel;
  let items = channel.item;
  if (!items) items = [];
  else if (!Array.isArray(items)) items = [items];
  function sanitizeTitle(title) {
    if (typeof title !== 'string') return '';
    return title.replace(/<[^>]*>/g, '').replace(/[\\x00-\\x1f\\x7f]/g, '').slice(0, 500).trim();
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
    if (!cleanTitle || !cleanLink) return null;
    const { category, threatLevel } = categorizeStory(cleanTitle);
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
      storyMeta: { sourceCount: 1, uniqueSourceCount: 1 },
      category,
      threatLevel,
      countryCode: null,
      rawDescription: description.substring(0, 500),
    };
  }).filter(Boolean);
  return digestItems;
}

async function extractVesselsFromNews() {
  const newsItems = await fetchGmaNewsRss();
  const maritimeNews = newsItems.filter(item =>
    VESSEL_KEYWORDS.some(kw =>
      (item.title || '').toLowerCase().includes(kw)
    )
  );
  const vessels = [];
  for (const article of maritimeNews) {
    const title = article.title || '';
    const lowerTitle = title.toLowerCase();
    let matched = false;
    for (const [portName, coords] of Object.entries(MAJOR_PORTS)) {
      if (lowerTitle.includes(portName.toLowerCase())) {
        vessels.push({
          id: `news-vessel-${portName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(36).substr(2,5)}`,
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
        break;
      }
    }
    // If no known port matched, we can still create a vessel at a default location if we want
    // For now, we skip if no port match.
  }
  return vessels;
}

(async () => {
  const vessels = await extractVesselsFromNews();
  console.log(`Extracted ${vessels.length} vessels:`);
  vessels.forEach(v => {
    console.log(`- ${v.name} at ${v.lat}, ${v.lon} (${v.port}) threat=${v.threat_level} title="${v.article_title}"`);
  });
})();

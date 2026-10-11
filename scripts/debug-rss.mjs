import { loadEnvFile } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);
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
    function sanitizeTitle(title) {
      if (typeof title !== 'string') return '';
      return title
        .replace(/<[^>]*>/g, '')
        .replace(/[\\x00-\\x1f\\x7f]/g, '')
        .slice(0, 500)
        .trim();
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
      const countryCode = null;
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
    // Print titles
    digestItems.forEach((it, i) => {
      console.log(`${i}: ${it.title}`);
    });
    return digestItems;
  } catch (error) {
    console.error(`  Failed to fetch GMA News RSS: ${error.message}`);
    throw error;
  }
}
fetchGmaNewsRss().catch(e => process.exit(1));

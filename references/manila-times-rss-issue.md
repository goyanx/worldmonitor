# Manila Times RSS Endpoint Issue and Fallback Strategy

## Problem
When attempting to create a seeder for Manila Times news using the URL `https://www.manilatimes.net/rss`, the endpoint returns an HTML landing page instead of an XML RSS feed.

## Evidence
Direct fetch of the URL returns HTML content:
```html
<!DOCTYPE html>
<html itemscope itemtype="https://schema.org/WebPage" lang="en" xml:lang="en" dir="ltr">
<head>
    <!-- ... -->
    <title> RSS Feeds | The Manila Times </title>
    <!-- ... -->
```

This HTML page lists various RSS feed sections but does not contain the actual RSS/XML content needed for a news seeder.

## Root Cause
The Manila Times RSS endpoint `https://www.manilatimes.net/rss` appears to be a landing page that redirects users to section-specific RSS feeds, rather than providing a consolidated RSS feed directly.

## Solution: Google News RSS Fallback
For Manila Times content, use Google News RSS as a reliable fallback:

### General Manila Times News
```
https://news.google.com/rss/search?q=Manila+Times&hl=en-PH&gl=PH&ceid=PH:en
```

### Topic-Specific Queries
Add relevant keywords to the query:
- PCG challenging Chinese research vessel: `q=PCG+challenges+Chinese+research+vessel+Manila+Times`
- West Philippine Sea: `q=West+Philippine+Sea+Manila+Times`
- Philippine Coast Guard: `q=Philippine+Coast+Guard+Manila+Times`

## Implementation Pattern
When building news seeders for Philippine sources that may have problematic direct RSS feeds:

1. **Always verify the endpoint returns XML** before investing effort in a custom seeder
2. **Use Google News RSS as fallback** when direct RSS is unreliable or returns HTML
3. **Process Google News format** by:
   - Removing source suffixes from titles (e.g., " - Manila Times")
   - Extracting source from the `<source>` tag when available
   - Applying the same threat assessment and country code extraction logic

## Verification
Test any potential RSS endpoint with:
```bash
curl -s [URL] | head -5
```
If the output starts with `<!DOCTYPE html>` or contains HTML tags, it's not a valid RSS/XML feed for direct seeding.

## Best Practice
For Philippine news sources, consider:
1. First attempt: Direct RSS feed (if known to be reliable)
2. Fallback: Google News RSS with appropriate query
3. Alternative: Check if the source provides section-specific feeds that might work

This approach was validated with the successful deployment of:
- GMA News RSS seeder (direct feed works)
- ABS-CBN News seeder (Google News fallback works)
- PCG Chinese Vessel News seeder (Google News fallback works)

The Manila Times case demonstrates why verification is crucial before building a seeder - saving time and effort by avoiding dead-end approaches.
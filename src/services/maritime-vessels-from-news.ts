import { toApiUrl } from '@/services/runtime';

export interface NewsVessel {
  id: string;
  name: string;
  lat: number;
  lon: number;
  // Named place the headline put the vessel at. The position is that place's
  // coordinates, not an AIS fix.
  location: string;
  threatLevel: 'critical' | 'high' | 'medium' | 'low';
  articleTitle: string;
  articleUrl: string;
  reportedAt: number;
  // Headlines placing a vessel at this location; the marker shows the latest.
  reportCount: number;
}

let cachedVessels: NewsVessel[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchVesselsFromNews(): Promise<NewsVessel[] | null> {
  const now = Date.now();
  if (cachedVessels && now - cachedAt < CACHE_TTL) return cachedVessels;

  try {
    const resp = await fetch(toApiUrl('/api/maritime-vessels-from-news'), {
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return cachedVessels;

    const raw = await resp.json() as { vessels?: NewsVessel[] };
    cachedVessels = (raw.vessels ?? []).filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon));
    cachedAt = now;
    return cachedVessels;
  } catch {
    return cachedVessels;
  }
}

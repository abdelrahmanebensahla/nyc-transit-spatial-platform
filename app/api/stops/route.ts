import { NextResponse } from 'next/server';
import { getStations } from '@/db/queries/stations';

/**
 * GET /api/stops -> GeoJSON FeatureCollection of subway stations.
 *
 * Parent stations only (location_type = 1), each carrying the list of routes
 * that serve it. Directional platforms are deliberately not returned: they sit
 * on identical coordinates and would double every dot and every popup.
 */
export async function GET() {
  try {
    const collection = await getStations();
    return NextResponse.json(collection, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
    });
  } catch (error) {
    console.error('GET /api/stops failed', error);
    return NextResponse.json({ error: 'failed to load stations' }, { status: 500 });
  }
}

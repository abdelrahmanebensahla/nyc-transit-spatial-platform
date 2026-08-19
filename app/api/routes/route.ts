import { NextResponse } from 'next/server';
import { getRouteLines } from '@/db/queries/route-lines';

/**
 * GET /api/routes -> GeoJSON FeatureCollection of subway route lines.
 *
 * Query params:
 *   tolerance  ST_Simplify tolerance in DEGREES. Default 0.0001 (~10 m at NYC
 *              latitude), which takes the payload from 789 KB to 83 KB. Pass 0
 *              for full precision.
 *
 * Static GTFS is refreshed daily at most, so this is cached hard at the edge
 * and served stale while revalidating. The database should not be touched once
 * per map load.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('tolerance');

  let tolerance: number | undefined;
  if (raw !== null) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.01) {
      return NextResponse.json(
        { error: 'tolerance must be a number between 0 and 0.01 (degrees)' },
        { status: 400 },
      );
    }
    tolerance = parsed;
  }

  try {
    const collection = await getRouteLines(tolerance);
    return NextResponse.json(collection, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
    });
  } catch (error) {
    console.error('GET /api/routes failed', error);
    return NextResponse.json({ error: 'failed to load route lines' }, { status: 500 });
  }
}

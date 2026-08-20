import { NextResponse } from 'next/server';
import { getVehicles } from '@/db/queries/vehicles';

/**
 * GET /api/vehicles -> GeoJSON of current train positions.
 *
 * Never cached. Everything else in this API is static GTFS behind a long
 * s-maxage; this changes every 30 seconds and a cached response would show
 * stale trains.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const collection = await getVehicles();
    return NextResponse.json(collection, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('GET /api/vehicles failed', error);
    return NextResponse.json({ error: 'failed to load vehicle positions' }, { status: 500 });
  }
}

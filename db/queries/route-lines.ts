import { sql } from 'drizzle-orm';
import { getDb } from '../client';
import type { RouteLineCollection } from '@/lib/geojson';

/**
 * Default ST_Simplify tolerance, in DEGREES.
 *
 * ST_Simplify is planar and the geometry is EPSG:4326, so the unit is degrees,
 * not meters. 0.0001 deg is about 11 m north-south and 8 m east-west at NYC's
 * latitude — invisible at any zoom where the whole system is on screen, and it
 * cuts the payload from 777 KB to 71 KB.
 *
 * This affects DISPLAY geometry only. Position interpolation in Phase 4 reads
 * shapes.geom directly at full precision, so a train can sit up to ~10 m off
 * the drawn line at extreme zoom. Pass tolerance 0 to disable.
 */
const DEFAULT_TOLERANCE_DEGREES = 0.0001;

/**
 * One line per (route_id, direction_id), choosing the longest shape.
 *
 * The MTA publishes 250 distinct shapes for 28 routes — route 5 alone has 35,
 * covering branches and short-turns. Drawing all of them is 3.2 MB of heavily
 * overlapping geometry. The longest shape per direction is the trunk of the
 * route, which is what a system map wants. Branch variants are deliberately
 * not drawn in v1.
 *
 * The FeatureCollection is built in Postgres: json_agg over ST_AsGeoJSON keeps
 * the coordinates as text the whole way, instead of parsing 56 arrays into JS
 * objects only to serialise them again.
 */
export async function getRouteLines(
  toleranceDegrees: number = DEFAULT_TOLERANCE_DEGREES,
): Promise<RouteLineCollection> {
  const geometry =
    toleranceDegrees > 0
      ? sql`ST_AsGeoJSON(ST_Simplify(sh.geom::geometry, ${toleranceDegrees}), 6)::json`
      : sql`ST_AsGeoJSON(sh.geom, 6)::json`;

  const rows = await getDb().execute<{ collection: RouteLineCollection }>(sql`
    -- Collapse trips to distinct (route, direction, shape) triples BEFORE
    -- touching geometry. Joining shapes to trips directly makes Postgres
    -- evaluate ST_Length over 67,491 rows -- a geodesic length across
    -- multi-hundred-vertex linestrings, recomputed for every trip sharing a
    -- shape -- only to discard all but 56. There are 250 distinct triples.
    -- Measured against Neon: 12.58s before, 0.157s after, same output.
    WITH pairs AS (
      SELECT DISTINCT route_id, direction_id, shape_id
      FROM trips
      WHERE shape_id IS NOT NULL
    ),
    representative AS (
      SELECT DISTINCT ON (p.route_id, p.direction_id)
        p.route_id,
        p.direction_id,
        sh.shape_id,
        sh.geom
      FROM pairs p
      JOIN shapes sh ON sh.shape_id = p.shape_id
      -- shape_id is an explicit tiebreak, not decoration. MTA publishes the
      -- same physical alignment under several shape_ids for different service
      -- patterns, so lengths tie exactly: 1..N03R and 1..N15R are both
      -- 23505.176094 m, and route 4 has three shapes tied at 36859.093450 m.
      -- Without it DISTINCT ON picks arbitrarily and the endpoint returns a
      -- different shape_id between requests.
      ORDER BY p.route_id, p.direction_id, ST_Length(sh.geom) DESC, sh.shape_id
    )
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ${geometry},
          'properties', json_build_object(
            'shape_id',         sh.shape_id,
            'route_id',         r.route_id,
            'route_short_name', r.route_short_name,
            'route_long_name',  r.route_long_name,
            -- GTFS stores colour without the '#'; add it once, here, rather
            -- than in every renderer that consumes this.
            'route_color',      '#' || COALESCE(r.route_color, '6B7280'),
            'route_text_color', '#' || COALESCE(r.route_text_color, 'FFFFFF'),
            'direction_id',     sh.direction_id
          )
        )
        ORDER BY r.route_id, sh.direction_id
      ), '[]'::json)
    ) AS collection
    FROM representative sh
    JOIN routes r ON r.route_id = sh.route_id
  `);

  return rows.rows[0].collection;
}

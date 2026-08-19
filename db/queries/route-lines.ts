import { sql } from 'drizzle-orm';
import { db } from '../client';
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

  const rows = await db.execute<{ collection: RouteLineCollection }>(sql`
    WITH representative AS (
      SELECT DISTINCT ON (t.route_id, t.direction_id)
        t.route_id,
        t.direction_id,
        sh.shape_id,
        sh.geom
      FROM trips t
      JOIN shapes sh ON sh.shape_id = t.shape_id
      WHERE t.shape_id IS NOT NULL
      ORDER BY t.route_id, t.direction_id, ST_Length(sh.geom) DESC
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

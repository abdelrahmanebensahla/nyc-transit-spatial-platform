import { sql } from 'drizzle-orm';
import { getDb } from '../client';
import type { VehicleCollection } from '@/lib/geojson';

/**
 * Trains have no coordinates in the feed. This derives them.
 *
 * The NYCT GTFS-Realtime feed gives trip_id, stop_id and current_status and
 * nothing else — no lat/lon. Position is reconstructed by linear referencing
 * along the route shape:
 *
 *   STOPPED_AT      -> the fraction of that stop along the shape, exactly
 *   IN_TRANSIT_TO   -> interpolated between the previous stop's fraction and
 *                      the next stop's, weighted by elapsed time
 *
 * `progress` is estimated from geometry rather than TripUpdates: the distance
 * between the two fractions times the shape's length gives metres, divided by
 * a nominal running speed. Crude, but it degrades gracefully and needs no
 * second feed. Swapping in TripUpdates' predicted arrival is a later
 * refinement, and only changes this one expression.
 *
 * `position_source` is returned so a wrong-looking train can be traced to the
 * branch that placed it.
 */

/** Nominal between-station running speed, m/s. ~40 km/h. */
const RUNNING_SPEED_MPS = 11;

/** Observations older than this are treated as stale and dropped. */
const FRESHNESS_MINUTES = 10;

export async function getVehicles(): Promise<VehicleCollection> {
  const rows = await getDb().execute<{ collection: VehicleCollection }>(sql`
    WITH latest AS (
      -- One row per train: its most recent observation.
      SELECT DISTINCT ON (vp.trip_id, vp.trip_start_date)
        vp.trip_id, vp.trip_start_date, vp.route_id,
        vp.stop_id, vp.current_status, vp.observed_at
      FROM vehicle_positions vp
      WHERE vp.observed_at > now() - (${FRESHNESS_MINUTES} || ' minutes')::interval
      ORDER BY vp.trip_id, vp.trip_start_date, vp.observed_at DESC
    ),
    shaped AS (
      -- trips.rt_trip_id is a generated column holding the static trip_id with
      -- its leading service-id segment removed, which is exactly the RT form.
      -- Equality against an index; the LIKE suffix match it replaced scanned
      -- all 79,194 trips per train. ~82% coverage either way.
      SELECT l.*, m.shape_id
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT t.shape_id FROM trips t
        WHERE t.rt_trip_id = l.trip_id AND t.shape_id IS NOT NULL
        LIMIT 1
      ) m ON true
    ),
    with_prev AS (
      SELECT s.*, p.stop_id AS prev_stop_id, p.observed_at AS prev_at
      FROM shaped s
      LEFT JOIN LATERAL (
        SELECT vp.stop_id, vp.observed_at
        FROM vehicle_positions vp
        WHERE vp.trip_id = s.trip_id
          AND vp.trip_start_date = s.trip_start_date
          AND vp.current_status = 'STOPPED_AT'
          AND vp.stop_id IS DISTINCT FROM s.stop_id
          AND vp.observed_at <= s.observed_at
        ORDER BY vp.observed_at DESC
        LIMIT 1
      ) p ON true
    ),
    located AS (
      SELECT
        w.*,
        sh.geom AS shape_geom,
        nxt.fraction AS next_fraction,
        prv.fraction AS prev_fraction,
        ST_Length(sh.geom) AS shape_meters
      FROM with_prev w
      LEFT JOIN shapes sh ON sh.shape_id = w.shape_id
      LEFT JOIN shape_stop_positions nxt
             ON nxt.shape_id = w.shape_id AND nxt.stop_id = w.stop_id
      LEFT JOIN shape_stop_positions prv
             ON prv.shape_id = w.shape_id AND prv.stop_id = w.prev_stop_id
    ),
    positioned AS (
      SELECT
        l.*,
        CASE
          -- Stopped and on a known shape: exact fraction, no estimation.
          WHEN l.current_status = 'STOPPED_AT' AND l.next_fraction IS NOT NULL
            THEN ST_LineInterpolatePoint(l.shape_geom::geometry, l.next_fraction)
          -- Moving between two known stops: interpolate, clamped to [0,1].
          WHEN l.prev_fraction IS NOT NULL AND l.next_fraction IS NOT NULL
            THEN ST_LineInterpolatePoint(
                   l.shape_geom::geometry,
                   l.prev_fraction + (l.next_fraction - l.prev_fraction) * least(1.0, greatest(0.0,
                     EXTRACT(EPOCH FROM (now() - l.prev_at))
                     / nullif(abs(l.next_fraction - l.prev_fraction) * l.shape_meters / ${RUNNING_SPEED_MPS}, 0)
                   ))
                 )
          -- No shape match: fall back to the station point itself. Better a
          -- train pinned at its stop than a train missing from the map.
          ELSE st.geom::geometry
        END AS position,
        CASE
          WHEN l.current_status = 'STOPPED_AT' AND l.next_fraction IS NOT NULL THEN 'shape_stop'
          WHEN l.prev_fraction IS NOT NULL AND l.next_fraction IS NOT NULL THEN 'interpolated'
          ELSE 'station_fallback'
        END AS position_source
      FROM located l
      LEFT JOIN stops st ON st.stop_id = l.stop_id
    )
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(p.position, 6)::json,
          'properties', json_build_object(
            'trip_id',         p.trip_id,
            'route_id',        p.route_id,
            'route_color',     '#' || COALESCE(r.route_color, '6B7280'),
            'stop_id',         p.stop_id,
            'stop_name',       s.stop_name,
            'current_status',  p.current_status,
            'observed_at',     to_char(p.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'position_source', p.position_source
          )
        )
      ), '[]'::json)
    ) AS collection
    FROM positioned p
    LEFT JOIN routes r ON r.route_id = p.route_id
    LEFT JOIN stops s ON s.stop_id = p.stop_id
    WHERE p.position IS NOT NULL
  `);

  return rows.rows[0].collection;
}

import { sql } from 'drizzle-orm';
import { getDb } from '../client';
import type { StationCollection } from '@/lib/geojson';

/**
 * Parent stations only, with the routes that serve them.
 *
 * location_type = 1 is the station; its 127N/127S children are the platforms
 * that stop_times actually references. Returning platforms here would put two
 * coincident dots on every station and double every popup.
 *
 * The route list is therefore gathered by walking DOWN to the child platforms
 * and back up through stop_times -> trips -> routes. That join is the whole
 * reason parent_station is modelled as a foreign key.
 *
 * Only stations with at least one route are returned. stops.txt ships the 21
 * Staten Island Railway stations (S09 Tottenville .. S31 St George) whether or
 * not SIR routes are loaded, and the loader excludes route_type 2, so they
 * would otherwise render as orphan dots with empty popups. Keying the filter on
 * "has service" rather than on a hardcoded prefix means it stays correct if the
 * route_type filter in loader/config.py ever changes.
 *
 * Caveat worth knowing: MTA models one physical complex as SEVERAL stations.
 * Times Sq-42 St is 127 (1/2/3), 725 (7) and 902 (shuttle), linked only by
 * transfers.txt, which this schema does not load. Expect near-coincident dots
 * sharing a name. Merging them is transfer-graph work, and belongs with the
 * Phase 5 transfer analysis rather than here.
 */
export async function getStations(): Promise<StationCollection> {
  const rows = await getDb().execute<{ collection: StationCollection }>(sql`
    WITH station_routes AS (
      SELECT
        COALESCE(child.parent_station, child.stop_id) AS station_id,
        array_agg(DISTINCT r.route_short_name ORDER BY r.route_short_name) AS routes
      FROM stop_times st
      JOIN stops child ON child.stop_id = st.stop_id
      JOIN trips t     ON t.trip_id = st.trip_id
      JOIN routes r    ON r.route_id = t.route_id
      GROUP BY 1
    )
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'geometry', ST_AsGeoJSON(s.geom, 6)::json,
          'properties', json_build_object(
            'stop_id',   s.stop_id,
            'stop_name', s.stop_name,
            'routes',    sr.routes
          )
        )
        ORDER BY s.stop_id
      ), '[]'::json)
    ) AS collection
    FROM stops s
    JOIN station_routes sr ON sr.station_id = s.stop_id
    WHERE s.location_type = 1
  `);

  return rows.rows[0].collection;
}

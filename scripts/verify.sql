-- Sanity checks for a freshly loaded database.
--
--   python scripts/run_sql.py scripts/verify.sql
--   psql "$DATABASE_URL_UNPOOLED" -f scripts/verify.sql   (if you have psql)
--
-- Everything here is read-only. Expected shapes of the answers are noted inline.

\timing off
\pset pager off

ANALYZE;

-- ===========================================================================
-- 1. Row counts
--
-- Measured against the supplemented feed of 2026-08-17. Trips and stop_times
-- move with the service calendar; routes, stops and shapes should barely drift.
--
--   routes                    28   (Staten Island Railway excluded by design)
--   stops                  1,488   (496 stations + 992 directional platforms)
--   shapes                   257
--   trips                 79,194
--   stop_times         2,314,945
--   shape_stop_positions   7,254  (after populate_shape_stop_positions.sql)
-- ===========================================================================
\echo
\echo '== 1. row counts =='
SELECT 'routes'               AS table_name, count(*) AS rows FROM routes
UNION ALL SELECT 'stops',                    count(*) FROM stops
UNION ALL SELECT 'shapes',                   count(*) FROM shapes
UNION ALL SELECT 'trips',                    count(*) FROM trips
UNION ALL SELECT 'stop_times',               count(*) FROM stop_times
UNION ALL SELECT 'shape_stop_positions',     count(*) FROM shape_stop_positions
ORDER BY table_name;

-- ===========================================================================
-- 2. The interval decision, demonstrated
--
-- max_arrival MUST exceed 24:00:00 and past_midnight MUST be non-zero. If they
-- are not, either the feed changed or something coerced these into `time` and
-- silently wrapped the overnight service — which is the failure this column
-- type exists to prevent.
--
-- Measured 2026-08-17: max_arrival 28:02:00, past_midnight 70,555. That is
-- 70,555 rows a `time` column would have rejected or mangled.
-- ===========================================================================
\echo
\echo '== 2. stop_times past 24:00:00 (must be non-zero) =='
SELECT
  max(arrival_time)::text                                            AS max_arrival,
  count(*) FILTER (WHERE arrival_time >= interval '24 hours')        AS past_midnight,
  count(*) FILTER (WHERE arrival_time >= interval '28 hours')        AS past_28h
FROM stop_times;

-- ===========================================================================
-- 3. Station / platform structure
--
-- orphan_parents must be 0 — the foreign key guarantees it, so a non-zero
-- result means the constraint is missing. The platform:station ratio should sit
-- near 2:1, which is the double-counting that parent_station exists to prevent.
-- ===========================================================================
\echo
\echo '== 3. parent_station structure =='
SELECT
  count(*) FILTER (WHERE location_type = 1)                       AS stations,
  count(*) FILTER (WHERE parent_station IS NOT NULL)              AS platforms,
  count(*) FILTER (
    WHERE parent_station IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM stops p WHERE p.stop_id = stops.parent_station)
  )                                                               AS orphan_parents
FROM stops;

\echo
\echo '== 3b. stop_times at Times Sq-42 St: naive vs rolled up to the station =='
SELECT
  -- Grouping by stop_id splits one station into its two directional platforms.
  -- Joining on the station id alone finds nothing, because stop_times never
  -- references a location_type=1 row. Both are wrong; only the roll-up is right.
  (SELECT count(*) FROM stop_times WHERE stop_id = '127')          AS by_station_id_alone,
  (SELECT count(*) FROM stop_times WHERE stop_id = '127N')         AS platform_127n,
  (SELECT count(*) FROM stop_times WHERE stop_id = '127S')         AS platform_127s,
  (SELECT count(*) FROM stop_times st
     JOIN stops s ON s.stop_id = st.stop_id
    WHERE s.parent_station = '127' OR s.stop_id = '127')           AS rolled_up_through_parent;

-- ===========================================================================
-- 4. A route shape as GeoJSON
--
-- ST_Length on a geography column returns METERS with no projection step. A
-- full-length 1 train shape measures 23,505 m over 266 vertices.
-- ===========================================================================
\echo
\echo '== 4. one shape, rendered =='
SELECT
  sh.shape_id,
  r.route_short_name                                   AS route,
  ST_NPoints(sh.geom::geometry)                        AS vertices,
  ST_IsValid(sh.geom::geometry)                        AS valid,
  round(ST_Length(sh.geom)::numeric)                   AS length_meters,
  left(ST_AsGeoJSON(sh.geom, 6), 180) || ' ...'        AS geojson_head
FROM shapes sh
JOIN trips t  ON t.shape_id = sh.shape_id
JOIN routes r ON r.route_id = t.route_id
WHERE r.route_short_name = '1'
ORDER BY ST_Length(sh.geom) DESC
LIMIT 1;

-- Full GeoJSON, if you want to paste it into geojson.io:
--   \o /tmp/shape.geojson
--   SELECT ST_AsGeoJSON(geom, 6) FROM shapes WHERE shape_id = '<paste from above>';
--   \o

-- ===========================================================================
-- 5. ST_DWithin between two known stations
--
-- 127 = Times Sq-42 St, 631 = Grand Central-42 St. Both confirmed present in
-- the feed as location_type 1. Great-circle distance between the two published
-- coordinates is 978.3 m, so expect meters ~978, within_1km true, within_200m
-- false. ST_Distance on geography is spheroidal rather than spherical, so it
-- should land within a metre or so of that figure — not identical to it.
--
-- A wildly different number means the coordinates went in as (lat, lon) rather
-- than (lon, lat).
--
-- ST_DWithin rather than ST_Distance < n because only the former can use the
-- GiST index — it tests the bounding boxes first. ST_Distance computes every
-- pair before comparing.
-- ===========================================================================
\echo
\echo '== 5. distance between two known stations (expect ~980 m) =='
SELECT
  a.stop_id                                     AS from_id,
  a.stop_name                                   AS from_name,
  b.stop_id                                     AS to_id,
  b.stop_name                                   AS to_name,
  round(ST_Distance(a.geom, b.geom)::numeric, 1) AS meters,
  ST_DWithin(a.geom, b.geom, 200)               AS within_200m,
  ST_DWithin(a.geom, b.geom, 1000)              AS within_1km
FROM stops a
CROSS JOIN stops b
WHERE a.stop_id = '127' AND b.stop_id = '631';

-- If the MTA renumbers and the above returns no rows, look them up by name:
--   SELECT stop_id, stop_name FROM stops
--    WHERE location_type = 1 AND stop_name ILIKE ANY (ARRAY['Times Sq%', 'Grand Central%']);

-- ===========================================================================
-- 6. Confirm the GiST index is actually used
--
-- The transfer-proximity self-join is the honest test: with ~1,500 stops a
-- single-point lookup is small enough that the planner may reasonably prefer a
-- sequential scan, but 1,500 x 1,500 pairs is not, so the index should win.
--
-- Look for "Index Scan using stops_geom_idx" in the output below.
--
-- Computed independently from the feed: 73 station pairs fall within 200 m, so
-- this returns real rows rather than trivially empty ones. (The query then
-- filters those down by parent_station.)
-- ===========================================================================
\echo
\echo '== 6. EXPLAIN: expect Index Scan using stops_geom_idx =='
EXPLAIN (ANALYZE, BUFFERS)
SELECT a.stop_id, b.stop_id, ST_Distance(a.geom, b.geom) AS meters
FROM stops a
JOIN stops b
  ON a.stop_id < b.stop_id
 AND ST_DWithin(a.geom, b.geom, 200)
WHERE a.location_type = 1
  AND b.location_type = 1
  AND a.parent_station IS DISTINCT FROM b.parent_station;

-- If that came back as a seq scan, the index is still fine — the table is just
-- small. Prove it is usable and correct by forcing the planner's hand:
--   SET enable_seqscan = off;
--   EXPLAIN (ANALYZE, BUFFERS) <same query>;
--   RESET enable_seqscan;

-- ===========================================================================
-- 7. shape_stop_positions
--
-- Only meaningful after scripts/populate_shape_stop_positions.sql has run.
-- Fractions must be within [0, 1]; out_of_range must be 0.
-- ===========================================================================
\echo
\echo '== 7. shape_stop_positions =='
SELECT
  count(*)                                                  AS rows,
  count(*) FILTER (WHERE fraction < 0 OR fraction > 1)      AS out_of_range,
  count(*) FILTER (WHERE fraction IN (0, 1))                AS endpoint_pinned,
  round(avg(fraction)::numeric, 4)                          AS avg_fraction
FROM shape_stop_positions;

-- End-to-end: interpolate a point halfway between two consecutive stops on one
-- shape. This is exactly the Phase 3 realtime position derivation, run against
-- static data. It should return a coordinate on the line, not NULL.
\echo
\echo '== 7b. interpolated midpoint between two consecutive stops =='
WITH pair AS (
  SELECT
    p.shape_id,
    p.stop_id                                          AS prev_stop,
    lead(p.stop_id)  OVER w                            AS next_stop,
    p.fraction                                         AS prev_fraction,
    lead(p.fraction) OVER w                            AS next_fraction
  FROM shape_stop_positions p
  WINDOW w AS (PARTITION BY p.shape_id ORDER BY p.fraction)
  LIMIT 200
)
SELECT
  pair.shape_id,
  pair.prev_stop,
  pair.next_stop,
  ST_AsGeoJSON(
    ST_LineInterpolatePoint(
      sh.geom::geometry,
      pair.prev_fraction + (pair.next_fraction - pair.prev_fraction) * 0.5
    ),
    6
  ) AS midpoint
FROM pair
JOIN shapes sh ON sh.shape_id = pair.shape_id
WHERE pair.next_stop IS NOT NULL
LIMIT 1;

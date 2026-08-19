-- Populate shape_stop_positions: how far along each shape every stop it serves
-- sits, as a fraction in [0, 1].
--
-- Run once after every static load:
--   psql "$DATABASE_URL_UNPOOLED" -f scripts/populate_shape_stop_positions.sql
--
-- Why the fraction is precomputed: the subway realtime feed supplies no train
-- coordinates. Position is derived by interpolating between the fraction of the
-- last stop and the fraction of the next one. Doing the ST_LineLocatePoint at
-- render time would mean walking a full route line per train per poll; here it
-- is a primary key lookup.
--
-- Why ::geometry: ST_LineLocatePoint has no geography implementation. Linear
-- referencing on a spheroid is not a shipped PostGIS operation, so the cast is
-- mandatory. It reinterprets rather than reprojects, so the measurement happens
-- in degree space — see the README for the size of that distortion.

BEGIN;

TRUNCATE shape_stop_positions;

-- The distinct (shape_id, stop_id) pairs are collapsed BEFORE the spatial call
-- rather than after. The literal form in the spec joins stop_times and applies
-- DISTINCT to the result, which asks Postgres for ~2M ST_LineLocatePoint
-- evaluations against full route linestrings and then throws almost all of them
-- away. Same output, a few thousand calls instead.
WITH served AS (
  SELECT DISTINCT t.shape_id, st.stop_id
  FROM trips t
  JOIN stop_times st ON st.trip_id = t.trip_id
  WHERE t.shape_id IS NOT NULL
)
INSERT INTO shape_stop_positions (shape_id, stop_id, fraction)
SELECT
  served.shape_id,
  served.stop_id,
  ST_LineLocatePoint(sh.geom::geometry, s.geom::geometry)
FROM served
JOIN shapes sh ON sh.shape_id = served.shape_id
JOIN stops  s  ON s.stop_id  = served.stop_id
ON CONFLICT (shape_id, stop_id) DO NOTHING;

COMMIT;

ANALYZE shape_stop_positions;

\echo
\echo '== shape_stop_positions =='
SELECT
  count(*)                                        AS rows,
  count(DISTINCT shape_id)                        AS shapes,
  count(DISTINCT stop_id)                         AS stops,
  round(min(fraction)::numeric, 6)                AS min_fraction,
  round(max(fraction)::numeric, 6)                AS max_fraction
FROM shape_stop_positions;

-- A fraction pinned to exactly 0 or 1 means the stop projected onto an endpoint
-- of the line. Two or three per shape is normal (the real terminals). A large
-- count means stops are being matched to shapes they do not actually sit on.
\echo
\echo '== endpoint-pinned fractions (expect roughly 2 per shape) =='
SELECT count(*) AS pinned
FROM shape_stop_positions
WHERE fraction <= 0.0 OR fraction >= 1.0;

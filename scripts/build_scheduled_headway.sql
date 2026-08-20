-- Roll stop_times up into scheduled headway, then release the raw table.
--
--   python scripts/run_sql.py scripts/build_scheduled_headway.sql
--
-- Run AFTER the loader and AFTER populate_shape_stop_positions.sql, both of
-- which need raw stop_times. This is the last consumer of it.
--
-- Why: stop_times is 397 MB of a 512 MB tier and every analytic consumes it as
-- "how often is this route scheduled at this stop in this hour". That is 38k
-- rows. Keeping the answer instead of the raw data is what makes room for
-- realtime ingestion.

BEGIN;

TRUNCATE scheduled_headway;

-- Gaps are computed WITHIN a service_id. Consecutive rows across different
-- service patterns (weekday vs weekend) are not a headway -- they are two
-- different timetables interleaved, and differencing them is meaningless.
WITH departures AS (
  SELECT
    st.stop_id,
    t.route_id,
    t.service_id,
    st.departure_time,
    floor(EXTRACT(EPOCH FROM st.departure_time) / 3600)::smallint AS hour_bucket
  FROM stop_times st
  JOIN trips t ON t.trip_id = st.trip_id
  WHERE st.departure_time IS NOT NULL
),
gaps AS (
  SELECT
    stop_id,
    route_id,
    hour_bucket,
    EXTRACT(EPOCH FROM (
      departure_time - lag(departure_time) OVER (
        PARTITION BY service_id, stop_id, route_id ORDER BY departure_time
      )
    )) AS gap_seconds
  FROM departures
)
INSERT INTO scheduled_headway (stop_id, route_id, hour_bucket, scheduled_trips, headway_p50_seconds, headway_p90_seconds)
SELECT
  stop_id,
  route_id,
  hour_bucket,
  count(*) AS scheduled_trips,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_seconds)::int AS headway_p50_seconds,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY gap_seconds)::int AS headway_p90_seconds
FROM gaps
-- Below 60s is a data artefact; above 2h is an overnight gap, not a headway.
WHERE gap_seconds BETWEEN 60 AND 7200
  AND hour_bucket BETWEEN 0 AND 47
GROUP BY stop_id, route_id, hour_bucket
ON CONFLICT (stop_id, route_id, hour_bucket) DO NOTHING;

COMMIT;

ANALYZE scheduled_headway;

\echo
\echo '== scheduled_headway =='
SELECT
  count(*)                                AS rows,
  count(DISTINCT stop_id)                 AS stops,
  count(DISTINCT route_id)                AS routes,
  min(hour_bucket)                        AS min_hour,
  max(hour_bucket)                        AS max_hour,
  round(avg(headway_p50_seconds))         AS avg_p50_seconds
FROM scheduled_headway;

\echo
\echo '== busiest scheduled service (lowest median headway) =='
SELECT sh.stop_id, s.stop_name, sh.route_id, sh.hour_bucket,
       sh.headway_p50_seconds, sh.scheduled_trips
FROM scheduled_headway sh JOIN stops s ON s.stop_id = sh.stop_id
WHERE sh.scheduled_trips > 5
ORDER BY sh.headway_p50_seconds ASC, sh.scheduled_trips DESC
LIMIT 5;

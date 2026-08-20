-- Make RT -> static trip matching an indexed equality instead of a scan.
--
-- The RT feed's trip_id is the static trip_id with its leading service-id
-- segment removed:
--
--   static  L0S1-SI-3017-S13_000600_SI.S03R
--   RT                       086750_1..N15R
--
-- Matching with LIKE '%\_' || rt_id cannot use an index, so every /api/vehicles
-- request scanned all 79,194 trips once per train. Measured at 4.65s for 669
-- trains.
--
-- A generated column holds the RT form directly, so the join becomes an
-- equality against a btree. GENERATED ALWAYS keeps it correct through loader
-- refreshes with no extra step to forget.

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS rt_trip_id text
  GENERATED ALWAYS AS (substring(trip_id from position('_' in trip_id) + 1)) STORED;

CREATE INDEX IF NOT EXISTS trips_rt_trip_id_idx ON trips (rt_trip_id);

ANALYZE trips;

-- Phase 3: realtime ingestion tables.
--
--   python scripts/run_sql.py drizzle/0001_realtime.sql
--
-- Idempotent, safe to re-run.

-- ---------------------------------------------------------------------------
-- scheduled_headway
--
-- Replaces raw stop_times as the schedule reference. stop_times is 397 MB of
-- the 512 MB tier and the analytics only ever consume it as "how often is this
-- route scheduled at this stop in this hour" -- 38,036 rows, about 2.2 MB.
-- Keeping the rollup and releasing the raw table is what makes room for
-- realtime data at all. See scripts/build_scheduled_headway.sql.
--
-- hour_bucket is a SERVICE-DAY hour and legitimately exceeds 23: a trip
-- departing 00:47 on a Saturday that belongs to Friday's service day lands in
-- hour 24. Same reason stop_times used interval rather than time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_headway (
  stop_id             text     NOT NULL REFERENCES stops(stop_id),
  route_id            text     NOT NULL REFERENCES routes(route_id),
  hour_bucket         smallint NOT NULL,
  scheduled_trips     integer  NOT NULL,
  headway_p50_seconds integer,
  headway_p90_seconds integer,
  PRIMARY KEY (stop_id, route_id, hour_bucket),
  CONSTRAINT scheduled_headway_hour_range CHECK (hour_bucket BETWEEN 0 AND 47)
);

CREATE INDEX IF NOT EXISTS scheduled_headway_route_idx ON scheduled_headway (route_id, hour_bucket);

-- ---------------------------------------------------------------------------
-- vehicle_positions
--
-- No geometry column: the NYCT subway feed supplies no train coordinates.
-- Position is derived at render time from shape_stop_positions.
--
-- trip_start_date is NOT in the spec's section 4 schema, and is added
-- deliberately. Measured against the live feed: an RT trip_id matches up to 10
-- static trips, because the same pattern runs under several service_ids. The
-- (trip_id, start_date) pair is what actually identifies one run of a train.
--
-- Partitioned by day so retention is a DETACH/DROP rather than a mass DELETE,
-- which on a tier this size matters: deleting rows does not return space until
-- vacuum, dropping a partition returns it immediately.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_positions (
  id              bigserial,
  trip_id         text        NOT NULL,
  trip_start_date date        NOT NULL,
  route_id        text        NOT NULL,
  stop_id         text,
  current_status  text,
  observed_at     timestamptz NOT NULL,
  PRIMARY KEY (id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Deliberately NOT a foreign key to trips or stops. The feed references trips
-- absent from the static snapshot (82.5% match rate, measured) and internal
-- track locations absent from stops (2 of 386). Rejecting those rows would
-- discard real observations; they are recorded and reconciled downstream.
CREATE INDEX IF NOT EXISTS vehicle_positions_trip_idx
  ON vehicle_positions (trip_id, trip_start_date, observed_at DESC);

-- ---------------------------------------------------------------------------
-- stop_events
--
-- Derived: a transition INTO current_status = 'STOPPED_AT' for a given stop is
-- an arrival. This is what every analytic runs on.
--
-- The spec calls this table "small" and permanent. Measured, it is not small --
-- roughly 200k arrivals a day, ~20 MB. It is kept permanent here anyway because
-- it is the irreplaceable record, but it is the table to watch for growth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stop_events (
  id              bigserial PRIMARY KEY,
  trip_id         text        NOT NULL,
  trip_start_date date        NOT NULL,
  route_id        text        NOT NULL,
  stop_id         text        NOT NULL,
  arrived_at      timestamptz NOT NULL,
  scheduled_at    timestamptz,
  delay_seconds   integer,
  CONSTRAINT stop_events_unique_arrival UNIQUE (trip_id, trip_start_date, stop_id)
);

CREATE INDEX IF NOT EXISTS stop_events_stop_time_idx ON stop_events (stop_id, arrived_at DESC);
CREATE INDEX IF NOT EXISTS stop_events_route_time_idx ON stop_events (route_id, arrived_at DESC);

-- ---------------------------------------------------------------------------
-- Partition maintenance
--
-- Called by the poller, not pg_cron: Neon suspends compute on inactivity and
-- pg_cron jobs do not fire while suspended, so in-database scheduling would
-- silently stop running.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_vehicle_position_partitions(days_ahead integer DEFAULT 2)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  day      date;
  created  integer := 0;
  partition_name text;
BEGIN
  FOR day IN
    SELECT generate_series(current_date - 1, current_date + days_ahead, interval '1 day')::date
  LOOP
    partition_name := format('vehicle_positions_%s', to_char(day, 'YYYYMMDD'));
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF vehicle_positions FOR VALUES FROM (%L) TO (%L)',
        partition_name, day, day + 1
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION drop_old_vehicle_position_partitions(keep_days integer DEFAULT 3)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  rec     record;
  dropped integer := 0;
  cutoff  date := current_date - keep_days;
BEGIN
  FOR rec IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'vehicle_positions'
      AND c.relname ~ '^vehicle_positions_\d{8}$'
      AND to_date(right(c.relname, 8), 'YYYYMMDD') < cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', rec.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END;
$$;

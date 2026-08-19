-- Phase 1: PostGIS foundation + GTFS static tables.
-- Hand-written rather than drizzle-kit generated: the extension, the geography
-- column types, and the GiST index operator classes are all outside what
-- drizzle-kit introspects.
--
-- Apply with:  psql "$DATABASE_URL_UNPOOLED" -f drizzle/0000_init.sql
-- Idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- routes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
  route_id         text PRIMARY KEY,
  route_short_name text NOT NULL,
  route_long_name  text,
  route_color      text,
  route_text_color text
);

-- ---------------------------------------------------------------------------
-- stops
--
-- geography, not geometry: ST_Distance / ST_DWithin on geography return and
-- accept meters on the spheroid, which is what the transfer-proximity queries
-- need. Casting to geometry happens at the two call sites that require it.
--
-- parent_station is a self-reference. MTA platforms (127N, 127S) point at their
-- station (127); the station's own parent_station is NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stops (
  stop_id        text PRIMARY KEY,
  stop_name      text NOT NULL,
  parent_station text REFERENCES stops(stop_id),
  location_type  smallint,
  geom           geography(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS stops_geom_idx ON stops USING GIST (geom);
CREATE INDEX IF NOT EXISTS stops_parent_station_idx ON stops (parent_station);

-- ---------------------------------------------------------------------------
-- shapes
--
-- One LineString per shape_id, built by the loader from shapes.txt ordered by
-- shape_pt_sequence. Must stay single-part: ST_LineLocatePoint and
-- ST_LineInterpolatePoint both error on MultiLineString.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shapes (
  shape_id text PRIMARY KEY,
  geom     geography(LineString, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS shapes_geom_idx ON shapes USING GIST (geom);

-- ---------------------------------------------------------------------------
-- trips
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
  trip_id      text PRIMARY KEY,
  route_id     text NOT NULL REFERENCES routes(route_id),
  service_id   text NOT NULL,
  shape_id     text REFERENCES shapes(shape_id),
  direction_id smallint
);

CREATE INDEX IF NOT EXISTS trips_route_idx ON trips (route_id);
CREATE INDEX IF NOT EXISTS trips_shape_idx ON trips (shape_id);

-- ---------------------------------------------------------------------------
-- stop_times
--
-- interval, not time. GTFS times past 24:00:00 are legal and common for trips
-- that cross midnight; `time` would reject '24:47:00' outright.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stop_times (
  trip_id        text NOT NULL REFERENCES trips(trip_id),
  stop_sequence  integer NOT NULL,
  stop_id        text NOT NULL REFERENCES stops(stop_id),
  arrival_time   interval,
  departure_time interval,
  PRIMARY KEY (trip_id, stop_sequence)
);

CREATE INDEX IF NOT EXISTS stop_times_stop_idx ON stop_times (stop_id);

-- ---------------------------------------------------------------------------
-- shape_stop_positions
--
-- Populated once per static load by scripts/populate_shape_stop_positions.sql,
-- via ST_LineLocatePoint. Powers realtime position interpolation in Phase 3.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shape_stop_positions (
  shape_id text NOT NULL REFERENCES shapes(shape_id),
  stop_id  text NOT NULL REFERENCES stops(stop_id),
  fraction double precision NOT NULL,
  PRIMARY KEY (shape_id, stop_id)
);

CREATE INDEX IF NOT EXISTS shape_stop_positions_stop_idx ON shape_stop_positions (stop_id);

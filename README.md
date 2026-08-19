# NYC Transit Spatial Platform

MTA subway reliability, built on GTFS static + GTFS-Realtime and PostGIS.
Ingests the MTA subway GTFS static feed into Postgres/PostGIS and renders it
through the ArcGIS Maps SDK for JavaScript. Realtime ingestion and headway
analytics are the phases after this.

Every design decision below is recorded with the measurement that drove it.

**Phase 1 — GTFS static ingestion and the PostGIS foundation: complete.**
**Phase 2 — ArcGIS frontend over static data: complete apart from deployment.**
No realtime poller and no analytics yet.

## Layout

```
app/
  page.tsx           full-bleed map
  api/routes/        GeoJSON route lines
  api/stops/         GeoJSON stations
components/          map + client boundary
lib/
  geojson.ts         wire types
  arcgis/            layer construction, SDK config
db/
  postgis.ts         Drizzle custom types for geography columns
  schema/            one file per table
  client.ts          Drizzle + Neon HTTP driver
drizzle/
  0000_init.sql      hand-written: extension, tables, GiST indexes
loader/              Python GTFS static loader
scripts/
  run_sql.py         runs a .sql file via psycopg (no psql needed)
  populate_shape_stop_positions.sql
  verify.sql         sanity checks + index-usage EXPLAIN
  fix-geography-ddl.mjs   repairs drizzle-kit's quoted geography types
```

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Then apply the migration against a fresh Neon database:

```bash
python scripts/run_sql.py drizzle/0000_init.sql
```

`scripts/run_sql.py` executes a `.sql` file through psycopg and prints the
result sets, so nothing here needs the `psql` binary installed. The SQL files
are still plain psql-compatible scripts if you prefer:
`psql "$DATABASE_URL_UNPOOLED" -f drizzle/0000_init.sql`.

---

## Design decisions

### `geography` for storage, `geometry` for linear referencing

Both columns — `stops.geom` and `shapes.geom` — are `geography(…, 4326)`.

`geography` treats coordinates as points on a spheroid. `ST_Distance` and
`ST_DWithin` then take and return **meters**, computed geodesically, with no
projection step. That matters directly here: the transfer-proximity query asks
"which station pairs are within 200 m of each other," and on a `geography`
column that is literally `ST_DWithin(a.geom, b.geom, 200)`. The `geometry`
equivalent in EPSG:4326 would take *degrees*, and a degree of longitude at NYC's
latitude is about 78 km against 111 km for a degree of latitude — so a
degree-based radius is both wrong and anisotropic. The alternative is storing in
a projected CRS such as EPSG:2263 (NY State Plane, feet), which gives accurate
planar meters but bakes in a local projection and forces a transform on every
GeoJSON response. `geography` keeps storage in the same WGS84 the feed and the
frontend both speak, and pays for it with slightly slower distance math on a
dataset of ~1,500 stops, which is nothing.

The catch: **`ST_LineLocatePoint` and `ST_LineInterpolatePoint` have no
`geography` implementation.** Linear referencing along a spheroid is not a
solved-and-shipped operation in PostGIS, so both functions are geometry-only.
Every call site casts:

```sql
ST_LineLocatePoint(sh.geom::geometry, s.geom::geometry)
```

The cast is free — it is a type reinterpretation, not a reprojection — but it
means those two functions operate in **degree space**, treating lon/lat as if it
were a plane. The consequence is a small distortion: the x-axis is compressed by
roughly `cos(40.7°) ≈ 0.76` relative to the y-axis, so a fraction along a line
is weighted slightly toward north–south segments. For what these fractions are
used for — interpolating a train's position between two adjacent stops, typically
under a kilometre apart — the error is well under the positional uncertainty of
"we inferred this train's location from a status enum." It is worth knowing
about, not worth projecting around.

`db/postgis.ts` exposes `asGeometry()` so the cast is explicit and greppable
rather than scattered as inline `::geometry` string fragments.

#### The drizzle-kit trap that comes with this choice

Drizzle has no native `geography` type, so the columns are `customType`
wrappers. drizzle-kit does not recognise the type name and renders it as a
*quoted identifier* in generated migrations:

```sql
"geom" "geography(Point, 4326)" NOT NULL   -- type "geography(Point, 4326)" does not exist
```

Verified against drizzle-kit 0.31.10: every spelling of geography is quoted,
including bare `geography` with no typmod. `geometry(Point,4326)` comes out
clean — but only because drizzle-orm ships a native geometry type that
drizzle-kit knows about, which is not a reason to change the storage type.

So `npm run db:generate` runs drizzle-kit and then
`scripts/fix-geography-ddl.mjs`, which unquotes the type and leaves column and
index identifiers alone. **Never apply a raw drizzle-kit migration to this
schema.** The initial migration is hand-written anyway, since `CREATE EXTENSION`
is outside what drizzle-kit models at all.

### Serving GeoJSON: the FeatureCollection is built in Postgres

`/api/routes` and `/api/stops` return GeoJSON assembled by `json_build_object`
and `json_agg` around `ST_AsGeoJSON`, rather than selecting rows and shaping
them in JavaScript. The coordinates stay as text from the database to the
browser and are never parsed into JS objects only to be serialised again.

**Route lines are one representative shape per (route_id, direction_id).** The
MTA publishes 250 distinct shapes for 28 routes — route 5 alone has 35, covering
branches and short-turns — and drawing all of them is 3.2 MB of mostly
overlapping geometry. Taking the longest shape per direction gives 56 lines that
cover every route. Branch variants are not drawn in v1.

**Simplification is worth 91%.** `ST_Simplify` at a 0.0001 degree tolerance
takes the payload from 789 KB to 83 KB:

| Variant | Features | Payload |
|---|---|---|
| All 250 shapes | 250 | 3,264 KB |
| Longest per route+direction | 56 | 777 KB |
| Same, simplified | 56 | 71 KB |

The tolerance is in **degrees**, not meters — `ST_Simplify` is planar and the
geometry is EPSG:4326. 0.0001 deg is roughly 11 m north-south and 8 m east-west
at NYC's latitude. This is display geometry only: Phase 4 interpolates train
positions against `shapes.geom` at full precision, so a train can sit up to
~10 m off the drawn line at extreme zoom. `?tolerance=0` disables it.

**Stations are parent stations only**, with their routes gathered by walking
down to the child platforms and back up through `stop_times -> trips -> routes`.
Returning platforms would put two coincident dots on every station. The endpoint
returns 475 of the 496 loaded stations: the 21 omitted are Staten Island Railway
(S09 Tottenville .. S31 St George), which `stops.txt` ships whether or not SIR
routes are loaded. Filtering on "has at least one route" rather than on a stop_id
prefix keeps that correct if the route_type filter ever changes.

One thing to know before reading the map: **MTA models one physical complex as
several GTFS stations.** Times Sq-42 St is four of them — `127` (1/2/3), `725`
(7), `902` (shuttle) and `R16` (N/Q/R/W) — linked only by `transfers.txt`, which
this schema does not load.

Measured across the feed: **76 station names are shared by more than one parent
station**, and three pairs sit at *identical* coordinates — Queensboro Plaza
(`718`/`R09`), 145 St (`A12`/`D13`) and W 4 St-Wash Sq (`A32`/`D20`) are all
0.0 m apart. Those render as perfectly coincident dots where the one underneath
cannot be clicked at all.

So a station click shows one line-group's view of a complex, not the whole
complex. Merging them needs the transfer graph and belongs with the Phase 5
transfer analysis rather than here.

### ArcGIS: client-side FeatureLayers, keyed on route_id

The layers are built from an array of `Graphic`s with a `source`, not a `url` —
the pattern for data in your own database rather than a hosted Esri service. It
obliges you to declare `fields` and `objectIdField` by hand, because there is no
service metadata to read them from.

The route renderer is a `UniqueValueRenderer` keyed on **`route_id`, not
`route_short_name`**. Three routes share the short name "S" — FS (Franklin Av),
GS (42 St) and H (Rockaway Park) — so keying on the display name collapses three
shuttles into one symbol. Verified in the running map: 56 features, 28 symbols.
Colours come from GTFS `route_color` rather than a hardcoded table.

Three Next.js integration details that are not optional:

- The SDK evaluates `window` at module scope, so the map is loaded through
  `next/dynamic` with `ssr: false`. That option is rejected inside a Server
  Component, which is why `components/subway-map-loader.tsx` exists purely as a
  client boundary.
- The SDK stylesheet is a global CSS import and the App Router only accepts
  those from within `app/`, so it lives in `app/layout.tsx`.
- `assetsPath` is deliberately left unset. @arcgis/core 5.x defaults it to
  `https://js.arcgis.com/<installed version>/@arcgis/core/assets`. Setting it by
  hand is how you end up serving assets from a different SDK version than the
  code.

**Route lines have popups disabled.** Every station sits on top of several
polylines, so with them enabled a single click at Times Sq returned *22* stacked
results dominated by line segments, and the first one shown was a different
station from the one clicked. Line identity is already carried by colour and the
station popup lists the routes, so `popupEnabled: false` on the route layer
makes clicks land where the user aimed. The template is kept for a future layer
toggle.

In development `window.__view` is the `MapView`. It is attached immediately
after construction rather than after `await view.when()` — if the view never
becomes ready, a handle that only appears on success tells you nothing.

**Neon cold starts are visible in the UI.** The free tier scales compute to zero,
and the first `/api/routes` after an idle period took **34.5 s** against a
sub-second warm response. The Cache-Control headers hide this from repeat
visitors, but the first hit after a quiet spell is slow, and it will matter more
once the Phase 3 poller makes the database continuously active.

### Subway only: what "subway" excludes

`SUBWAY_ROUTE_TYPES = {1}` in `loader/config.py`. GTFS `route_type` 1 is subway,
and the MTA subway feed contains exactly one route of any other type: the
**Staten Island Railway** (`route_id` = `SI`, `route_type` = 2, rail).

It is deliberately excluded, at a cost of 855 trips and 17,201 stop_times. The
call is arguable in both directions — SIR ships inside the subway feed, takes
subway fare, and has its own realtime feed — so it is a scope decision rather
than a data-quality one, and it is the only thing the loader drops from the
feed. Reversing it is one line: `SUBWAY_ROUTE_TYPES = {1, 2}`, then re-run and
rebuild `shape_stop_positions`.

Anything that is not route_type 1 is skipped *and logged by name*, so a feed
change shows up in the run summary rather than passing silently:

```
routes:       1 skipped - non-subway route_type=2  e.g. SI
```

### `interval` for stop times, never `time`

GTFS does not store wall-clock times. `arrival_time` and `departure_time` are
offsets within a **service day**, which is not a calendar day: a trip that leaves
at 12:47 AM on Saturday but belongs to Friday's service is written `24:47:00`.
Values past `25:00:00` are routine on the subway's overnight service.

Postgres `time` is a clock type with a hard `24:00:00` ceiling and rejects
`24:47:00` on input. Using it would mean either dropping late-night rows or
silently wrapping them to `00:47:00` — and a wrapped time sorts *before* the
whole rest of the trip, which quietly corrupts headway math for exactly the hours
where reliability is worst and most interesting.

`interval` stores an unbounded duration, so `24:47:00` round-trips exactly and
sorts correctly within its trip. It also composes with the service date the way
you want:

```sql
service_date + st.departure_time  -- timestamptz, correct across DST and midnight
```

which is precisely the join needed to compare a scheduled departure against an
observed `stop_events` arrival in Phase 5.

### Station vs. platform: `parent_station`

MTA subway stop IDs carry a direction suffix. `127` is Times Sq–42 St on the 1/2/3;
`127N` and `127S` are its northbound and southbound platforms. The platforms are
`location_type = 0` with `parent_station = '127'`; the station is
`location_type = 1` with `parent_station` NULL.

`stop_times` references **platforms**, never stations. So any station-level
aggregate that groups by `stop_id` counts each station once per direction —
roughly double, and unevenly so at terminals and single-direction platforms.
`parent_station` is modelled as a self-referencing foreign key so that roll-up is
a join rather than string-slicing a stop ID, and so the database rejects a
platform pointing at a station that was never loaded.

The self-FK sounds like it forces a load order, and `stops.txt` does not
guarantee parents appear before children. It does not, because foreign keys are
enforced by AFTER ROW triggers that fire at the end of the *statement*: the
loader inserts every stop with one `INSERT ... SELECT` from a staging table, so
row order inside it is irrelevant. What the constraint does catch is a platform
whose parent never made it into the feed at all — so the loader nulls those
references in Python first and logs them, rather than letting the insert abort.

### Loading in one transaction, with a prune step

The loader COPYs each GTFS file into an unconstrained `TEMP` staging table, then
upserts into the real table with `INSERT ... SELECT DISTINCT ON (key) ... ON
CONFLICT DO UPDATE`. Three reasons for the staging hop:

- **Duplicate keys inside the feed.** `ON CONFLICT` cannot absorb a statement
  that touches the same row twice — Postgres raises *"cannot affect row a second
  time."* `DISTINCT ON` collapses them before the insert ever sees them.
- **Idempotence with pruning.** Upserting alone makes a re-run *safe*, but not
  *correct* against a newer feed: trips the MTA has withdrawn would linger and
  quietly skew headway analytics. With the feed's own keys sitting in staging, a
  `DELETE ... WHERE NOT EXISTS` removes exactly the withdrawn rows. Pass
  `--no-prune` to keep them.
- **Speed.** `COPY` into an unindexed table beats batched `INSERT` by a wide
  margin, which matters for the ~2M row `stop_times`.

The entire load is one transaction. A half-loaded GTFS feed is worse than no
feed, because the tables reference each other.

### Storage is the binding constraint, and it changes the refresh design

Measured on Neon's 512 MB free tier with the 2026-08-17 feed:

| | |
|---|---|
| `stop_times` heap | 245 MB |
| `stop_times` indexes | 172 MB |
| Whole database | 444 MB |

That is 2.3M rows at roughly 119 bytes each, dominated by MTA's ~31-character
`trip_id` stored in the heap *and* again in the `(trip_id, stop_sequence)`
primary key.

The consequence: **one copy of static GTFS fills 87% of the tier**, so an
atomic refresh is arithmetically impossible. Staging holds the new rows while
the transaction still holds the old ones, and nothing is released until commit
— about 900 MB at peak. The first load succeeds because the table starts empty;
the second fails with `DiskFull: project size limit (512 MB) has been exceeded`.

No change of strategy fixes this while staying atomic. `--refresh-mode replace`
gives up atomicity for `stop_times` specifically: the small tables commit first,
then `TRUNCATE` releases 417 MB, then the new rows COPY straight into the real
table. Peak stays at one copy, and the reloaded table is actually *smaller*
(444 MB vs 453 MB) because it carries no update bloat.

Dedupe has to move client-side in that mode. Upsert mode collapses duplicate
keys with `DISTINCT ON` server-side; copying into the primary key has no such
protection, so `records.dedupe_stop_times` does it in the stream — holding only
the current trip's sequences rather than all 2.3M keys, since GTFS groups rows
by trip.

**This constraint governs Phase 3, not just this loader.** `vehicle_positions`
at ~2M rows/day before dedupe, with the spec's 14-day retention window, does not
fit in what is left. The dedupe-on-write and rolling-partition mitigations in
section 4 of the spec are a precondition here, not an optimisation.

---

## Running the loader

```bash
pip install -r loader/requirements.txt
```

```bash
python loader/load_static.py
```

On a storage-capped tier (Neon free is 512 MB), a *re*-run needs replace mode —
the first load fits, the refresh does not:

```bash
python loader/load_static.py --refresh-mode replace
```

Then build the linear-referencing table:

```bash
python scripts/run_sql.py scripts/populate_shape_stop_positions.sql
```

And verify:

```bash
python scripts/run_sql.py scripts/verify.sql
```

Useful flags while iterating, so you are not re-downloading the feed on every
run: `--save-zip loader/.cache/gtfs.zip` once, then `--zip loader/.cache/gtfs.zip`
thereafter.

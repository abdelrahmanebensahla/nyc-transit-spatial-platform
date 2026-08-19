import { index, pgTable, smallint, text, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { geographyPoint } from '../postgis';

/**
 * GTFS stops.txt.
 *
 * MTA subway stop IDs carry direction suffixes: `127N` and `127S` are the
 * northbound and southbound platforms of station `127`. The platforms are
 * location_type 0 with parent_station = '127'; the station is location_type 1
 * with parent_station NULL. stop_times references the *platforms*, so any
 * station-level aggregation has to roll up through parent_station or it counts
 * every station twice.
 *
 * parent_station is a self-referencing FK, which means the loader must insert
 * parents before children — stops.txt does not guarantee that ordering.
 */
export const stops = pgTable(
  'stops',
  {
    stopId: text('stop_id').primaryKey(),
    stopName: text('stop_name').notNull(),
    parentStation: text('parent_station').references((): AnyPgColumn => stops.stopId),
    locationType: smallint('location_type'),
    geom: geographyPoint('geom', { srid: 4326 }).notNull(),
  },
  (table) => [
    index('stops_geom_idx').using('gist', table.geom),
    index('stops_parent_station_idx').on(table.parentStation),
  ],
);

export type Stop = typeof stops.$inferSelect;
export type NewStop = typeof stops.$inferInsert;

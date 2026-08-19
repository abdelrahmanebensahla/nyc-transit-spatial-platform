import { index, integer, interval, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { stops } from './stops';
import { trips } from './trips';

/**
 * GTFS stop_times.txt. The big table — roughly 2M rows for the supplemented
 * subway feed.
 *
 * arrival_time and departure_time are `interval`, NOT `time`. GTFS encodes a
 * trip's times as an offset from noon-minus-12h of the service day, so a train
 * departing 00:47 on a Saturday that belongs to Friday's service day is written
 * as `24:47:00`. Postgres `time` rejects that outright; `interval` stores it and
 * still arithmetic-adds cleanly to a service date.
 *
 * Drizzle surfaces interval as a string ('24:47:00'), which is what the loader
 * writes and what Postgres parses.
 */
export const stopTimes = pgTable(
  'stop_times',
  {
    tripId: text('trip_id')
      .notNull()
      .references(() => trips.tripId),
    stopSequence: integer('stop_sequence').notNull(),
    stopId: text('stop_id')
      .notNull()
      .references(() => stops.stopId),
    arrivalTime: interval('arrival_time'),
    departureTime: interval('departure_time'),
  },
  (table) => [
    primaryKey({ columns: [table.tripId, table.stopSequence] }),
    index('stop_times_stop_idx').on(table.stopId),
  ],
);

export type StopTime = typeof stopTimes.$inferSelect;
export type NewStopTime = typeof stopTimes.$inferInsert;

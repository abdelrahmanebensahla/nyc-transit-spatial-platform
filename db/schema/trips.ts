import { index, pgTable, smallint, text } from 'drizzle-orm/pg-core';
import { routes } from './routes';
import { shapes } from './shapes';

/**
 * GTFS trips.txt.
 *
 * shape_id is nullable: a trip whose shape is missing from shapes.txt is still
 * worth keeping for schedule analytics, it just cannot be drawn or interpolated
 * along. The loader nulls the reference and logs it rather than dropping the trip.
 */
export const trips = pgTable(
  'trips',
  {
    tripId: text('trip_id').primaryKey(),
    routeId: text('route_id')
      .notNull()
      .references(() => routes.routeId),
    serviceId: text('service_id').notNull(),
    shapeId: text('shape_id').references(() => shapes.shapeId),
    directionId: smallint('direction_id'),
    /**
     * Generated: trip_id with its leading service-id segment removed, which is
     * the form the realtime feed uses. Read-only — Postgres maintains it.
     */
    rtTripId: text('rt_trip_id'),
  },
  (table) => [
    index('trips_route_idx').on(table.routeId),
    index('trips_shape_idx').on(table.shapeId),
    index('trips_rt_trip_id_idx').on(table.rtTripId),
  ],
);

export type Trip = typeof trips.$inferSelect;
export type NewTrip = typeof trips.$inferInsert;

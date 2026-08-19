import { pgTable, text } from 'drizzle-orm/pg-core';

/** GTFS routes.txt. Subway only — the loader rejects non-subway route_types. */
export const routes = pgTable('routes', {
  routeId: text('route_id').primaryKey(),
  routeShortName: text('route_short_name').notNull(),
  routeLongName: text('route_long_name'),
  routeColor: text('route_color'),
  routeTextColor: text('route_text_color'),
});

export type Route = typeof routes.$inferSelect;
export type NewRoute = typeof routes.$inferInsert;

import { doublePrecision, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { shapes } from './shapes';
import { stops } from './stops';

/**
 * Precomputed once from static GTFS: how far along a shape each stop sits, as a
 * fraction in [0, 1].
 *
 * This is the table that makes live position interpolation cheap. The subway
 * RT feed gives no coordinates, so a train's position is derived by picking the
 * fractions of its previous and next stops and interpolating between them.
 * Computing that per-render would mean a ST_LineLocatePoint over a full route
 * line for every train on every poll; here it is a primary key lookup.
 */
export const shapeStopPositions = pgTable(
  'shape_stop_positions',
  {
    shapeId: text('shape_id')
      .notNull()
      .references(() => shapes.shapeId),
    stopId: text('stop_id')
      .notNull()
      .references(() => stops.stopId),
    fraction: doublePrecision('fraction').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shapeId, table.stopId] }),
    index('shape_stop_positions_stop_idx').on(table.stopId),
  ],
);

export type ShapeStopPosition = typeof shapeStopPositions.$inferSelect;
export type NewShapeStopPosition = typeof shapeStopPositions.$inferInsert;

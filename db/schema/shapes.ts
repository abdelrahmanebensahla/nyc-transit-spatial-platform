import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { geographyLineString } from '../postgis';

/**
 * One LineString per shape_id, assembled by the loader from the shapes.txt
 * points ordered by shape_pt_sequence.
 *
 * It has to be a single LineString, not a MultiLineString: ST_LineLocatePoint
 * and ST_LineInterpolatePoint both reject multi-part geometries, and those two
 * functions are the entire reason this table exists.
 */
export const shapes = pgTable(
  'shapes',
  {
    shapeId: text('shape_id').primaryKey(),
    geom: geographyLineString('geom', { srid: 4326 }).notNull(),
  },
  (table) => [index('shapes_geom_idx').using('gist', table.geom)],
);

export type Shape = typeof shapes.$inferSelect;
export type NewShape = typeof shapes.$inferInsert;

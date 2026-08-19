import { sql, type SQL } from 'drizzle-orm';
import { customType, type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * PostGIS geography columns for Drizzle.
 *
 * Drizzle has no native geography type, so these are `customType` wrappers that
 * emit the correct DDL and handle the driver round-trip. The authoritative DDL
 * lives in drizzle/0000_init.sql — these definitions exist so the TypeScript
 * schema matches the database and so inserts/selects are typed.
 *
 * KNOWN drizzle-kit LIMITATION: generated migrations render these columns as a
 * quoted identifier — `"geom" "geography(Point, 4326)"` — which Postgres rejects
 * with `type "geography(Point, 4326)" does not exist`. It affects every spelling
 * of geography, with or without the typmod; `geometry(...)` is exempt only
 * because drizzle-orm ships a native geometry type that drizzle-kit recognises.
 * `npm run db:generate` therefore pipes output through
 * scripts/fix-geography-ddl.mjs. Do not apply a raw drizzle-kit migration.
 *
 * Wire format:
 *   write — a GeoJSON geometry object, wrapped in ST_GeomFromGeoJSON(...)::geography
 *   read  — GeoJSON text, which means you MUST select through asGeoJSON() below.
 *           A bare `select({ geom: stops.geom })` gets hex EWKB back from
 *           Postgres, which is not something this type pretends to decode.
 */

export type Position = [lon: number, lat: number];

export interface GeoJSONPoint {
  type: 'Point';
  coordinates: Position;
}

export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: Position[];
}

type Geometry = GeoJSONPoint | GeoJSONLineString;

function geographyType<T extends Geometry>(kind: 'Point' | 'LineString') {
  return customType<{
    data: T;
    driverData: string;
    config: { srid?: number };
  }>({
    dataType(config) {
      return `geography(${kind}, ${config?.srid ?? 4326})`;
    },

    toDriver(value: T): SQL {
      // GeoJSON is defined as WGS84, and ST_GeomFromGeoJSON stamps SRID 4326.
      return sql`ST_GeomFromGeoJSON(${JSON.stringify(value)})::geography`;
    },

    fromDriver(value: string): T {
      if (typeof value !== 'string' || !value.startsWith('{')) {
        throw new Error(
          'Geography column was selected raw and came back as EWKB. ' +
            'Select it through asGeoJSON(column) instead.',
        );
      }
      return JSON.parse(value) as T;
    },
  });
}

export const geographyPoint = geographyType<GeoJSONPoint>('Point');
export const geographyLineString = geographyType<GeoJSONLineString>('LineString');

/** Select helper: `db.select({ geom: asGeoJSON(stops.geom) })`. */
export function asGeoJSON(column: AnyPgColumn): SQL<string> {
  return sql<string>`ST_AsGeoJSON(${column})`;
}

/**
 * Cast a geography column to geometry.
 *
 * ST_LineLocatePoint and ST_LineInterpolatePoint are geometry-only — there is
 * no geography overload — so every call site has to cast. See the README for
 * why the columns are geography in the first place.
 */
export function asGeometry(column: AnyPgColumn): SQL {
  return sql`${column}::geometry`;
}

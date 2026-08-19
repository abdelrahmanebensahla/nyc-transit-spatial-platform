/**
 * GeoJSON shapes returned by the API routes.
 *
 * The FeatureCollection is assembled by Postgres rather than in JS — see
 * db/queries. These types describe what comes back over the wire so the
 * ArcGIS layer construction is typed against something real.
 */

export interface Feature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}

export interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}

export interface LineStringGeometry {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface PointGeometry {
  type: 'Point';
  coordinates: [number, number];
}

/** One representative line per route and direction. */
export interface RouteLineProperties {
  shape_id: string;
  route_id: string;
  route_short_name: string;
  route_long_name: string | null;
  /** Hex with the leading '#' added — GTFS stores it without. */
  route_color: string;
  route_text_color: string;
  direction_id: number | null;
}

/** Parent stations only (location_type = 1), never the directional platforms. */
export interface StationProperties {
  stop_id: string;
  stop_name: string;
  /** Distinct routes serving this station, via its child platforms. */
  routes: string[];
}

export type RouteLineCollection = FeatureCollection<LineStringGeometry, RouteLineProperties>;
export type StationCollection = FeatureCollection<PointGeometry, StationProperties>;

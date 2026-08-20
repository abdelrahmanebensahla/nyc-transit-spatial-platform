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

/** A train, positioned by linear referencing rather than supplied coordinates. */
export interface VehicleProperties {
  trip_id: string;
  route_id: string;
  route_color: string;
  stop_id: string | null;
  stop_name: string | null;
  current_status: string | null;
  observed_at: string;
  /** Which branch placed this train: shape_stop | interpolated | station_fallback. */
  position_source: 'shape_stop' | 'interpolated' | 'station_fallback';
}

export type VehicleCollection = FeatureCollection<PointGeometry, VehicleProperties>;

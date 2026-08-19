import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import Graphic from '@arcgis/core/Graphic';
import Polyline from '@arcgis/core/geometry/Polyline';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import UniqueValueRenderer from '@arcgis/core/renderers/UniqueValueRenderer';
import type { RouteLineCollection } from '@/lib/geojson';

/**
 * Client-side FeatureLayer built from an array of Graphics.
 *
 * This is the pattern for data that lives in your own database rather than a
 * hosted Esri service: the layer has no `url`, it has a `source`. That obliges
 * you to declare `fields` and `objectIdField` yourself, because there is no
 * service metadata for the SDK to read them from.
 *
 * The renderer is a UniqueValueRenderer keyed on **route_id, not
 * route_short_name**. Three routes share the short name "S" — FS (Franklin Av),
 * GS (42 St) and H (Rockaway Park) — so keying on the display name would
 * collapse three shuttles into one symbol.
 *
 * Colours come from GTFS itself rather than a hardcoded table, so the map stays
 * correct if the MTA restyles a line.
 */
export function buildRouteLayer(collection: RouteLineCollection): FeatureLayer {
  const graphics = collection.features.map(
    (feature, index) =>
      new Graphic({
        geometry: new Polyline({
          paths: [feature.geometry.coordinates],
          spatialReference: { wkid: 4326 },
        }),
        attributes: {
          ObjectID: index + 1,
          shape_id: feature.properties.shape_id,
          route_id: feature.properties.route_id,
          route_short_name: feature.properties.route_short_name,
          route_long_name: feature.properties.route_long_name ?? '',
          route_color: feature.properties.route_color,
          direction_id: feature.properties.direction_id,
        },
      }),
  );

  // One symbol per route, taking each route's colour from its first feature.
  const colorByRoute = new Map<string, string>();
  for (const feature of collection.features) {
    if (!colorByRoute.has(feature.properties.route_id)) {
      colorByRoute.set(feature.properties.route_id, feature.properties.route_color);
    }
  }

  const renderer = new UniqueValueRenderer({
    field: 'route_id',
    uniqueValueInfos: [...colorByRoute].map(([routeId, color]) => ({
      value: routeId,
      symbol: new SimpleLineSymbol({ color, width: 2.5, cap: 'round', join: 'round' }),
    })),
    defaultSymbol: new SimpleLineSymbol({ color: '#6B7280', width: 1.5 }),
  });

  return new FeatureLayer({
    id: 'subway-routes',
    title: 'Subway routes',
    source: graphics,
    objectIdField: 'ObjectID',
    geometryType: 'polyline',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'ObjectID', type: 'oid' },
      { name: 'shape_id', type: 'string' },
      { name: 'route_id', type: 'string' },
      { name: 'route_short_name', type: 'string' },
      { name: 'route_long_name', type: 'string' },
      { name: 'route_color', type: 'string' },
      { name: 'direction_id', type: 'integer' },
    ],
    renderer,
    // Popups are off for route lines on purpose. Every station sits on top of
    // several polylines, so leaving them enabled makes a single click at Times
    // Sq return 22 stacked results dominated by line segments, and the station
    // the user aimed at is not the one shown first. Line identity is already
    // carried by colour, and the station popup lists the routes serving it.
    // The template is kept so it can be re-enabled behind a layer toggle.
    popupEnabled: false,
    popupTemplate: {
      title: '{route_short_name} — {route_long_name}',
      content: 'Shape {shape_id}, direction {direction_id}',
    },
  });
}

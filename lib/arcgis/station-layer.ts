import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import SimpleRenderer from '@arcgis/core/renderers/SimpleRenderer';
import type { StationCollection } from '@/lib/geojson';

/**
 * Client-side FeatureLayer of parent stations.
 *
 * FeatureLayer attributes must be primitives, so the `routes` array from the
 * API is flattened to a comma-joined string plus a count. The count is kept
 * separately because it is the useful numeric field later — sizing stations by
 * how many lines serve them, and the obvious input to the Phase 5 choropleth.
 */
export function buildStationLayer(collection: StationCollection): FeatureLayer {
  const graphics = collection.features.map(
    (feature, index) =>
      new Graphic({
        geometry: new Point({
          longitude: feature.geometry.coordinates[0],
          latitude: feature.geometry.coordinates[1],
          spatialReference: { wkid: 4326 },
        }),
        attributes: {
          ObjectID: index + 1,
          stop_id: feature.properties.stop_id,
          stop_name: feature.properties.stop_name,
          routes: feature.properties.routes.join(', '),
          route_count: feature.properties.routes.length,
        },
      }),
  );

  return new FeatureLayer({
    id: 'subway-stations',
    title: 'Stations',
    source: graphics,
    objectIdField: 'ObjectID',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'ObjectID', type: 'oid' },
      { name: 'stop_id', type: 'string' },
      { name: 'stop_name', type: 'string' },
      { name: 'routes', type: 'string' },
      { name: 'route_count', type: 'integer' },
    ],
    renderer: new SimpleRenderer({
      symbol: new SimpleMarkerSymbol({
        style: 'circle',
        size: 5,
        color: '#FFFFFF',
        outline: { color: '#111827', width: 1 },
      }),
    }),
    popupTemplate: {
      title: '{stop_name}',
      content: [
        {
          type: 'fields',
          fieldInfos: [
            { fieldName: 'stop_id', label: 'GTFS stop' },
            { fieldName: 'routes', label: 'Routes' },
            { fieldName: 'route_count', label: 'Lines serving' },
          ],
        },
      ],
    },
    minScale: 0,
    maxScale: 0,
  });
}

import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import type { VehicleCollection, VehicleProperties } from '@/lib/geojson';

/**
 * Live trains on a GraphicsLayer, updated in place.
 *
 * A GraphicsLayer rather than a FeatureLayer because this changes every poll:
 * FeatureLayer wants applyEdits and a stable objectId, GraphicsLayer lets a
 * graphic's geometry be reassigned directly.
 *
 * The naive version — `layer.removeAll()` then re-add — discards and rebuilds
 * ~670 graphics every 30 seconds, which makes the map blink and throws away
 * the popup the user currently has open. This keeps one Graphic per trip and
 * moves it, so only genuinely new trains are constructed and only genuinely
 * departed ones removed.
 */

const STOPPED = 'STOPPED_AT';

function symbolFor(properties: VehicleProperties): SimpleMarkerSymbol {
  return new SimpleMarkerSymbol({
    style: 'circle',
    // Stopped trains sit exactly on a station dot, so they are drawn slightly
    // larger with a bright outline to stay visible on top of it.
    size: properties.current_status === STOPPED ? 9 : 7,
    color: properties.route_color,
    outline: { color: properties.current_status === STOPPED ? '#FFFFFF' : '#111827', width: 1.5 },
  });
}

export function createVehicleLayer(): GraphicsLayer {
  return new GraphicsLayer({ id: 'live-vehicles', title: 'Live trains' });
}

export interface VehicleUpdate {
  added: number;
  moved: number;
  removed: number;
}

/**
 * Reconcile the layer against a fresh poll.
 *
 * `tracked` is owned by the caller so it survives across polls — that map is
 * the whole reason this is an update rather than a rebuild.
 */
export function updateVehicleLayer(
  layer: GraphicsLayer,
  tracked: Map<string, Graphic>,
  collection: VehicleCollection,
): VehicleUpdate {
  const seen = new Set<string>();
  const update: VehicleUpdate = { added: 0, moved: 0, removed: 0 };
  const toAdd: Graphic[] = [];

  for (const feature of collection.features) {
    const id = feature.properties.trip_id;
    seen.add(id);

    const point = new Point({
      longitude: feature.geometry.coordinates[0],
      latitude: feature.geometry.coordinates[1],
      spatialReference: { wkid: 4326 },
    });

    const existing = tracked.get(id);
    if (existing) {
      existing.geometry = point;
      existing.attributes = feature.properties;
      existing.symbol = symbolFor(feature.properties);
      update.moved += 1;
      continue;
    }

    const graphic = new Graphic({
      geometry: point,
      attributes: feature.properties,
      symbol: symbolFor(feature.properties),
      popupTemplate: {
        title: '{route_id} train',
        content: [
          {
            type: 'fields',
            fieldInfos: [
              { fieldName: 'current_status', label: 'Status' },
              { fieldName: 'stop_name', label: 'At / next stop' },
              { fieldName: 'observed_at', label: 'Last reported' },
              { fieldName: 'position_source', label: 'Position derived from' },
              { fieldName: 'trip_id', label: 'RT trip' },
            ],
          },
        ],
      },
    });
    tracked.set(id, graphic);
    toAdd.push(graphic);
    update.added += 1;
  }

  // addMany once rather than add() per graphic: each add triggers its own
  // redraw notification.
  if (toAdd.length) layer.addMany(toAdd);

  const stale: Graphic[] = [];
  for (const [id, graphic] of tracked) {
    if (!seen.has(id)) {
      stale.push(graphic);
      tracked.delete(id);
    }
  }
  if (stale.length) {
    layer.removeMany(stale);
    update.removed = stale.length;
  }

  return update;
}

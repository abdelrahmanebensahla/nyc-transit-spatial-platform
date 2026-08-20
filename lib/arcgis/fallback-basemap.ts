import Basemap from '@arcgis/core/Basemap';
import WebTileLayer from '@arcgis/core/layers/WebTileLayer';

/**
 * Keyless grayscale basemap, used only when the ArcGIS basemap is rejected.
 *
 * ArcGIS remains the primary basemap — it is the thing this project exists to
 * demonstrate. But a dead API key otherwise leaves subway lines floating on
 * blank white, which is worse than any fallback. These are CARTO's raster
 * tiles, free for reasonable use with attribution, and they need no key.
 *
 * Delete this file and the catch block in subway-map.tsx to make an ArcGIS key
 * failure hard again.
 */
export function createFallbackBasemap(): Basemap {
  return new Basemap({
    id: 'carto-dark-fallback',
    title: 'CARTO Dark Matter (keyless fallback)',
    baseLayers: [
      new WebTileLayer({
        urlTemplate: 'https://{subDomain}.basemaps.cartocdn.com/dark_all/{level}/{col}/{row}.png',
        subDomains: ['a', 'b', 'c', 'd'],
        copyright: '&copy; OpenStreetMap contributors, &copy; CARTO',
        title: 'CARTO Dark Matter',
      }),
    ],
  });
}

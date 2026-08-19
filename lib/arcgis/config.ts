import esriConfig from '@arcgis/core/config';

/**
 * ArcGIS runtime configuration.
 *
 * assetsPath is deliberately NOT set: @arcgis/core 5.x defaults it to
 * https://js.arcgis.com/<version>/@arcgis/core/assets, pinned to the installed
 * version. Setting it by hand is how you end up serving assets from a different
 * SDK version than the code, which fails in ways that look like styling bugs.
 */

export const ARCGIS_API_KEY = process.env.NEXT_PUBLIC_ARCGIS_API_KEY ?? '';

export function configureArcGIS(): void {
  if (ARCGIS_API_KEY) {
    esriConfig.apiKey = ARCGIS_API_KEY;
  }
}

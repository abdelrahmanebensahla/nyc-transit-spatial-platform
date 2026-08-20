'use client';

import { useEffect, useRef, useState } from 'react';
import ArcGISMap from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import { ARCGIS_API_KEY, configureArcGIS } from '@/lib/arcgis/config';
import { buildRouteLayer } from '@/lib/arcgis/route-layer';
import { buildStationLayer } from '@/lib/arcgis/station-layer';
import { createFallbackBasemap } from '@/lib/arcgis/fallback-basemap';
import { createVehicleLayer, updateVehicleLayer } from '@/lib/arcgis/vehicle-layer';
import type Graphic from '@arcgis/core/Graphic';
import type { RouteLineCollection, StationCollection, VehicleCollection } from '@/lib/geojson';

/** Roughly the five boroughs. */
const NYC_CENTER: [number, number] = [-73.94, 40.72];
const INITIAL_ZOOM = 11;

/**
 * Client poll interval. The poller writes every 30s, so polling faster only
 * re-fetches identical rows. v1 polls from the client rather than pushing over
 * a WebSocket, which is the spec's explicit call.
 */
const VEHICLE_POLL_MS = 20_000;

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export default function SubwayMap() {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [basemapError, setBasemapError] = useState<string | null>(null);
  const [vehicleCount, setVehicleCount] = useState<number | null>(null);

  useEffect(() => {
    if (!container.current) return;

    // The SDK reaches for `window` at module scope in places, so everything
    // here runs after mount and this component is only ever loaded with
    // ssr: false. Rendering it on the server throws.
    configureArcGIS();

    let view: MapView | undefined;
    let cancelled = false;
    let pollTimer: number | undefined;

    async function render(node: HTMLDivElement) {
      try {
        const [routesResponse, stopsResponse] = await Promise.all([
          fetch('/api/routes'),
          fetch('/api/stops'),
        ]);
        if (!routesResponse.ok || !stopsResponse.ok) {
          throw new Error(`API returned ${routesResponse.status} / ${stopsResponse.status}`);
        }

        const routes = (await routesResponse.json()) as RouteLineCollection;
        const stations = (await stopsResponse.json()) as StationCollection;
        if (cancelled) return;

        const vehicleLayer = createVehicleLayer();

        const map = new ArcGISMap({
          // No key means the ArcGIS basemap cannot load at all, so go straight
          // to the fallback rather than constructing one that will fail.
          basemap: ARCGIS_API_KEY ? 'arcgis/dark-gray' : createFallbackBasemap(),
          // Draw order: routes, then stations, then live trains on top.
          layers: [buildRouteLayer(routes), buildStationLayer(stations), vehicleLayer],
        });

        view = new MapView({
          container: node,
          map,
          center: NYC_CENTER,
          zoom: INITIAL_ZOOM,
          constraints: { minZoom: 9, maxZoom: 18 },
          popup: { dockEnabled: false, dockOptions: { buttonEnabled: false } },
        });

        // Attached before awaiting: if the view never becomes ready, the handle
        // is the only way to find out why. Development only.
        if (process.env.NODE_ENV !== 'production') {
          (window as unknown as { __view?: MapView }).__view = view;
        }

        // A rejected API key fails ONLY the basemap. The operational layers are
        // client-side, so they draw regardless and view.when() still resolves —
        // the map just renders subway lines on blank white with nothing in the
        // console to explain it. Surface it instead of failing silently.
        map.basemap?.load().catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          const rejectedKey = /invalid|token|498|401/i.test(message);

          // Swap in the keyless basemap rather than leaving the operational
          // layers on blank white.
          map.basemap = createFallbackBasemap();

          setBasemapError(
            rejectedKey
              ? 'ArcGIS rejected the API key (498). Showing a keyless fallback basemap; subway layers are unaffected.'
              : `ArcGIS basemap failed (${message}). Showing a keyless fallback basemap.`,
          );
        });

        // Vehicle polling starts BEFORE awaiting the view. A GraphicsLayer
        // accepts graphics whether or not the view has finished initialising,
        // and gating on view.when() means anything that stalls the render loop
        // -- a backgrounded tab, a slow tile basemap, no WebGL -- silently
        // costs you the live layer as well as the map.
        //
        // `tracked` persists across polls so graphics are moved rather than
        // rebuilt; see lib/arcgis/vehicle-layer.ts.
        const tracked = new Map<string, Graphic>();

        async function pollVehicles() {
          if (cancelled) return;
          try {
            const response = await fetch('/api/vehicles', { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const collection = (await response.json()) as VehicleCollection;
            if (cancelled) return;
            updateVehicleLayer(vehicleLayer, tracked, collection);
            setVehicleCount(collection.features.length);
          } catch (error) {
            // A failed poll is not fatal: the previous positions stay on screen
            // and the next tick tries again.
            console.warn('vehicle poll failed', error);
          }
        }

        void pollVehicles();
        pollTimer = window.setInterval(() => void pollVehicles(), VEHICLE_POLL_MS);

        await view.when();
        if (!cancelled) setStatus({ kind: 'ready' });
      } catch (error) {
        if (!cancelled) {
          setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    void render(container.current);

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      view?.destroy();
    };
  }, []);

  return (
    <div style={{ position: 'relative', inset: 0, width: '100%', height: '100%' }}>
      <div ref={container} style={{ width: '100%', height: '100%' }} />
      {!ARCGIS_API_KEY && (
        <Notice tone="warn">
          NEXT_PUBLIC_ARCGIS_API_KEY is not set — showing a keyless fallback basemap.
        </Notice>
      )}
      {status.kind === 'loading' && <Notice>Loading subway geometry…</Notice>}
      {status.kind === 'error' && <Notice tone="error">Map failed: {status.message}</Notice>}
      {status.kind === 'ready' && basemapError && <Notice tone="warn">{basemapError}</Notice>}
      {vehicleCount !== null && (
        <div
          style={{
            position: 'absolute', right: 12, top: 12, zIndex: 10,
            padding: '6px 10px', borderRadius: 6, background: '#1F2937',
            color: '#F9FAFB', font: '13px/1.4 system-ui, sans-serif',
          }}
        >
          {vehicleCount} trains live
        </div>
      )}
    </div>
  );
}

function Notice({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warn' | 'error' }) {
  const background = tone === 'error' ? '#7F1D1D' : tone === 'warn' ? '#78350F' : '#1F2937';
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        zIndex: 10,
        maxWidth: 460,
        padding: '8px 12px',
        borderRadius: 6,
        background,
        color: '#F9FAFB',
        font: '13px/1.4 system-ui, sans-serif',
      }}
    >
      {children}
    </div>
  );
}

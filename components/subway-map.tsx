'use client';

import { useEffect, useRef, useState } from 'react';
import ArcGISMap from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import { ARCGIS_API_KEY, configureArcGIS } from '@/lib/arcgis/config';
import { buildRouteLayer } from '@/lib/arcgis/route-layer';
import { buildStationLayer } from '@/lib/arcgis/station-layer';
import type { RouteLineCollection, StationCollection } from '@/lib/geojson';

/** Roughly the five boroughs. */
const NYC_CENTER: [number, number] = [-73.94, 40.72];
const INITIAL_ZOOM = 11;

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export default function SubwayMap() {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    if (!container.current) return;

    // The SDK reaches for `window` at module scope in places, so everything
    // here runs after mount and this component is only ever loaded with
    // ssr: false. Rendering it on the server throws.
    configureArcGIS();

    let view: MapView | undefined;
    let cancelled = false;

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

        const map = new ArcGISMap({
          basemap: ARCGIS_API_KEY ? 'arcgis/dark-gray' : undefined,
          // Routes first so stations draw on top of the lines.
          layers: [buildRouteLayer(routes), buildStationLayer(stations)],
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
      view?.destroy();
    };
  }, []);

  return (
    <div style={{ position: 'relative', inset: 0, width: '100%', height: '100%' }}>
      <div ref={container} style={{ width: '100%', height: '100%' }} />
      {!ARCGIS_API_KEY && <Notice tone="warn">
        NEXT_PUBLIC_ARCGIS_API_KEY is not set — route and station layers still render,
        but there is no basemap underneath them.
      </Notice>}
      {status.kind === 'loading' && <Notice>Loading subway geometry…</Notice>}
      {status.kind === 'error' && <Notice tone="error">Map failed: {status.message}</Notice>}
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

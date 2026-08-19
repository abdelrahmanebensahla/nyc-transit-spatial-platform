'use client';

import dynamic from 'next/dynamic';

/**
 * Client boundary for the map.
 *
 * `ssr: false` is rejected by next/dynamic inside a Server Component, and the
 * ArcGIS SDK cannot be server-rendered — it evaluates `window` at module scope.
 * So the dynamic import has to happen inside a component that is already
 * client-side, which is all this file is for.
 */
const SubwayMap = dynamic(() => import('./subway-map'), {
  ssr: false,
  loading: () => (
    <div style={{ width: '100%', height: '100%', background: '#111827' }} />
  ),
});

export default function SubwayMapLoader() {
  return <SubwayMap />;
}

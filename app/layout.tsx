import type { Metadata, Viewport } from 'next';

// The SDK stylesheet is a global import, which the App Router only allows from
// within app/. Importing it inside the map component fails the build.
import '@arcgis/core/assets/esri/themes/dark/main.css';

export const metadata: Metadata = {
  title: 'NYC Transit Spatial Platform',
  description: 'MTA subway reliability, built on GTFS static + realtime and PostGIS.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}

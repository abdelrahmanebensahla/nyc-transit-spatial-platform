import SubwayMapLoader from '@/components/subway-map-loader';

export default function Home() {
  return (
    <main style={{ position: 'fixed', inset: 0 }}>
      <SubwayMapLoader />
    </main>
  );
}

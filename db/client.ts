import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
}

// neon-http: one HTTP round trip per query, no interactive transactions.
// Phase 1 has no app-side writes — all writes come from the Python loader —
// so the HTTP driver is the right trade. Swap to drizzle-orm/neon-serverless
// if a later phase needs transactions from Next.js.
export const db = drizzle(neon(connectionString), { schema });

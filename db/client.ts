import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';

/**
 * Lazily constructed Drizzle client.
 *
 * Deliberately NOT built at module scope. `next build` imports every route
 * module during its "Collecting page data" phase, so a module-scope throw on a
 * missing DATABASE_URL fails the build on any machine without a database —
 * including CI and Vercel, which have no reason to hold a connection string at
 * build time. Reading the environment inside the getter defers the requirement
 * to the first actual query.
 *
 * neon-http: one HTTP round trip per query, no interactive transactions. All
 * writes come from the Python loader, so the HTTP driver is the right trade.
 * Swap to drizzle-orm/neon-serverless if a later phase needs transactions.
 */
let client: NeonHttpDatabase<typeof schema> | undefined;

export function getDb(): NeonHttpDatabase<typeof schema> {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
    }
    client = drizzle(neon(connectionString), { schema });
  }
  return client;
}

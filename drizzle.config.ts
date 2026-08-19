import { defineConfig } from 'drizzle-kit';

// Avoids a dotenv dependency (Node >= 20.12).
try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional if the vars are already exported.
}

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set.');
}

export default defineConfig({
  schema: './db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  // The initial migration is hand-written: drizzle-kit does not know about
  // CREATE EXTENSION postgis or USING GIST on a custom column type. Generated
  // migrations from here on should be reviewed for the same reason.
  verbose: true,
  strict: true,
});

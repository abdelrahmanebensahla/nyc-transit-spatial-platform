/**
 * Post-process drizzle-kit output to repair quoted geography types.
 *
 * drizzle-kit renders an unrecognised custom type as a quoted identifier:
 *
 *     "geom" "geography(Point, 4326)" NOT NULL
 *
 * which Postgres rejects with: type "geography(Point, 4326)" does not exist.
 * It leaves `geometry(...)` alone because drizzle-orm ships a native geometry
 * type it knows about; `geography` has no native equivalent, so every spelling
 * of it — with or without the typmod — comes back quoted.
 *
 * Run automatically by `npm run db:generate`.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'drizzle';
const QUOTED_GEOGRAPHY = /"(geography(?:\([^"]*\))?)"/g;

let patched = 0;

for (const file of readdirSync(MIGRATIONS_DIR)) {
  if (!file.endsWith('.sql')) continue;

  const path = join(MIGRATIONS_DIR, file);
  const original = readFileSync(path, 'utf8');
  const fixed = original.replace(QUOTED_GEOGRAPHY, '$1');

  if (fixed !== original) {
    writeFileSync(path, fixed);
    console.log(`unquoted geography type(s) in ${path}`);
    patched += 1;
  }
}

console.log(
  patched === 0
    ? 'no geography types needed unquoting'
    : `patched ${patched} migration file(s)`,
);

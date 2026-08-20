/**
 * Validate an ArcGIS API key without deploying anything.
 *
 *   node scripts/check-arcgis-key.mjs             # reads .env
 *   node scripts/check-arcgis-key.mjs AAPT...     # tests the key you paste
 *
 * Exists because a bad key is invisible from the app: the client-side layers
 * still render and only the basemap silently disappears. This probes the same
 * endpoints the SDK uses and names the actual cause.
 */

import { readFileSync } from 'node:fs';

const STYLE = 'https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/arcgis/dark-gray';
const SELF = 'https://www.arcgis.com/sharing/rest/portals/self?f=json';

function keyFromEnv() {
  try {
    const line = readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('NEXT_PUBLIC_ARCGIS_API_KEY='));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

async function probe(url, referer) {
  const response = await fetch(url, referer ? { headers: { Referer: referer } } : undefined);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  // ArcGIS frequently returns HTTP 200 with an error object in the body.
  return { http: response.status, error: body?.error ?? null, ok: !body?.error && response.ok };
}

const key = (process.argv[2] ?? keyFromEnv()).trim();

if (!key) {
  console.error('No key given and none found in .env');
  process.exit(2);
}

console.log(`key: ${key.slice(0, 20)}…${key.slice(-12)}  (${key.length} chars)\n`);

const style = await probe(`${STYLE}?token=${key}`);
const self = await probe(`${SELF}&token=${key}`);
const withReferer = await probe(`${STYLE}?token=${key}`, 'http://localhost:3000/');

console.log(`  basemap styles        ${style.ok ? 'OK' : `FAIL ${style.error?.code} ${style.error?.message}`}`);
console.log(`  token introspection   ${self.ok ? 'OK' : `FAIL ${self.error?.code} ${self.error?.message}`}`);
console.log(`  basemap w/ referer    ${withReferer.ok ? 'OK' : `FAIL ${withReferer.error?.code}`}`);

console.log('');
if (style.ok) {
  console.log('This key works. If the map is still blank, the deployed bundle is');
  console.log('serving a different key — set it in Vercel and REDEPLOY, since');
  console.log('NEXT_PUBLIC_ vars are inlined at build time.');
  process.exit(0);
}

const code = style.error?.code;
if (code === 498 && !self.ok) {
  console.log('Rejected everywhere, including plain token introspection --');
  console.log('which needs no special privilege. The token is not being');
  console.log('recognised at all, so this is NOT a basemap scoping issue.');
  console.log('');
  console.log('Check, in this order, at developers.arcgis.com > API keys:');
  console.log('  1. expiration date -- is it in the future?');
  console.log('  2. privileges -- Location services > Basemaps assigned AND saved');
  console.log('  3. the key value -- copy it fresh; editing a credential can');
  console.log('     invalidate the previously issued key');
  console.log('  4. the account itself -- an unverified or suspended ArcGIS');
  console.log('     Location Platform account issues keys that never validate');
} else if (code === 403) {
  console.log('403 means the key is valid but not authorised for this service.');
  console.log('Add the Basemaps privilege, or clear the referrer restriction.');
} else {
  console.log(`Unexpected: HTTP ${style.http}, code ${code ?? 'none'}.`);
}
process.exit(1);

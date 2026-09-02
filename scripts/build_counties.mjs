/* Rebuilds data/wa_counties.geojson — the bundled county-boundary fallback —
 * from the us-atlas package (TopoJSON derived from the U.S. Census Bureau
 * cartographic boundary files).
 *
 *   npm install topojson-client us-atlas
 *   node scripts/build_counties.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import * as topojson from 'topojson-client';

const topo = JSON.parse(readFileSync('./node_modules/us-atlas/counties-10m.json', 'utf8'));
const fc = topojson.feature(topo, topo.objects.counties);
const wa = fc.features.filter(f => String(f.id).startsWith('53'));
// 4 decimals (~11 m) is plenty for a low-zoom fallback layer.
const round = c => Array.isArray(c[0]) ? c.map(round) : [+c[0].toFixed(4), +c[1].toFixed(4)];
const out = {
  type: 'FeatureCollection',
  name: 'wa_counties_cb_500k_via_us-atlas',
  features: wa.map(f => ({
    type: 'Feature',
    properties: { GEOID: String(f.id), NAME: f.properties.name },
    geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) }
  }))
};
// Break after each coordinate pair so the file has short, diff-friendly lines.
const json = JSON.stringify(out).replace(/\],/g, '],\n');
writeFileSync(new URL('../data/wa_counties.geojson', import.meta.url), json);
console.log('counties:', wa.length);

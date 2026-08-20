/* Integration smoke test: serves the repo locally, mocks every external API
 * with fixtures, and drives the app in headless Chromium. */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8137';
const failures = [];
const pass = m => console.log('  ✓ ' + m);
const fail = m => { failures.push(m); console.log('  ✗ ' + m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

// ---------------------------------------------------------------- fixtures
function sq(lon, lat, d) { // square polygon ring
  return [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
}
// 8 fixture "counties" in a row across WA, 8 tracts around Seattle
const COUNTIES = Array.from({ length: 8 }, (_, i) => ({
  geoid: '530' + String(i * 2 + 1).padStart(2, '0'),
  lon: -123 + i * 0.8, lat: 47.3, name: 'County ' + i
}));
const TRACTS = Array.from({ length: 8 }, (_, i) => ({
  geoid: '53033' + String(100 + i) + '00',
  lon: -122.5 + (i % 4) * 0.1, lat: 47.55 + Math.floor(i / 4) * 0.1, name: 'Tract ' + i
}));

function acsDetailed(rows, level) {
  const header = ['NAME', 'B01003_001E', 'B01002_001E', 'B19013_001E', 'B19301_001E', 'B25077_001E', 'B25064_001E',
    'B15003_001E', 'B15003_022E', 'B15003_023E', 'B15003_024E', 'B15003_025E', 'B17001_001E', 'B17001_002E',
    'B23025_003E', 'B23025_005E', 'B25003_001E', 'B25003_002E', 'B11001_001E', 'state', 'county'];
  if (level === 'tract') header.push('tract');
  const out = [header];
  rows.forEach((r, i) => {
    const row = [r.name, String(10000 + i * 5000), '38.2', String(60000 + i * 8000), '39000', String(400000 + i * 50000), '1600',
      '8000', '2000', '800', '150', '90', '9500', String(700 + i * 40), '5800', '300', '4200', '2600', '4100',
      r.geoid.slice(0, 2), r.geoid.slice(2, 5)];
    if (level === 'tract') row.push(r.geoid.slice(5));
    out.push(row);
  });
  return out;
}
function acsSubject(rows, level) {
  const header = ['S2701_C01_001E', 'S2701_C03_001E', 'S2701_C05_001E', 'state', 'county'];
  if (level === 'tract') header.push('tract');
  const out = [header];
  rows.forEach((r, i) => {
    const row = [String(9800), String(94 - i), String(6 + i), r.geoid.slice(0, 2), r.geoid.slice(2, 5)];
    if (level === 'tract') row.push(r.geoid.slice(5));
    out.push(row);
  });
  return out;
}
function boundaryFC(rows, d) {
  return {
    type: 'FeatureCollection',
    features: rows.map((r, i) => ({
      type: 'Feature',
      properties: { GEOID: r.geoid, NAME: r.name, AREALAND: 2.6e8 + i * 5e7, AREAWATER: 1e6 },
      geometry: { type: 'Polygon', coordinates: [sq(r.lon, r.lat, d)] }
    }))
  };
}
const CENTROIDS_ESRI = {
  features: TRACTS.map((r, i) => ({
    attributes: { GEOID: r.geoid, AREALAND: 2.6e8 + i * 5e7 },
    centroid: { x: r.lon, y: r.lat }
  }))
};
const now = Date.now();
const SEATTLE_ROWS = [
  ['Motor Vehicle Theft', 'MOTOR VEHICLE THEFT'], ['Theft From Motor Vehicle', 'LARCENY-THEFT OFFENSES'],
  ['Burglary/Breaking & Entering', 'BURGLARY/BREAKING&ENTERING'], ['Simple Assault', 'ASSAULT OFFENSES'],
  ['Robbery', 'ROBBERY'], ['Destruction/Damage/Vandalism of Property', 'DESTRUCTION/DAMAGE/VANDALISM OF PROPERTY'],
  ['Murder & Nonnegligent Manslaughter', 'HOMICIDE OFFENSES'], ['Drug/Narcotic Violations', 'DRUG/NARCOTIC OFFENSES']
].map(([off, parent], i) => ({
  offense_start_datetime: new Date(now - (i + 1) * 86400000).toISOString(),
  offense: off, offense_parent_group: parent,
  latitude: String(47.6 + i * 0.005), longitude: String(-122.33 - i * 0.005),
  _100_block_address: (100 + i) + ' BLOCK OF PINE ST', mcpp: 'DOWNTOWN'
}));
const TACOMA_POINTS = {
  type: 'FeatureCollection',
  features: [0, 1, 2].map(i => ({
    type: 'Feature',
    properties: { OBJECTID: i, Crime: ['THEFT FROM MOTOR VEHICLE', 'ROBBERY', 'VANDALISM'][i], OccurredOn: now - (i + 2) * 86400000, Intersection: 'S ' + (10 + i) + 'TH & A ST' },
    geometry: { type: 'Point', coordinates: [-122.44 - i * 0.004, 47.25 + i * 0.004] }
  }))
};
const WSDOT_ROUTES = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { route_type: 3, route_short_name: '40', route_long_name: 'Northgate - Downtown', agency_name: 'King County Metro' },
      geometry: { type: 'LineString', coordinates: [[-122.36, 47.6], [-122.33, 47.61], [-122.3, 47.66]] } },
    { type: 'Feature', properties: { route_type: 0, route_short_name: '1 Line', route_long_name: 'Link light rail', agency_name: 'Sound Transit' },
      geometry: { type: 'LineString', coordinates: [[-122.33, 47.59], [-122.32, 47.62]] } }
  ]
};
const WSDOT_STOPS = {
  type: 'FeatureCollection',
  features: [0, 1, 2, 3].map(i => ({
    type: 'Feature', properties: { stop_name: 'Stop ' + i, agency_name: 'King County Metro' },
    geometry: { type: 'Point', coordinates: [-122.34 + i * 0.01, 47.6 + i * 0.005] }
  }))
};
const OSM_ELEMENTS = {
  elements: [
    { type: 'node', id: 1, lat: 47.61, lon: -122.33, tags: { name: 'QFC Broadway', shop: 'supermarket', 'addr:street': 'Broadway E' } },
    { type: 'way', id: 2, center: { lat: 47.62, lon: -122.32 }, tags: { name: 'Swedish Medical Center', amenity: 'hospital' } },
    { type: 'node', id: 3, lat: 47.6, lon: -122.34, tags: { name: 'Elliott Bay Cafe', amenity: 'cafe' } }
  ]
};
const NCES_POINTS = {
  type: 'FeatureCollection',
  features: [0, 1].map(i => ({
    type: 'Feature',
    properties: { NCESSCH: '5303300' + i, NAME: 'Fixture Elementary ' + i, STREET: (200 + i) + ' 5th Ave', CITY: 'Seattle', STATE: 'WA', ZIP: '98109' },
    geometry: { type: 'Point', coordinates: [-122.35 + i * 0.02, 47.62] }
  }))
};
const ISO_FC = {
  features: [15, 10, 5].map(m => ({
    type: 'Feature', properties: { contour: m },
    geometry: { type: 'Polygon', coordinates: [sq(-122.45, 47.6, m * 0.012)] }
  }))
};

// CDN assets served from the exact local npm tarball bytes (SRI must pass)
const PKGS = (process.env.PKGS_DIR || './node_modules').replace(/\/$/, '') + '/';
const CDN_FILES = {
  'leaflet.css': [PKGS + 'leaflet/dist/leaflet.css', 'text/css'],
  'leaflet.js': [PKGS + 'leaflet/dist/leaflet.js', 'application/javascript'],
  'leaflet.markercluster.js': [PKGS + 'leaflet.markercluster/dist/leaflet.markercluster.js', 'application/javascript'],
  'MarkerCluster.css': [PKGS + 'leaflet.markercluster/dist/MarkerCluster.css', 'text/css'],
  'MarkerCluster.Default.css': [PKGS + 'leaflet.markercluster/dist/MarkerCluster.Default.css', 'text/css'],
  'leaflet-heat.js': [PKGS + 'leaflet.heat/dist/leaflet-heat.js', 'application/javascript']
};

// --------------------------------------------------------------- routing
function jsonRes(obj) { return { contentType: 'application/json', body: JSON.stringify(obj) }; }
function handle(url, method, postData) {
  const u = new URL(url);
  const full = u.href;
  if (u.hostname === '127.0.0.1') return null; // let the local server handle it
  if (u.hostname === 'unpkg.com' || u.hostname === 'cdn.jsdelivr.net') {
    const name = u.pathname.split('/').pop();
    if (CDN_FILES[name]) return { path: CDN_FILES[name][0], contentType: CDN_FILES[name][1], headers: { 'Access-Control-Allow-Origin': '*' } };
    return { status: 404, contentType: 'text/plain', body: 'unknown cdn file' };
  }

  // Census API
  if (u.hostname === 'api.census.gov') {
    if (full.includes('/2024/')) return { status: 404, contentType: 'text/plain', body: 'error: unknown dataset' };
    const level = full.includes('tract') ? 'tract' : 'county';
    const rows = level === 'tract' ? TRACTS : COUNTIES;
    if (full.includes('/subject')) return jsonRes(acsSubject(rows, level));
    return jsonRes(acsDetailed(rows, level));
  }
  // TIGERweb
  if (u.hostname === 'tigerweb.geo.census.gov') {
    if (full.includes('Generalized_ACS2024')) return jsonRes({ error: { code: 404, message: 'not found' } });
    if (full.includes('Tracts_Blocks/MapServer/8/query')) {
      if (full.includes('returnCentroid=true')) return jsonRes(CENTROIDS_ESRI);
      return jsonRes(boundaryFC(TRACTS, 0.045));
    }
    if (full.includes('State_County/MapServer/12/query')) return jsonRes(boundaryFC(COUNTIES, 0.35));
    if (full.includes('Tracts_Blocks/MapServer?')) return jsonRes({ layers: [{ id: 7, name: 'Census Tracts Labels' }, { id: 8, name: 'Census Tracts' }, { id: 9, name: 'Census Blocks' }], maxRecordCount: 100000 });
    if (full.includes('State_County/MapServer?')) return jsonRes({ layers: [{ id: 11, name: 'States' }, { id: 12, name: 'Counties' }], maxRecordCount: 100000 });
    return jsonRes({ error: { code: 400, message: 'unexpected tigerweb url ' + u.pathname } });
  }
  // Socrata (Seattle)
  if (u.hostname === 'data.seattle.gov' || u.hostname === 'cos-data.seattle.gov') {
    if (u.pathname.includes('tazs-3rd5')) return jsonRes(u.searchParams.get('$offset') === '0' ? SEATTLE_ROWS : []);
    return jsonRes([]);
  }
  // Tacoma item + service
  if (u.hostname === 'www.arcgis.com') {
    return jsonRes({ id: '4b9326', url: 'https://services9.example.com/tacoma/FeatureServer' });
  }
  if (u.hostname === 'services9.example.com') {
    if (full.endsWith('FeatureServer?f=json')) return jsonRes({ layers: [{ id: 0, name: 'Reported Crime' }] });
    if (full.includes('/0?f=json')) return jsonRes({
      type: 'Feature Layer', maxRecordCount: 2000,
      fields: [
        { name: 'OBJECTID', type: 'esriFieldTypeOID' },
        { name: 'Crime', type: 'esriFieldTypeString' },
        { name: 'OccurredOn', type: 'esriFieldTypeDate' },
        { name: 'Intersection', type: 'esriFieldTypeString' }]
    });
    if (full.includes('/0/query')) return jsonRes(TACOMA_POINTS);
  }
  // Spokane
  if (u.hostname === 'services6.arcgis.com') {
    if (full.includes('FeatureServer?f=json')) return jsonRes({ layers: [{ id: 3, name: '2025 Smith' }, { id: 1, name: '2014 Lanier' }] });
    if (full.includes('/3?f=json')) return jsonRes({
      type: 'Feature Layer', maxRecordCount: 2000,
      fields: [{ name: 'offense_type', type: 'esriFieldTypeString' }, { name: 'occurred_date', type: 'esriFieldTypeDate' }]
    });
    if (full.includes('/1?f=json')) return jsonRes({ error: { code: 500, message: 'layer offline' } });
    if (full.includes('/3/query')) return jsonRes({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { offense_type: 'BURGLARY RESIDENTIAL', occurred_date: now - 86400000 * 3 }, geometry: { type: 'Point', coordinates: [-117.42, 47.66] } }]
    });
  }
  // WSDOT
  if (u.hostname === 'data.wsdot.wa.gov') {
    if (full.includes('TransitData/FeatureServer?f=json')) return jsonRes({ layers: [{ id: 1, name: 'Transit Stops' }, { id: 3, name: 'Transit Routes' }] });
    if (full.includes('TransitData/FeatureServer/3?f=json')) return jsonRes({
      type: 'Feature Layer', maxRecordCount: 2000,
      fields: [{ name: 'route_type', type: 'esriFieldTypeInteger' }, { name: 'route_short_name', type: 'esriFieldTypeString' }, { name: 'route_long_name', type: 'esriFieldTypeString' }, { name: 'agency_name', type: 'esriFieldTypeString' }]
    });
    if (full.includes('TransitData/FeatureServer/1?f=json')) return jsonRes({
      type: 'Feature Layer', maxRecordCount: 2000,
      fields: [{ name: 'stop_name', type: 'esriFieldTypeString' }, { name: 'agency_name', type: 'esriFieldTypeString' }]
    });
    if (full.includes('FeatureServer/3/query')) return jsonRes(WSDOT_ROUTES);
    if (full.includes('FeatureServer/1/query')) return jsonRes(WSDOT_STOPS);
    if (full.includes('FerryRoutes/MapServer?f=json')) return jsonRes({ layers: [{ id: 0, name: 'Ferry Routes' }] });
    if (full.includes('FerryRoutes/MapServer/0/query')) return jsonRes({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { ROUTE: 'Seattle - Bainbridge' }, geometry: { type: 'LineString', coordinates: [[-122.34, 47.6], [-122.5, 47.62]] } }]
    });
  }
  // NCES
  if (u.hostname === 'nces.ed.gov') {
    if (full.includes('K12_School_Locations?f=json')) return jsonRes({
      services: [{ name: 'K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2324' }, { name: 'K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2122' }, { name: 'K12_School_Locations/EDGE_GEOCODE_PRIVATESCH_2122' }]
    });
    if (full.includes('Postsecondary_School_Locations?f=json')) return jsonRes({
      services: [{ name: 'Postsecondary_School_Locations/EDGE_GEOCODE_POSTSECONDARYSCH_2324' }]
    });
    if (full.includes('/query')) return jsonRes(NCES_POINTS);
  }
  // Overpass
  if (u.pathname.includes('interpreter')) return jsonRes(OSM_ELEMENTS);
  // Valhalla
  if (u.hostname.startsWith('valhalla')) return jsonRes(ISO_FC);
  // Nominatim
  if (u.hostname === 'nominatim.openstreetmap.org') {
    if (u.pathname === '/search') return jsonRes([{ display_name: 'Space Needle, 400, Broad Street, Seattle, WA', lat: '47.6205', lon: '-122.3493' }]);
    return jsonRes({ display_name: '400 Broad St, Seattle, WA 98109' });
  }
  if (u.hostname === 'geocoding.geo.census.gov') {
    return jsonRes({ result: { addressMatches: [{ matchedAddress: '400 BROAD ST, SEATTLE, WA, 98109', coordinates: { x: -122.3493, y: 47.6205 } }] } });
  }
  // tiles and anything else: block
  return { status: 404, contentType: 'text/plain', body: 'blocked by test' };
}

// ------------------------------------------------------------------ test
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('console', msg => { if (msg.type() === 'error' && !/net::|Failed to load resource/.test(msg.text())) pageErrors.push('console: ' + msg.text()); });

await page.route('**/*', async route => {
  const req = route.request();
  const res = handle(req.url(), req.method(), req.postData());
  if (res === null) return route.continue();
  return route.fulfill(res);
});


async function setToggle(cardId, on) {
  await page.evaluate(([id, val]) => {
    const input = document.querySelector('#' + id + ' .card-toggle input');
    if (input.checked !== val) { input.checked = val; input.dispatchEvent(new Event('change')); }
  }, [cardId, on]);
}

console.log('· loading app');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
assert(await page.locator('#map .leaflet-pane').count() > 0, 'Leaflet map initialized');
assert(await page.locator('.bm-item').count() === 5, '5 basemap options rendered');
assert(await page.locator('.layer-card').count() === 6, '6 layer cards rendered');

console.log('· demographics (county level)');
await setToggle('card-demographics', true);
await page.waitForTimeout(1500);
let status = await page.locator('#card-demographics .status-line').textContent();
assert(/ACS 5-Year 2019-2023/.test(status), 'ACS vintage fell back to 2023: "' + status.trim() + '"');
assert(/8 counties/.test(status), 'county polygons loaded: "' + status.trim() + '"');
assert(await page.locator('.legend-block[data-layer="demographics"]').isVisible(), 'demographics legend visible');
const legendTitle = await page.locator('.legend-block[data-layer="demographics"] .legend-title').textContent();
assert(/Population density/.test(legendTitle), 'legend shows default metric');

console.log('· demographics (tract level)');
await page.evaluate(() => WAMAP.map.setView([47.6, -122.4], 11, { animate: false }));
await page.waitForTimeout(1600);
status = await page.locator('#card-demographics .status-line').textContent();
assert(/tracts loaded/.test(status), 'tracts loaded at z11: "' + status.trim() + '"');

console.log('· metric switch + insurance exclusivity');
await page.locator('#card-demographics select.input').selectOption('income');
await page.waitForTimeout(700);
assert(/Median household income/.test(await page.locator('.legend-block[data-layer="demographics"] .legend-title').textContent()), 'metric switch updates legend');
await setToggle('card-insurance', true);
await page.waitForTimeout(1200);
assert(!(await page.locator('#card-demographics .card-toggle input').isChecked()), 'enabling insurance switched demographics off');
assert(/Uninsured rate/.test(await page.locator('.legend-block[data-layer="insurance"] .legend-title').textContent()), 'insurance legend visible');

console.log('· amenities');
await setToggle('card-amenities', true);
await page.waitForTimeout(1800);
status = await page.locator('#card-amenities .status-line').textContent();
assert(/places loaded/.test(status), 'amenities loaded: "' + status.trim() + '"');
const schoolCount = await page.locator('#amen-count-schools').textContent();
assert(/\d/.test(schoolCount), 'NCES schools counted: "' + schoolCount + '"');

console.log('· transit');
await setToggle('card-transit', true);
await page.waitForTimeout(1500);
status = await page.locator('#card-transit .status-line').textContent();
assert(/WSDOT/.test(status), 'transit uses WSDOT source: "' + status.trim() + '"');

console.log('· crime');
await setToggle('card-crime', true);
await page.waitForTimeout(2000);
const chipSeattle = await page.locator('#crime-city-seattle .chip-count').textContent();
assert(chipSeattle.trim() === '8', 'Seattle chip count = 8, got "' + chipSeattle + '"');
const chipTacoma = await page.locator('#crime-city-tacoma .chip-count').textContent();
assert(chipTacoma.trim() === '3', 'Tacoma chip count = 3 (item->service resolution), got "' + chipTacoma + '"');
const chipSpokane = await page.locator('#crime-city-spokane .chip-count').textContent();
assert(chipSpokane.trim() === '1', 'Spokane chip count = 1 (era layers), got "' + chipSpokane + '"');
const total = await page.locator('.crime-total').textContent();
assert(/incidents in view/.test(total), 'viewport totals rendered: "' + total.trim() + '"');
// MVT classification check: "Theft From Motor Vehicle" must be theft, not MVT.
// Only Seattle is inside the current viewport, so expect 1 of each there.
const counts = await page.evaluate(() => ({
  mvt: document.getElementById('crime-count-mvt').textContent,
  theft: document.getElementById('crime-count-theft').textContent
}));
assert(counts.mvt.trim() === '1', 'MVT classified once (got "' + counts.mvt + '")');
assert(counts.theft.trim() === '1', 'theft-from-vehicle classified as theft (got "' + counts.theft + '")');
// classification rules against realistic NIBRS strings
const cls = await page.evaluate(() => [
  ['Theft From Motor Vehicle||LARCENY-THEFT OFFENSES', 'theft'],
  ['Motor Vehicle Theft||MOTOR VEHICLE THEFT', 'mvt'],
  ['SEX OFFENSES, CONSENSUAL', 'sexoff'],
  ['TRESPASS OF REAL PROPERTY', 'trespass'],
  ['BAD CHECKS', 'fraud'],
  ['DRIVING UNDER THE INFLUENCE', 'dui'],
  ['WEAPON LAW VIOLATIONS', 'weapons'],
  ['FAMILY OFFENSES, NONVIOLENT', 'other'],
  ['AGGRAVATED ASSAULT||ASSAULT OFFENSES', 'assault'],
  ['MALICIOUS HARASSMENT', 'assault'],
  ['ARSON', 'arson'],
  ['MURDER & NONNEGLIGENT MANSLAUGHTER', 'homicide']
].map(([t, want]) => ({ t, want, got: WAMAP.classifyCrime(t).id })));
for (const c of cls) assert(c.got === c.want, `classify "${c.t}" -> ${c.got} (want ${c.want})`);
// drugs is off by default
const drugCount = await page.evaluate(() => document.getElementById('crime-count-drugs').textContent);
assert(drugCount.trim() === '', 'drugs category off by default');
await page.locator('#card-crime select.input >> nth=1').selectOption('heat');
await page.waitForTimeout(600);
assert(await page.locator('.leaflet-heatmap-layer, canvas.leaflet-heatmap-layer').count() > 0, 'heat map mode renders');

console.log('· drive time');
await page.evaluate(() => WAMAP.driveTime.setOrigin(47.6, -122.45, 'Test origin'));
await page.waitForTimeout(2200);
assert(await page.locator('#card-drivetime .card-toggle input').isChecked(), 'drive-time card auto-enabled');
assert(/Drive time/.test(await page.locator('.legend-block[data-layer="drivetime"]').textContent()), 'drive-time legend visible');
const dtRows = await page.locator('.dt-table tbody tr').count();
assert(dtRows === 3, '3 drive-time stat rows, got ' + dtRows);
const dtFirst = await page.locator('.dt-table tbody tr >> nth=0').textContent();
assert(/≤ 5 min/.test(dtFirst) && /\d/.test(dtFirst), '5-min band has stats: "' + dtFirst.trim() + '"');

console.log('· search');
await page.fill('#search-input', '400 Broad St, Seattle');
await page.press('#search-input', 'Enter');
await page.waitForTimeout(1200);
const items = await page.locator('.search-item').count();
assert(items >= 1, 'search returned results');
const srcText = await page.locator('.search-src >> nth=0').textContent();
assert(/Census/.test(srcText), 'address routed to Census geocoder: "' + srcText + '"');
await page.locator('.search-item >> nth=0').click();
await page.waitForTimeout(1300);
assert(await page.locator('.search-pin').count() === 1, 'search marker placed');
assert(/Drive times from here/.test(await page.locator('.leaflet-popup').textContent()), 'search popup has drive-time action');

console.log('· pins');
await page.evaluate(() => WAMAP.map.closePopup());
await page.locator('#pin-mode-btn').click();
const mapBox = await page.locator('#map').boundingBox();
await page.mouse.click(mapBox.x + mapBox.width * 0.6, mapBox.y + mapBox.height * 0.4);
await page.waitForTimeout(600); // avoid the two clicks registering as a double-click zoom
await page.mouse.click(mapBox.x + mapBox.width * 0.65, mapBox.y + mapBox.height * 0.45);
await page.waitForTimeout(600);
assert((await page.locator('#pin-count').textContent()).trim() === '2', 'two pins dropped in pin mode');
await page.keyboard.press('Escape');
await page.locator('#pin-clear-btn').click();
await page.waitForTimeout(300);
assert((await page.locator('#pin-count').textContent()).trim() === '', 'pins cleared');

console.log('· about modal');
await page.locator('#about-btn').click();
assert(await page.locator('#about-modal').isVisible(), 'sources modal opens');
assert(/Valhalla/.test(await page.locator('#sources-content').textContent()), 'sources content populated');
await page.locator('#about-close').click();

await page.screenshot({ path: 'smoke.png', fullPage: false });
await browser.close();

console.log('\npage errors: ' + (pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : 'none'));
if (pageErrors.length) failures.push(pageErrors.length + ' page error(s)');
console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);

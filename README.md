# Washington Explorer

An interactive mapping app for Washington state: demographics, health-insurance coverage,
amenities, transit, crime, and 5/10/15-minute drive-time analysis — all fetched live from
public, authoritative data services. Pure static site (Leaflet + vanilla JS, no build step),
designed to run on GitHub Pages.

**Open `index.html` via any static web server, or visit the GitHub Pages URL once this is on
the default branch.**

## Features

| Feature | Details |
|---|---|
| Toggleable basemaps | OpenStreetMap Streets, CARTO Light/Dark, Esri World Imagery, Esri Topo |
| Address search | U.S. Census Bureau Geocoder for street addresses, OSM Nominatim for places/POIs; jump-to with action popup |
| Pin dropping | Pin mode (Esc to exit), draggable pins, reverse-geocoded labels, persisted in `localStorage` |
| Demographics layer | Choropleth by county (statewide) or census tract (zoom 9+): population density, total population, median household income, median age, % bachelor's+, median home value, median gross rent, poverty rate, unemployment, owner-occupancy. Click any area for a full profile |
| Health-insurance layer | % uninsured / % insured (civilian noninstitutionalized population), same county/tract engine |
| Amenities layer | Schools (NCES public + private), colleges (NCES postsecondary), grocery, restaurants/cafes, retail, pharmacies, hospitals/clinics, banks, fuel/EV, parks — per-category toggles, clustered markers, viewport-based loading |
| Transit layer | Statewide routes and stops from WSDOT's consolidated GTFS (all WA agencies), styled by mode (bus, light rail/streetcar, rail, ferry), plus WSF ferry routes |
| Crime layer | Incident-level police reports for Seattle, Tacoma, and Spokane with per-category filters (homicide, assault, robbery, sex offenses, burglary, larceny/theft, motor-vehicle theft, arson, vandalism, fraud, drugs, weapons, DUI, trespass…), 30/90/180/365-day ranges, clustered points or heat map, live in-view counts |
| Drive-time tool | 5/10/15-minute drive-time areas (isochrones) around any address, pin, or clicked point, with estimated population, households, and income inside each band |

## Data sources (and why they were chosen)

Everything loads at runtime from public, keyless, CORS-enabled services. The only bundled
data is a fallback copy of county boundaries.

| Layer | Source | Notes |
|---|---|---|
| Demographics & insurance | [U.S. Census Bureau ACS 5-Year Estimates](https://www.census.gov/programs-surveys/acs) via the [Census Data API](https://api.census.gov/data.html) | The authoritative source for sub-county demographics. ACS 5-year is the only dataset published for **every** census tract; the app auto-detects the newest vintage. Insurance comes from subject table **S2701**, the standard federal measure of coverage below county level |
| Boundaries | [Census TIGERweb](https://tigerweb.geo.census.gov/arcgis/rest/services) generalized services | Official cartographic tract/county boundaries matching the ACS vintage; `data/wa_counties.geojson` (built from Census cartographic boundary files via [us-atlas](https://github.com/topojson/us-atlas)) is a bundled fallback |
| Schools & colleges | [NCES EDGE geocoded school locations](https://nces.ed.gov/programs/edge/geographic/schoollocations) (`nces.ed.gov/opengis`) | Federal point locations from CCD (public), PSS (private), IPEDS (postsecondary); newest school year auto-selected; OSM fallback if unreachable |
| Other amenities | [OpenStreetMap](https://www.openstreetmap.org) via [Overpass API](https://overpass-api.de) | The most complete open nationwide POI dataset; fetched live per viewport, endpoint failover |
| Transit | [WSDOT statewide consolidated GTFS](https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer) + [WSDOT Ferry Routes](https://data.wsdot.wa.gov/arcgis/rest/services/Shared/FerryRoutes/MapServer) | WSDOT merges every WA transit agency's GTFS feed into one statewide routes/stops dataset — broader than any single agency feed; OSM fallback |
| Crime — Seattle | [SPD Crime Data: 2008-Present](https://data.seattle.gov/Public-Safety/SPD-Crime-Data-2008-Present/tazs-3rd5) (Socrata, NIBRS) | Updated daily; locations generalized to the 100-block |
| Crime — Tacoma | [City of Tacoma Reported Crime](https://data.cityoftacoma.org/datasets/tacoma::city-of-tacoma-reported-crime-tacoma/about) (ArcGIS) | NIBRS-based; the city excludes DV and sex offenses from public data |
| Crime — Spokane | [City of Spokane open GIS](https://my.spokanecity.org/opendata/gis/) CrimePoints service | Incident points from the city's open-data GIS |
| Drive times | [Valhalla](https://github.com/valhalla/valhalla) routing engine on the public [FOSSGIS server](https://valhalla.openstreetmap.de) | Open-source isochrones over the OSM road network (road class, speed limits, turn costs). Free keyless services model **typical** conditions, not live congestion — the UI says so explicitly |
| Geocoding | [Census Geocoder](https://geocoding.geo.census.gov/geocoder/) + [Nominatim](https://nominatim.org) | Census is the most accurate free geocoder for US street addresses; Nominatim covers places/POIs |

There is no statewide *incident-level* crime feed — incident data is published city by city, so
the crime layer covers cities with open police data (statewide agency totals are published
annually as PDFs by [WASPC](https://www.waspc.org/crime-statistics--nibrs-)). Crime category
filters use one NIBRS keyword rule set across cities so filters behave consistently, but
reporting practices differ between agencies: **compare within a city, not across cities.**

## Accuracy notes

- ACS values are 5-year survey estimates with margins of error; small tracts are noisy.
  Suppressed values render as "no data".
- Drive-time bands are estimates for typical conditions; peak-hour urban drive times can be
  materially longer. Population inside bands uses tract-centroid allocation (a tract counts
  if its centroid is inside the band).
- Crime points are reported offenses, not convictions; some records lack coordinates and are
  excluded (the layer says how many).
- OSM amenity completeness varies by area; schools/colleges use NCES federal data instead.

## Architecture

```
index.html                 app shell + layer cards
assets/css/app.css         design system (light + dark)
assets/js/config.js        every endpoint, metric, category, palette token
assets/js/util.js          fetch/ArcGIS/Socrata/Overpass/Census clients, geocoding, geometry
assets/js/layers/          choropleth engine, amenities, transit, crime, drive time
data/wa_counties.geojson   bundled county-boundary fallback
scripts/build_counties.mjs rebuilds the bundled counties from us-atlas
scripts/smoke-test.mjs     headless-Chromium integration test with mocked API fixtures
```

Leaflet 1.9.4 + markercluster + heat load from pinned CDN versions (unpkg, jsDelivr
fallback) with SRI integrity hashes computed from the exact npm tarballs.

Resilience: ACS vintages and TIGERweb services are tried newest-first; ArcGIS layers and
fields are discovered by introspection rather than hardcoded ids; Overpass rotates endpoints;
Seattle's portal has domain failover; NCES/WSDOT fall back to OSM. Every layer shows its own
source/status line, and failures degrade per-layer with a visible message.

## Development

```bash
python3 -m http.server 8137          # serve the app at http://localhost:8137
node --check assets/js/**/*.js       # syntax check

# integration test (mocked API fixtures, headless Chromium)
npm i playwright-core leaflet@1.9.4 leaflet.markercluster@1.5.3 leaflet.heat@0.2.0
CHROMIUM_PATH=/path/to/chromium node scripts/smoke-test.mjs
```

## Attribution

Basemaps © OpenStreetMap contributors, © CARTO, © Esri. Data: U.S. Census Bureau, NCES,
WSDOT, City of Seattle, City of Tacoma, City of Spokane, OpenStreetMap contributors
(ODbL), Valhalla/FOSSGIS. This project is not affiliated with any of these providers.

/* Washington Explorer — configuration
 * All data sources, metrics, categories and palette tokens live here.
 * Every endpoint is a public, keyless, CORS-enabled service; sources are
 * documented in the About panel (see SOURCES at the bottom of this file).
 */
(function () {
  'use strict';
  const WAMAP = (window.WAMAP = window.WAMAP || {});

  // ---------------------------------------------------------------- palette
  // Validated palette (single-hue sequential ramps, fixed categorical order,
  // CVD-checked). Do not re-order categorical slots.
  const PALETTE = {
    seqBlue:   ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#1c5cab', '#0d366b'],
    seqOrange: ['#fde3d3', '#f9c19e', '#f39a67', '#eb6834', '#c04e1d', '#8a350f'],
    seqRed:    ['#fbd5d4', '#f4a3a2', '#ec7473', '#e34948', '#b02a2a', '#7a1414'],
    cat: {
      blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100',
      magenta: '#e87ba4', green: '#008300', violet: '#4a3aa7', red: '#e34948'
    },
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
    // Drive-time bands: single-hue ordinal (validated): near = dark.
    isochrone: { 5: '#1c5cab', 10: '#3987e5', 15: '#86b6ef' },
    crimeGroups: { person: '#e34948', property: '#2a78d6', society: '#4a3aa7', other: '#898781' },
    heatGradient: { 0.25: '#fbd5d4', 0.45: '#f4a3a2', 0.62: '#ec7473', 0.78: '#e34948', 0.9: '#b02a2a', 1.0: '#7a1414' }
  };

  // ------------------------------------------------------------------- map
  const MAP = {
    center: [47.35, -120.7],
    zoom: 7,
    minZoom: 5,
    maxZoom: 19,
    // Washington state with generous padding
    maxBounds: [[43.6, -129.5], [51.5, -112.0]],
    waBounds: { south: 45.53, west: -124.85, north: 49.01, east: -116.90 },
    tractZoom: 9 // choropleths switch county -> tract at this zoom
  };

  const BASEMAPS = [
    { id: 'streets', label: 'Streets (OSM)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
    { id: 'light', label: 'Light (CARTO)', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      options: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' } },
    { id: 'dark', label: 'Dark (CARTO)', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      options: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' } },
    { id: 'imagery', label: 'Imagery (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Imagery &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' } },
    { id: 'topo', label: 'Topo (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Map tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors' } }
  ];

  // ---------------------------------------------------------------- census
  // ACS 5-year estimates. Vintages are tried in order until one responds, so
  // the app picks up new releases automatically.
  const CENSUS = {
    apiBase: 'https://api.census.gov/data',
    vintages: [2024, 2023, 2022],
    stateFips: '53',
    // Detailed tables (dataset acs/acs5)
    detailedVars: [
      'B01003_001E', // total population
      'B01002_001E', // median age
      'B19013_001E', // median household income
      'B19301_001E', // per-capita income
      'B25077_001E', // median home value (owner-occupied)
      'B25064_001E', // median gross rent
      'B15003_001E', 'B15003_022E', 'B15003_023E', 'B15003_024E', 'B15003_025E', // education 25+
      'B17001_001E', 'B17001_002E', // poverty universe / below poverty
      'B23025_003E', 'B23025_005E', // civilian labor force / unemployed
      'B25003_001E', 'B25003_002E', // occupied units / owner-occupied
      'B11001_001E'  // households
    ],
    // Subject table S2701 (dataset acs/acs5/subject) — health insurance
    subjectVars: ['S2701_C01_001E', 'S2701_C03_001E', 'S2701_C05_001E'],
    cacheTtlMs: 30 * 24 * 3600 * 1000
  };

  // TIGERweb generalized (cartographic) boundaries, one service per ACS vintage.
  const TIGERWEB = {
    roots: [
      'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024',
      'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023',
      'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2022'
    ],
    tractService: 'Tracts_Blocks/MapServer',
    tractLayerName: /census tracts/i,
    countyService: 'State_County/MapServer',
    countyLayerName: /counties/i,
    localCounties: 'data/wa_counties.geojson'
  };

  const SQMI_PER_SQM = 1 / 2589988.110336;

  // Demographic metrics. `value(d)` receives the derived record built in
  // censusStore; land area (sq meters) is merged from boundary attributes.
  const DEMO_METRICS = [
    { id: 'density', label: 'Population density', unit: '/sq mi', fmt: 'int',
      value: d => (d.pop != null && d.aland > 0 ? d.pop / (d.aland * SQMI_PER_SQM) : null),
      needsArea: true, desc: 'People per square mile of land area (ACS B01003 / TIGER land area).' },
    { id: 'pop', label: 'Total population', unit: '', fmt: 'int',
      value: d => d.pop, desc: 'Total population (ACS table B01003).' },
    { id: 'income', label: 'Median household income', unit: '$', fmt: 'money',
      value: d => d.medInc, desc: 'Median household income in the past 12 months (ACS table B19013).' },
    { id: 'age', label: 'Median age', unit: 'yrs', fmt: 'num1',
      value: d => d.medAge, desc: 'Median age (ACS table B01002).' },
    { id: 'edu', label: "Bachelor's degree or higher", unit: '%', fmt: 'pct1',
      value: d => d.pctBach, desc: "Share of population 25+ with a bachelor's degree or higher (ACS table B15003)." },
    { id: 'homeValue', label: 'Median home value', unit: '$', fmt: 'money',
      value: d => d.medHome, desc: 'Median value of owner-occupied housing units (ACS table B25077).' },
    { id: 'rent', label: 'Median gross rent', unit: '$', fmt: 'money',
      value: d => d.medRent, desc: 'Median gross rent (ACS table B25064).' },
    { id: 'poverty', label: 'Poverty rate', unit: '%', fmt: 'pct1',
      value: d => d.pctPoverty, desc: 'Share of the poverty universe below the poverty level (ACS table B17001).' },
    { id: 'unemp', label: 'Unemployment rate', unit: '%', fmt: 'pct1',
      value: d => d.pctUnemp, desc: 'Unemployed share of the civilian labor force (ACS table B23025).' },
    { id: 'owner', label: 'Owner-occupied share', unit: '%', fmt: 'pct1',
      value: d => d.pctOwner, desc: 'Owner-occupied share of occupied housing units (ACS table B25003).' }
  ];

  const INSURANCE_METRICS = [
    { id: 'uninsured', label: 'Uninsured rate', unit: '%', fmt: 'pct1',
      value: d => d.pctUninsured, desc: 'Civilian noninstitutionalized population without health insurance coverage (ACS subject table S2701).' },
    { id: 'insured', label: 'Insured rate', unit: '%', fmt: 'pct1',
      value: d => d.pctInsured, desc: 'Civilian noninstitutionalized population with health insurance coverage (ACS subject table S2701).' }
  ];

  // -------------------------------------------------------------- geocoding
  const GEOCODE = {
    censusUrl: 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
    censusBenchmark: 'Public_AR_Current',
    nominatimSearch: 'https://nominatim.openstreetmap.org/search',
    nominatimReverse: 'https://nominatim.openstreetmap.org/reverse',
    // west,north,east,south per Nominatim viewbox convention (left,top,right,bottom)
    viewbox: '-124.85,49.01,-116.90,45.53',
    minIntervalMs: 1100
  };

  // --------------------------------------------------------------- overpass
  const OVERPASS = {
    endpoints: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter'
    ],
    timeoutS: 40
  };

  // -------------------------------------------------------------- amenities
  // source 'osm'  -> Overpass selectors (applied as nwr[...](bbox))
  // source 'nces' -> NCES EDGE point services with OSM fallback
  const AMENITIES = [
    { id: 'schools', label: 'Schools (K-12)', emoji: '🏫', color: PALETTE.cat.blue, minZoom: 11, cap: 900,
      source: 'nces', ncesKind: 'k12',
      osm: ['["amenity"="school"]', '["amenity"="kindergarten"]'] },
    { id: 'colleges', label: 'Colleges & universities', emoji: '🎓', color: PALETTE.cat.violet, minZoom: 9, cap: 500,
      source: 'nces', ncesKind: 'postsecondary',
      osm: ['["amenity"="college"]', '["amenity"="university"]'] },
    { id: 'grocery', label: 'Grocery & supermarkets', emoji: '🛒', color: PALETTE.cat.green, minZoom: 12, cap: 800,
      source: 'osm', osm: ['["shop"~"^(supermarket|grocery|greengrocer|convenience|health_food)$"]'] },
    { id: 'restaurants', label: 'Restaurants & cafes', emoji: '🍽️', color: PALETTE.cat.orange, minZoom: 14, cap: 1200,
      source: 'osm', osm: ['["amenity"~"^(restaurant|cafe|fast_food)$"]'] },
    { id: 'retail', label: 'Retail & shopping', emoji: '🛍️', color: PALETTE.cat.magenta, minZoom: 14, cap: 1200,
      source: 'osm', osm: ['["shop"~"^(mall|department_store|clothes|shoes|electronics|furniture|doityourself|hardware|sports|variety_store|general|gift|jewelry|beauty|books|toys|pet)$"]'] },
    { id: 'pharmacy', label: 'Pharmacies', emoji: '💊', color: PALETTE.cat.aqua, minZoom: 12, cap: 500,
      source: 'osm', osm: ['["amenity"="pharmacy"]', '["shop"="chemist"]', '["healthcare"="pharmacy"]'] },
    { id: 'health', label: 'Hospitals & clinics', emoji: '🏥', color: PALETTE.cat.red, minZoom: 9, cap: 600,
      source: 'osm', osm: ['["amenity"~"^(hospital|clinic)$"]', '["healthcare"~"^(hospital|clinic)$"]'] },
    { id: 'banks', label: 'Banks & credit unions', emoji: '🏦', color: PALETTE.cat.yellow, minZoom: 13, cap: 500,
      source: 'osm', osm: ['["amenity"="bank"]'] },
    { id: 'fuel', label: 'Fuel & EV charging', emoji: '⛽', color: PALETTE.cat.blue, minZoom: 12, cap: 700,
      source: 'osm', osm: ['["amenity"="fuel"]', '["amenity"="charging_station"]'] },
    { id: 'parks', label: 'Parks & playgrounds', emoji: '🌳', color: PALETTE.cat.green, minZoom: 12, cap: 900,
      source: 'osm', osm: ['["leisure"~"^(park|playground)$"]'] }
  ];

  const NCES = {
    k12Folder: 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations',
    postsecFolder: 'https://nces.ed.gov/opengis/rest/services/Postsecondary_School_Locations',
    k12Match: /^EDGE_GEOCODE_(PUBLICSCH|PRIVATESCH)_(\d{4})$/i,
    postsecMatch: /^EDGE_GEOCODE_POSTSECONDARYSCH_(\d{4})$/i
  };

  // ---------------------------------------------------------------- transit
  const TRANSIT = {
    wsdotService: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer',
    ferryService: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/FerryRoutes/MapServer',
    routeLayerName: /route/i,
    stopLayerName: /stop/i,
    stopsMinZoom: 13,
    routesMinZoom: 8,
    // GTFS route_type -> display
    modes: {
      0:  { label: 'Streetcar / tram', color: PALETTE.cat.violet, weight: 3 },
      1:  { label: 'Metro', color: PALETTE.cat.orange, weight: 3 },
      2:  { label: 'Rail (Amtrak / Sounder)', color: PALETTE.cat.green, weight: 3 },
      3:  { label: 'Bus', color: PALETTE.cat.blue, weight: 2 },
      4:  { label: 'Ferry', color: PALETTE.cat.aqua, weight: 3, dash: '6 6' },
      5:  { label: 'Cable car', color: PALETTE.cat.magenta, weight: 3 },
      6:  { label: 'Gondola', color: PALETTE.cat.magenta, weight: 3 },
      7:  { label: 'Funicular', color: PALETTE.cat.magenta, weight: 3 },
      12: { label: 'Monorail', color: PALETTE.cat.orange, weight: 3 },
      bus: 3, ferry: 4, light_rail: 0, tram: 0, train: 2, subway: 1, monorail: 12
    }
  };

  // ------------------------------------------------------------------ crime
  const CRIME = {
    ranges: [
      { id: 30, label: 'Last 30 days' },
      { id: 90, label: 'Last 90 days' },
      { id: 180, label: 'Last 6 months' },
      { id: 365, label: 'Last 12 months' }
    ],
    defaultRange: 90,
    maxPerCity: 25000,
    // Category rules are applied (in order) against UPPERCASED
    // "offense || parent group" text from each source, so one rule set covers
    // all cities. First match wins.
    categories: [
      { id: 'homicide', label: 'Homicide', group: 'person', re: /HOMICIDE|MURDER|MANSLAUGHTER/ },
      { id: 'sexoff', label: 'Sex offenses', group: 'person', re: /RAPE|SODOMY|FONDLING|SEX OFFENSE|SEXUAL|INDECENT|PEEPING|PORNOGRAPHY|HUMAN TRAFFICKING/ },
      { id: 'robbery', label: 'Robbery', group: 'person', re: /ROBBERY/ },
      { id: 'kidnap', label: 'Kidnapping', group: 'person', re: /KIDNAP|ABDUCTION/ },
      { id: 'assault', label: 'Assault', group: 'person', re: /ASSAULT|INTIMIDATION|HARASSMENT/ },
      { id: 'arson', label: 'Arson', group: 'property', re: /ARSON/ },
      { id: 'mvt', label: 'Motor vehicle theft', group: 'property', re: /MOTOR VEHICLE THEFT|AUTO THEFT/ },
      { id: 'burglary', label: 'Burglary / B&E', group: 'property', re: /BURGLARY|BREAKING/ },
      { id: 'theft', label: 'Larceny / theft', group: 'property', re: /LARCENY|THEFT|SHOPLIFT|PICKPOCKET|PURSE|STOLEN PROPERTY/ },
      { id: 'vandalism', label: 'Vandalism / property damage', group: 'property', re: /VANDALISM|DESTRUCTION|DAMAGE|MALICIOUS MISCHIEF|GRAFFITI/ },
      { id: 'fraud', label: 'Fraud / forgery', group: 'property', re: /FRAUD|FORGERY|COUNTERFEIT|EMBEZZLE|EXTORTION|BAD CHECK|IDENTITY/ },
      { id: 'drugs', label: 'Drugs / narcotics', group: 'society', re: /DRUG|NARCOTIC/ },
      { id: 'weapons', label: 'Weapons', group: 'society', re: /WEAPON|FIREARM/ },
      { id: 'dui', label: 'DUI', group: 'society', re: /DUI|DRIVING UNDER/ },
      { id: 'trespass', label: 'Trespass', group: 'society', re: /TRESPASS/ },
      { id: 'other', label: 'Other offenses', group: 'other', re: /./ }
    ],
    defaultOn: ['homicide', 'sexoff', 'robbery', 'kidnap', 'assault', 'arson', 'mvt', 'burglary', 'theft', 'vandalism'],
    cities: [
      {
        id: 'seattle', label: 'Seattle', type: 'socrata',
        domains: ['https://data.seattle.gov', 'https://cos-data.seattle.gov'],
        dataset: 'tazs-3rd5',
        fields: {
          date: 'offense_start_datetime', reported: 'report_datetime',
          offense: 'offense', parent: 'offense_parent_group',
          lat: 'latitude', lon: 'longitude', addr: '_100_block_address', area: 'mcpp'
        },
        link: 'https://data.seattle.gov/Public-Safety/SPD-Crime-Data-2008-Present/tazs-3rd5',
        note: 'Seattle PD NIBRS incident reports; locations generalized to the 100 block.'
      },
      {
        id: 'tacoma', label: 'Tacoma', type: 'arcgis-item',
        itemId: '4b9326bf98c84fe4a1d8526ee6870c2d',
        portal: 'https://www.arcgis.com',
        link: 'https://data.cityoftacoma.org/datasets/tacoma::city-of-tacoma-reported-crime-tacoma/about',
        note: 'City of Tacoma reported crime (NIBRS-based). Tacoma excludes domestic-violence and sex offenses from its public data.'
      },
      {
        id: 'spokane', label: 'Spokane', type: 'arcgis-service',
        service: 'https://services6.arcgis.com/ydggmMcp46DZ7B9Z/ArcGIS/rest/services/CrimePoints/FeatureServer',
        link: 'https://my.spokanecity.org/opendata/gis/',
        note: 'City of Spokane police incident points from the city open-data GIS.'
      }
    ]
  };

  // ------------------------------------------------------------- drive time
  const ISOCHRONE = {
    endpoints: ['https://valhalla1.openstreetmap.de/isochrone'],
    clientId: 'justin-tran1.github.io/wa-explorer',
    minutes: [5, 10, 15],
    costing: 'auto',
    denoise: 0.35,
    generalize: 60
  };

  // ---------------------------------------------------------------- sources
  const SOURCES = [
    { section: 'Demographics & health insurance', items: [
      'U.S. Census Bureau, American Community Survey (ACS) 5-Year Estimates, retrieved live from the Census Data API (api.census.gov). The vintage in use is shown in the layer legend; the app automatically uses the newest published vintage.',
      'Health insurance coverage: ACS subject table S2701 (civilian noninstitutionalized population), the standard federal source for sub-county insurance coverage.',
      'Boundaries: U.S. Census Bureau TIGERweb generalized (cartographic) census tracts and counties. Bundled county fallback derived from the Census Bureau cartographic boundary files (via the us-atlas package).',
      'Median values are ACS estimates and carry margins of error; small tracts have wider error bands. Values suppressed by the Census Bureau are shown as "no data".'
    ]},
    { section: 'Amenities', items: [
      'Schools and colleges: National Center for Education Statistics (NCES) EDGE geocoded point locations - public schools (Common Core of Data), private schools (PSS), and postsecondary institutions (IPEDS). The newest published school year is selected automatically; if NCES is unreachable the app falls back to OpenStreetMap.',
      'Shops, grocery, restaurants, pharmacies, hospitals, banks, fuel and parks: OpenStreetMap via the Overpass API, fetched live for the current map view. OSM is the most complete open nationwide POI source; completeness varies by area.'
    ]},
    { section: 'Transit', items: [
      'Washington State Department of Transportation (WSDOT) consolidated statewide GTFS transit data (routes and stops for every transit agency in the state), served from data.wsdot.wa.gov.',
      'WSDOT Ferry Routes service for Washington State Ferries.',
      'If WSDOT services are unreachable the app falls back to OpenStreetMap transit route relations and stops.'
    ]},
    { section: 'Crime', items: [
      'Seattle: Seattle Police Department "SPD Crime Data: 2008-Present" (NIBRS), Seattle Open Data portal, updated daily. Locations are generalized to the 100 block.',
      'Tacoma: City of Tacoma "Reported Crime" open dataset (NIBRS-based). The city excludes domestic-violence and sex offenses from public data.',
      'Spokane: City of Spokane police incident points (CrimePoints service) from the city open-data GIS.',
      'Incident-level open police data is published city by city; there is no statewide incident feed. Counts reflect reported offenses, not convictions, and reporting practices differ between agencies - compare within a city, not across cities. Statewide agency totals are published annually by WASPC ("Crime in Washington").'
    ]},
    { section: 'Drive-time areas', items: [
      'Isochrones are computed by the Valhalla open-source routing engine (public FOSSGIS server) over the OpenStreetMap road network, using road classes, speed limits and turn costs.',
      'Estimates reflect typical (free-flow to moderate) conditions, not live congestion. Peak-hour drive times in urban areas can be materially longer.',
      'Population and income inside each band are estimated by allocating whole census tracts whose centroid falls inside the band (ACS 5-year data).'
    ]},
    { section: 'Basemaps & geocoding', items: [
      'Basemaps: OpenStreetMap; CARTO Positron / Dark Matter; Esri World Imagery and World Topographic Map.',
      'Address search: U.S. Census Bureau Geocoder (street addresses) with OpenStreetMap Nominatim as fallback and for place-name search. Reverse geocoding by Nominatim.'
    ]}
  ];

  WAMAP.CONFIG = {
    PALETTE, MAP, BASEMAPS, CENSUS, TIGERWEB, DEMO_METRICS, INSURANCE_METRICS,
    GEOCODE, OVERPASS, AMENITIES, NCES, TRANSIT, CRIME, ISOCHRONE, SOURCES,
    SQMI_PER_SQM
  };
})();

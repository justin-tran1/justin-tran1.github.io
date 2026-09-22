/* Washington Explorer — crime layer.
 * Incident-level reports straight from each police department's open-data
 * service: Seattle PD (Socrata/NIBRS), City of Tacoma (ArcGIS), City of
 * Spokane (ArcGIS). Category filters use one keyword rule set applied to each
 * source's NIBRS offense text, so filters behave the same across cities.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  const CAT_BY_ID = {};
  for (const c of CFG.CRIME.categories) CAT_BY_ID[c.id] = c;

  function classify(text) {
    const up = String(text || '').toUpperCase();
    for (const c of CFG.CRIME.categories) if (c.re.test(up)) return c;
    return CAT_BY_ID.other;
  }
  WAMAP.classifyCrime = classify; // exposed for tests/console inspection

  WAMAP.createCrime = function (opts) {
    const { map, card } = opts;
    const cluster = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 50, disableClusteringAtZoom: 17, showCoverageOnHover: false
    });
    let heat = null;

    const state = {
      enabled: false,
      range: CFG.CRIME.defaultRange,
      mode: 'clusters',
      catOn: new Map(CFG.CRIME.categories.map(c => [c.id, CFG.CRIME.defaultOn.includes(c.id)])),
      cities: new Map(CFG.CRIME.cities.map(c => [c.id, {
        cfg: c, on: true, status: 'idle', incidents: [], truncated: false, error: null, noCoords: 0, resolved: null
      }]))
    };

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');

    const cityRow = U.el('div', { class: 'city-chips' });
    for (const [cid, city] of state.cities) {
      const chip = U.el('button', { class: 'city-chip', id: 'crime-city-' + cid, type: 'button', title: city.cfg.note }, [
        U.el('span', { class: 'chip-dot' }), U.el('span', { text: city.cfg.label }),
        U.el('span', { class: 'chip-count', text: '' })
      ]);
      chip.addEventListener('click', () => {
        city.on = !city.on;
        chip.classList.toggle('off', !city.on);
        if (city.on && state.enabled && city.status === 'idle') fetchCity(cid);
        renderIncidents();
        updateCityChips();
      });
      cityRow.appendChild(chip);
    }

    const controls = U.el('div', { class: 'row-inline' });
    const rangeSel = U.el('select', { class: 'input small', 'aria-label': 'Time range' },
      CFG.CRIME.ranges.map(r => U.el('option', { value: String(r.id), text: r.label })));
    rangeSel.value = String(state.range);
    const modeSel = U.el('select', { class: 'input small', 'aria-label': 'Display mode' }, [
      U.el('option', { value: 'clusters', text: 'Points (clustered)' }),
      U.el('option', { value: 'heat', text: 'Heat map' })
    ]);
    controls.append(rangeSel, modeSel);

    const catList = U.el('div', { class: 'check-list crime-cats' });
    const groups = [
      { id: 'person', label: 'Crimes against persons' },
      { id: 'property', label: 'Crimes against property' },
      { id: 'society', label: 'Crimes against society' },
      { id: 'other', label: 'Other' }
    ];
    for (const g of groups) {
      const cats = CFG.CRIME.categories.filter(c => c.group === g.id);
      if (!cats.length) continue;
      const gcb = U.el('input', { type: 'checkbox', id: 'crime-group-' + g.id });
      const header = U.el('label', { class: 'check-group', for: 'crime-group-' + g.id }, [
        gcb,
        U.el('span', { class: 'cat-dot', style: 'background:' + U.theme.colors().crimeGroups[g.id] }),
        U.el('strong', { text: g.label })
      ]);
      catList.appendChild(header);
      const syncGroupBox = () => {
        const ons = cats.map(c => state.catOn.get(c.id));
        gcb.checked = ons.every(Boolean);
        gcb.indeterminate = !gcb.checked && ons.some(Boolean);
      };
      gcb.addEventListener('change', () => {
        for (const c of cats) {
          state.catOn.set(c.id, gcb.checked);
          const cb = document.getElementById('crime-cat-' + c.id);
          if (cb) cb.checked = gcb.checked;
        }
        renderIncidents();
      });
      for (const c of cats) {
        const cb = U.el('input', { type: 'checkbox', id: 'crime-cat-' + c.id });
        cb.checked = state.catOn.get(c.id);
        cb.addEventListener('change', () => { state.catOn.set(c.id, cb.checked); syncGroupBox(); renderIncidents(); });
        catList.appendChild(U.el('label', { for: 'crime-cat-' + c.id, class: 'check-item sub' }, [
          cb, U.el('span', { text: c.label }),
          U.el('span', { class: 'cat-count', id: 'crime-count-' + c.id, text: '' })
        ]));
      }
      syncGroupBox();
    }

    const totalLine = U.el('div', { class: 'crime-total' });
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    const note = U.el('div', { class: 'hint', text: 'Incident reports as published by each police department. Compare within a city, not across cities — reporting practices differ.' });
    body.append(cityRow, controls, catList, totalLine, status, note);

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    function updateCityChips() {
      for (const [cid, city] of state.cities) {
        const chip = document.getElementById('crime-city-' + cid);
        if (!chip) continue;
        chip.classList.toggle('off', !city.on);
        const dot = chip.querySelector('.chip-dot');
        dot.className = 'chip-dot ' + city.status;
        chip.querySelector('.chip-count').textContent =
          city.status === 'ok' ? city.incidents.length.toLocaleString() + (city.truncated ? '+' : '')
          : city.status === 'busy' ? '…' : city.status === 'err' ? 'unavailable' : '';
        chip.title = city.cfg.note + (city.error ? ' — ' + city.error : '');
      }
    }

    // ---- adapters -------------------------------------------------------
    function sinceDate() {
      const d = new Date(Date.now() - state.range * 86400000);
      return d;
    }
    function isoDay(d) { return d.toISOString().slice(0, 10); }

    // Column names are resolved against the dataset's live metadata so the
    // adapter survives SPD's periodic schema changes; known schemas are the
    // fallback when metadata cannot be fetched.
    async function resolveSocrataSchemas(city) {
      if (city.schemas) return city.schemas;
      const cands = city.cfg.fieldCandidates;
      try {
        const cols = new Set(await U.socrataColumns(city.cfg.domains, city.cfg.dataset));
        const pick = names => names.find(n => cols.has(n)) || null;
        const live = {
          date: pick(cands.date), lat: pick(cands.lat), lon: pick(cands.lon),
          addr: pick(cands.addr), area: pick(cands.area),
          offense: cands.offense.filter(n => cols.has(n)).slice(0, 4)
        };
        if (live.date && live.lat && live.lon && live.offense.length) {
          city.schemas = [live];
          return city.schemas;
        }
      } catch (e) { /* metadata unavailable — fall back to known schemas */ }
      city.schemas = city.cfg.schemas;
      return city.schemas;
    }

    async function fetchSeattle(city) {
      const schemas = await resolveSocrataSchemas(city);
      const since = isoDay(sinceDate());
      let res = null, f = null, lastErr = null;
      for (const schema of schemas) {
        try {
          res = await U.socrataQuery(city.cfg.domains, city.cfg.dataset, {
            $select: [schema.date, ...schema.offense, schema.lat, schema.lon, schema.addr, schema.area].filter(Boolean).join(','),
            $where: `${schema.date} >= '${since}'`,
            $order: `${schema.date} DESC`
          }, { maxRows: CFG.CRIME.maxPerCity });
          f = schema;
          break;
        } catch (err) { lastErr = err; }
      }
      if (!res) throw lastErr || new Error('query failed');
      city.schemas = [f]; // remember the schema that worked
      const incidents = [];
      let noCoords = 0;
      for (const r of res.rows) {
        const lat = parseFloat(r[f.lat]), lon = parseFloat(r[f.lon]);
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) < 1) { noCoords++; continue; }
        const texts = f.offense.map(k => r[k]).filter(Boolean);
        const cat = classify(texts.join('||'));
        incidents.push({
          lat, lon, catId: cat.id, group: cat.group,
          offense: texts[0] || 'Offense',
          date: r[f.date] ? new Date(r[f.date]) : null,
          addr: (f.addr && r[f.addr]) || (f.area && r[f.area]) || '', cityId: city.cfg.id
        });
      }
      return { incidents, truncated: res.truncated, noCoords };
    }

    async function resolveArcgisCity(city) {
      if (city.resolved) return city.resolved;
      const cfg = city.cfg;
      let layerUrls = [];
      if (cfg.type === 'arcgis-item') {
        const item = await U.fetchJSON(`${cfg.portal}/sharing/rest/content/items/${cfg.itemId}?f=json`, { timeout: 20000 });
        if (!item.url) throw new Error('item has no service URL');
        const svcUrl = item.url.replace(/\/+$/, '');
        if (/\/\d+$/.test(svcUrl)) layerUrls = [svcUrl];
        else {
          const info = await U.arcgis.serviceInfo(svcUrl);
          layerUrls = (info.layers || []).map(l => `${svcUrl}/${l.id}`);
        }
      } else {
        const info = await U.arcgis.serviceInfo(cfg.service);
        // Era-named layers (e.g. "2025 Smith"): newest first.
        const layers = (info.layers || []).slice().sort((a, b) => {
          const ya = (String(a.name).match(/(\d{4})/) || [0, 0])[1];
          const yb = (String(b.name).match(/(\d{4})/) || [0, 0])[1];
          return (+yb) - (+ya);
        });
        layerUrls = layers.map(l => `${cfg.service}/${l.id}`);
      }
      const resolved = [];
      for (const url of layerUrls.slice(0, 4)) {
        try {
          const info = await U.arcgis.layerInfo(url);
          if (info.type && !/feature/i.test(info.type)) continue;
          const fields = info.fields || [];
          const dateFields = fields.filter(fd => fd.type === 'esriFieldTypeDate');
          const dateField = (dateFields.find(fd => /occur|offense|start|incident/i.test(fd.name)) ||
            dateFields.find(fd => /report|date/i.test(fd.name)) || dateFields[0] || {}).name || null;
          const offenseFields = fields.filter(fd =>
            fd.type === 'esriFieldTypeString' && /offen|crime|nibrs|categor|descr|type/i.test(fd.name)
          ).map(fd => fd.name).slice(0, 4);
          const addrField = (fields.find(fd =>
            fd.type === 'esriFieldTypeString' && /address|block|intersect|location/i.test(fd.name)) || {}).name || null;
          resolved.push({
            url, dateField, offenseFields, addrField,
            pageSize: Math.min(2000, info.maxRecordCount || 2000)
          });
        } catch (e) { /* skip unreadable layer */ }
      }
      if (!resolved.length) throw new Error('no queryable layers');
      city.resolved = resolved;
      return resolved;
    }

    async function fetchArcgisCity(city) {
      const layers = await resolveArcgisCity(city);
      const since = sinceDate();
      const incidents = [];
      let truncated = false, noCoords = 0;
      for (const lyr of layers) {
        if (incidents.length >= CFG.CRIME.maxPerCity) { truncated = true; break; }
        const params = { outFields: '*', geometryPrecision: 6 };
        if (lyr.dateField) {
          params.where = `${lyr.dateField} >= TIMESTAMP '${isoDay(since)} 00:00:00'`;
          params.orderByFields = `${lyr.dateField} DESC`;
        } else {
          params.where = '1=1';
        }
        let fc;
        try {
          fc = await U.arcgis.query(lyr.url, params, {
            pageSize: lyr.pageSize, maxFeatures: CFG.CRIME.maxPerCity - incidents.length
          });
        } catch (e) {
          if (!lyr.dateField) throw e;
          // Some servers reject TIMESTAMP syntax — retry with DATE.
          params.where = `${lyr.dateField} >= DATE '${isoDay(since)}'`;
          fc = await U.arcgis.query(lyr.url, params, {
            pageSize: lyr.pageSize, maxFeatures: CFG.CRIME.maxPerCity - incidents.length
          });
        }
        for (const f of fc.features) {
          if (!f.geometry || f.geometry.type !== 'Point') { noCoords++; continue; }
          const [lon, lat] = f.geometry.coordinates;
          if (!isFinite(lat) || Math.abs(lat) < 1) { noCoords++; continue; }
          const p = f.properties || {};
          const text = lyr.offenseFields.map(k => p[k]).filter(Boolean).join('||');
          if (lyr.dateField && p[lyr.dateField] != null) {
            const t = typeof p[lyr.dateField] === 'number' ? p[lyr.dateField] : Date.parse(p[lyr.dateField]);
            if (isFinite(t) && t < since.getTime()) continue; // belt & braces if where was ignored
          }
          const cat = classify(text);
          incidents.push({
            lat, lon, catId: cat.id, group: cat.group,
            offense: (lyr.offenseFields.map(k => p[k]).find(Boolean)) || 'Offense',
            date: lyr.dateField && p[lyr.dateField] != null
              ? new Date(typeof p[lyr.dateField] === 'number' ? p[lyr.dateField] : Date.parse(p[lyr.dateField]))
              : null,
            addr: (lyr.addrField && p[lyr.addrField]) || '', cityId: city.cfg.id
          });
        }
      }
      if (incidents.length >= CFG.CRIME.maxPerCity) truncated = true;
      return { incidents, truncated, noCoords };
    }

    async function fetchCity(cid) {
      const city = state.cities.get(cid);
      if (!city || city.status === 'busy') return;
      city.status = 'busy';
      city.error = null;
      updateCityChips();
      try {
        const res = city.cfg.type === 'socrata' ? await fetchSeattle(city) : await fetchArcgisCity(city);
        city.incidents = res.incidents;
        city.truncated = res.truncated;
        city.noCoords = res.noCoords;
        city.status = 'ok';
      } catch (err) {
        city.status = 'err';
        city.error = err.message;
        city.incidents = [];
      }
      updateCityChips();
      renderIncidents();
      updateStatusLine();
    }

    function updateStatusLine() {
      const parts = [];
      let anyBusy = false, truncated = [];
      for (const [, city] of state.cities) {
        if (!city.on) continue;
        if (city.status === 'busy') anyBusy = true;
        if (city.status === 'ok' && city.truncated) truncated.push(city.cfg.label);
      }
      if (anyBusy) { setStatus('Loading incidents…', 'busy'); return; }
      const errs = Array.from(state.cities.values()).filter(c => c.on && c.status === 'err');
      if (errs.length) parts.push(errs.map(c => c.cfg.label + ' unavailable').join(', '));
      if (truncated.length) parts.push('capped at ' + CFG.CRIME.maxPerCity.toLocaleString() + ' newest for ' + truncated.join(', '));
      const noC = Array.from(state.cities.values()).reduce((a, c) => a + (c.on ? c.noCoords : 0), 0);
      if (noC) parts.push(noC.toLocaleString() + ' records without coordinates excluded');
      setStatus(parts.length ? parts.join(' · ') : 'Loaded', errs.length ? 'err' : 'ok');
    }

    // ---- rendering ------------------------------------------------------
    function activeIncidents() {
      const out = [];
      for (const [, city] of state.cities) {
        if (!city.on || city.status !== 'ok') continue;
        for (const inc of city.incidents) if (state.catOn.get(inc.catId)) out.push(inc);
      }
      return out;
    }
    function incidentPopup(inc) {
      const city = state.cities.get(inc.cityId);
      const cat = CAT_BY_ID[inc.catId];
      return `<div class="popup-poi"><h3>${U.escapeHTML(inc.offense)}</h3>
        <div class="popup-cat"><span class="cat-dot" style="background:${U.theme.colors().crimeGroups[inc.group]}"></span>
        ${U.escapeHTML(cat.label)}</div>
        ${inc.date ? `<div>${U.escapeHTML(inc.date.toLocaleString())}</div>` : ''}
        ${inc.addr ? `<div>${U.escapeHTML(inc.addr)}</div>` : ''}
        <div class="popup-src">Source: <a href="${city.cfg.link}" target="_blank" rel="noopener">${U.escapeHTML(city.cfg.label)} open data</a></div></div>`;
    }
    function renderIncidents() {
      if (!state.enabled) return;
      const incidents = activeIncidents();
      cluster.clearLayers();
      if (heat) { map.removeLayer(heat); heat = null; }
      if (state.mode === 'clusters') {
        if (!map.hasLayer(cluster)) map.addLayer(cluster);
        const markers = incidents.map(inc =>
          L.marker([inc.lat, inc.lon], {
            icon: L.divIcon({
              className: 'poi-icon',
              html: `<span class="crime-dot" style="background:${U.theme.colors().crimeGroups[inc.group]}"></span>`,
              iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6]
            })
          }).bindPopup(incidentPopup(inc), { maxWidth: 300 }));
        cluster.addLayers(markers);
      } else {
        if (map.hasLayer(cluster)) map.removeLayer(cluster);
        heat = L.heatLayer(incidents.map(i => [i.lat, i.lon, 0.7]), {
          radius: 22, blur: 18, maxZoom: 17, gradient: CFG.PALETTE.heatGradient
        }).addTo(map);
      }
      updateViewCounts();
    }
    function updateViewCounts() {
      if (!state.enabled) return;
      const bounds = map.getBounds();
      const counts = {};
      let total = 0;
      for (const inc of activeIncidents()) {
        if (bounds.contains([inc.lat, inc.lon])) {
          counts[inc.catId] = (counts[inc.catId] || 0) + 1;
          total++;
        }
      }
      for (const c of CFG.CRIME.categories) {
        const elc = document.getElementById('crime-count-' + c.id);
        if (elc) elc.textContent = counts[c.id] ? counts[c.id].toLocaleString() : '';
      }
      totalLine.textContent = total.toLocaleString() + ' incidents in view · last ' + state.range + ' days';
    }

    // ---- events ---------------------------------------------------------
    rangeSel.addEventListener('change', () => {
      state.range = +rangeSel.value;
      for (const [cid, city] of state.cities) {
        city.status = 'idle'; // stale for the new range even while the layer is off
        if (state.enabled && city.on) fetchCity(cid);
      }
      if (state.enabled) renderIncidents();
    });
    modeSel.addEventListener('change', () => { state.mode = modeSel.value; renderIncidents(); });
    map.on('moveend', U.debounce(() => updateViewCounts(), 350));
    U.theme.onChange(() => { if (state.enabled) renderIncidents(); });

    return {
      id: 'crime',
      get enabled() { return state.enabled; },
      setEnabled(on) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          for (const [cid, city] of state.cities) {
            if (city.on && city.status === 'idle') fetchCity(cid);
          }
          renderIncidents();
          updateStatusLine();
        } else {
          cluster.clearLayers();
          if (map.hasLayer(cluster)) map.removeLayer(cluster);
          if (heat) { map.removeLayer(heat); heat = null; }
          setStatus('Off');
        }
      }
    };
  };
})();

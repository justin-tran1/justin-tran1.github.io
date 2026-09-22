/* Washington Explorer — amenities layer.
 * Schools/colleges come from NCES EDGE point services (authoritative federal
 * school locations, newest school year auto-selected); commercial amenities
 * come from OpenStreetMap via Overpass, fetched live for the current view.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  WAMAP.createAmenities = function (opts) {
    const { map, card } = opts;
    const cluster = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 46, disableClusteringAtZoom: 17,
      spiderfyOnMaxZoom: true, showCoverageOnHover: false
    });

    const state = {
      enabled: false,
      cats: new Map(), // id -> {cfg, on, markers: Map(uid->marker), fetched: [LatLngBounds], busy, note}
      nces: { resolved: null, promise: null, failed: false }
    };
    for (const c of CFG.AMENITIES) {
      state.cats.set(c.id, { cfg: c, on: ['schools', 'grocery', 'health'].includes(c.id), markers: new Map(), fetched: [], busy: false, note: '' });
    }

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const list = U.el('div', { class: 'check-list' });
    for (const [cid, cat] of state.cats) {
      const cb = U.el('input', { type: 'checkbox', id: 'amen-' + cid });
      cb.checked = cat.on;
      cb.addEventListener('change', () => { cat.on = cb.checked; syncCategory(cid); refresh(); });
      const label = U.el('label', { for: 'amen-' + cid, class: 'check-item' }, [
        cb,
        U.el('span', { class: 'cat-dot', style: 'background:' + CFG.PALETTE.amenities[cat.cfg.colorToken] }),
        U.el('span', { text: cat.cfg.emoji + ' ' + cat.cfg.label }),
        U.el('span', { class: 'cat-count', id: 'amen-count-' + cid, text: '' })
      ]);
      list.appendChild(label);
    }
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    const hint = U.el('div', { class: 'hint' });
    body.append(list, hint, status);

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    function updateCounts() {
      for (const [cid, cat] of state.cats) {
        const elc = document.getElementById('amen-count-' + cid);
        if (elc) elc.textContent = cat.markers.size ? '· ' + cat.markers.size.toLocaleString() : '';
      }
    }

    // ---- markers --------------------------------------------------------
    function makeIcon(cat) {
      return L.divIcon({
        className: 'poi-icon',
        html: `<span class="poi-chip" style="border-color:${CFG.PALETTE.amenities[cat.cfg.colorToken]}">${cat.cfg.emoji}</span>`,
        iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -12]
      });
    }
    function osmPopup(cat, tags, elType, elId) {
      const name = tags.name || tags.brand || '(unnamed ' + cat.cfg.label.toLowerCase() + ')';
      const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
      const addr2 = [tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(' ');
      const rows = [];
      if (addr || addr2) rows.push(`<div>${U.escapeHTML([addr, addr2].filter(Boolean).join(', '))}</div>`);
      if (tags.opening_hours) rows.push(`<div>🕒 ${U.escapeHTML(tags.opening_hours)}</div>`);
      if (tags.phone || tags['contact:phone']) rows.push(`<div>📞 ${U.escapeHTML(tags.phone || tags['contact:phone'])}</div>`);
      const site = tags.website || tags['contact:website'];
      if (site && /^https?:\/\//i.test(site)) rows.push(`<div>🔗 <a href="${U.escapeHTML(site)}" target="_blank" rel="noopener">website</a></div>`);
      if (tags.cuisine) rows.push(`<div>Cuisine: ${U.escapeHTML(tags.cuisine.replace(/_/g, ' '))}</div>`);
      return `<div class="popup-poi"><h3>${U.escapeHTML(name)}</h3>
        <div class="popup-cat">${cat.cfg.emoji} ${U.escapeHTML(cat.cfg.label)}</div>${rows.join('')}
        <div class="popup-src">Source: <a href="https://www.openstreetmap.org/${elType}/${elId}" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div></div>`;
    }
    function ncesPopup(cat, p, kindLabel, yearLabel) {
      const pick = names => { for (const n of names) { if (p[n] != null && p[n] !== '' && String(p[n]).toUpperCase() !== 'NULL') return p[n]; } return null; };
      const name = pick(['NAME', 'SCH_NAME', 'INSTNM', 'name']) || '(school)';
      const street = pick(['STREET', 'LSTREET', 'LSTREET1', 'ADDRESS']) || '';
      const city = pick(['CITY', 'LCITY']) || '';
      const zip = pick(['ZIP', 'LZIP']) || '';
      return `<div class="popup-poi"><h3>${U.escapeHTML(name)}</h3>
        <div class="popup-cat">${cat.cfg.emoji} ${U.escapeHTML(kindLabel)}</div>
        ${street || city ? `<div>${U.escapeHTML([street, city, zip].filter(Boolean).join(', '))}</div>` : ''}
        <div class="popup-src">Source: NCES EDGE school locations${yearLabel ? ' (' + U.escapeHTML(yearLabel) + ')' : ''}</div></div>`;
    }
    function addMarker(cat, uid, lat, lon, popupHTML) {
      if (cat.markers.has(uid)) return;
      const m = L.marker([lat, lon], { icon: makeIcon(cat) }).bindPopup(popupHTML, { maxWidth: 300 });
      cat.markers.set(uid, m);
      if (state.enabled && cat.on) cluster.addLayer(m);
    }
    function syncCategory(cid) {
      const cat = state.cats.get(cid);
      const ms = Array.from(cat.markers.values());
      if (state.enabled && cat.on) cluster.addLayers(ms);
      else cluster.removeLayers(ms);
    }

    // ---- NCES -----------------------------------------------------------
    async function resolveNCES() {
      if (state.nces.resolved) return state.nces.resolved;
      if (state.nces.promise) return state.nces.promise;
      state.nces.promise = (async () => {
        const out = { k12: [], postsecondary: [] };
        const folderK12 = await U.fetchJSON(CFG.NCES.k12Folder + '?f=json', { timeout: 20000 });
        const names = (folderK12.services || []).map(s => s.name.split('/').pop());
        for (const kind of ['PUBLICSCH', 'PRIVATESCH']) {
          const matches = names.map(n => { const m = n.match(CFG.NCES.k12Match); return m && m[1].toUpperCase() === kind ? { n, yr: +m[2] } : null; })
            .filter(Boolean).sort((a, b) => b.yr - a.yr);
          if (matches.length) out.k12.push({
            url: `${CFG.NCES.k12Folder}/${matches[0].n}/MapServer/0`,
            label: (kind === 'PUBLICSCH' ? 'Public school' : 'Private school'),
            year: String(matches[0].yr)
          });
        }
        try {
          const folderPost = await U.fetchJSON(CFG.NCES.postsecFolder + '?f=json', { timeout: 20000 });
          const pNames = (folderPost.services || []).map(s => s.name.split('/').pop());
          const pm = pNames.map(n => { const m = n.match(CFG.NCES.postsecMatch); return m ? { n, yr: +m[1] } : null; })
            .filter(Boolean).sort((a, b) => b.yr - a.yr);
          if (pm.length) out.postsecondary.push({
            url: `${CFG.NCES.postsecFolder}/${pm[0].n}/MapServer/0`,
            label: 'College / university', year: String(pm[0].yr)
          });
        } catch (e) { /* postsecondary folder optional */ }
        if (!out.k12.length && !out.postsecondary.length) throw new Error('no NCES services found');
        state.nces.resolved = out;
        return out;
      })();
      state.nces.promise.catch(() => { state.nces.promise = null; state.nces.failed = true; });
      return state.nces.promise;
    }
    async function fetchNCES(cat, bounds) {
      const resolved = await resolveNCES();
      const services = resolved[cat.cfg.ncesKind] || [];
      if (!services.length) throw new Error('no NCES service');
      for (const svc of services) {
        const fc = await U.arcgis.query(svc.url, Object.assign({
          outFields: '*', geometryPrecision: 6
        }, U.arcgis.envelope(bounds)), { pageSize: 1000, maxFeatures: cat.cfg.cap });
        for (const f of fc.features) {
          if (!f.geometry || f.geometry.type !== 'Point') continue;
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties || {};
          const uid = 'nces:' + (p.NCESSCH || p.PPIN || p.UNITID || p.OBJECTID || (svc.url + ':' + lon + ',' + lat));
          addMarker(cat, uid, lat, lon, ncesPopup(cat, p, svc.label, svc.year));
        }
      }
      cat.note = 'NCES';
    }

    // ---- OSM ------------------------------------------------------------
    async function fetchOSM(cat, bounds) {
      const bbox = U.overpass.bbox(bounds);
      const parts = cat.cfg.osm.map(sel => `nwr${sel}(${bbox});`).join('');
      const ql = `[out:json][timeout:${CFG.OVERPASS.timeoutS}];(${parts});out center ${cat.cfg.cap};`;
      const data = await U.overpass.run(ql);
      let n = 0;
      for (const elm of (data.elements || [])) {
        const lat = elm.lat != null ? elm.lat : (elm.center && elm.center.lat);
        const lon = elm.lon != null ? elm.lon : (elm.center && elm.center.lon);
        if (lat == null) continue;
        addMarker(cat, 'osm:' + elm.type + '/' + elm.id, lat, lon, osmPopup(cat, elm.tags || {}, elm.type, elm.id));
        n++;
      }
      if (n >= cat.cfg.cap) cat.note = 'capped at ' + cat.cfg.cap + ' per fetch';
    }

    // ---- orchestration --------------------------------------------------
    function isCovered(cat, bounds) {
      return cat.fetched.some(b => b.contains(bounds));
    }
    let fetchToken = 0;
    async function refresh() {
      if (!state.enabled) return;
      const token = ++fetchToken;
      const zoom = map.getZoom();
      const bounds = map.getBounds().pad(0.15);
      const gated = [];
      const jobs = [];
      for (const [, cat] of state.cats) {
        if (!cat.on) continue;
        if (zoom < cat.cfg.minZoom) { gated.push(cat.cfg.label + ' (z' + cat.cfg.minZoom + '+)'); continue; }
        if (isCovered(cat, bounds) || cat.busy) continue;
        cat.busy = true;
        const useNCES = cat.cfg.source === 'nces' && !state.nces.failed;
        const job = (useNCES ? fetchNCES(cat, bounds) : fetchOSM(cat, bounds))
          .catch(async err => {
            if (cat.cfg.source === 'nces') { // authoritative source down -> OSM fallback
              state.nces.failed = true;
              cat.note = 'NCES unreachable — OpenStreetMap fallback';
              try { await fetchOSM(cat, bounds); return; } catch (e2) { err = e2; }
            }
            throw err;
          })
          .then(() => { cat.fetched.push(bounds); })
          .finally(() => { cat.busy = false; });
        jobs.push(job.catch(err => ({ err, cat })));
      }
      hint.textContent = gated.length ? 'Zoom in to load: ' + gated.join(', ') : '';
      if (!jobs.length) { updateCounts(); if (!gated.length) setStatus(totalLabel(), 'ok'); return; }
      setStatus('Loading places…', 'busy');
      const results = await Promise.all(jobs);
      if (token !== fetchToken || !state.enabled) return;
      updateCounts();
      const errs = results.filter(r => r && r.err);
      if (errs.length) setStatus('Some categories failed: ' + errs.map(e => e.cat.cfg.label).join(', '), 'err');
      else setStatus(totalLabel(), 'ok');
    }
    function totalLabel() {
      let total = 0;
      for (const [, cat] of state.cats) if (cat.on) total += cat.markers.size;
      const notes = new Set();
      for (const [, cat] of state.cats) if (cat.on && cat.note && cat.note !== 'NCES') notes.add(cat.note);
      return total.toLocaleString() + ' places loaded' + (notes.size ? ' · ' + Array.from(notes).join(' · ') : '');
    }

    const onMove = U.debounce(() => refresh(), 650);
    map.on('moveend', onMove);

    return {
      id: 'amenities',
      get enabled() { return state.enabled; },
      setEnabled(on) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          map.addLayer(cluster);
          for (const [cid] of state.cats) syncCategory(cid);
          refresh();
        } else {
          fetchToken++;
          map.removeLayer(cluster);
          setStatus('Off');
          hint.textContent = '';
        }
      }
    };
  };
})();

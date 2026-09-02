/* Washington Explorer — area (choropleth) layer engine.
 * One engine powers both the Demographics and Health-insurance layers:
 * county polygons statewide, census tracts once zoomed in, ACS values joined
 * from the shared census store, quantile bins with a stable statewide legend.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  // ------------------------------------------------------ shared geo store
  const geoStore = {
    counties: null, countiesSource: null, countiesPromise: null,
    tractCache: new Map(), // GEOID -> GeoJSON feature
    tractIndex: null, tractIndexPromise: null, // statewide centroids + land area

    async loadCounties() {
      if (this.counties) return this.counties;
      if (this.countiesPromise) return this.countiesPromise;
      this.countiesPromise = (async () => {
        try {
          const fc = await U.tigerweb.counties();
          if (!fc.features.length) throw new Error('empty');
          this.countiesSource = 'tigerweb';
          this.counties = fc;
        } catch (e) {
          const fc = await U.fetchJSON(CFG.TIGERWEB.localCounties, { timeout: 15000 });
          this.countiesSource = 'bundled';
          this.counties = fc;
        }
        return this.counties;
      })();
      this.countiesPromise.catch(() => { this.countiesPromise = null; });
      return this.countiesPromise;
    },

    async loadTractsInView(map) {
      const bounds = map.getBounds().pad(0.25);
      const fc = await U.tigerweb.tractsInView(bounds);
      for (const f of fc.features) {
        if (f.properties && f.properties.GEOID && !this.tractCache.has(f.properties.GEOID)) {
          this.tractCache.set(f.properties.GEOID, f);
        }
      }
      return this.tractCache;
    },

    /** Statewide tract centroids + land areas (one light request, reused by
     *  density binning and the drive-time analytics). */
    async loadTractIndex() {
      if (this.tractIndex) return this.tractIndex;
      if (this.tractIndexPromise) return this.tractIndexPromise;
      const wa = CFG.MAP.waBounds;
      const bounds = L.latLngBounds([wa.south, wa.west], [wa.north, wa.east]);
      this.tractIndexPromise = U.tigerweb.tractCentroidsInEnvelope(bounds).then(pts => {
        this.tractIndex = pts;
        return pts;
      });
      this.tractIndexPromise.catch(() => { this.tractIndexPromise = null; });
      return this.tractIndexPromise;
    },
    alandOf(geoid) {
      if (this.tractCache.has(geoid)) return this.tractCache.get(geoid).properties.AREALAND;
      if (this.tractIndex) {
        const hit = this.tractIndex.find(p => p.geoid === geoid);
        if (hit) return hit.aland;
      }
      return null;
    }
  };
  WAMAP.geoStore = geoStore;

  // ------------------------------------------- single-active-layer control
  const coordinator = {
    instances: [],
    register(inst) { this.instances.push(inst); },
    activate(inst) {
      for (const other of this.instances) {
        if (other !== inst && other.enabled) {
          other.setEnabled(false, true);
          if (other.onForcedOff) other.onForcedOff();
        }
      }
    }
  };
  WAMAP.areaLayerCoordinator = coordinator;

  // --------------------------------------------------------------- engine
  WAMAP.createChoropleth = function (opts) {
    const { id, metrics, ramp, map, card } = opts;
    const NO_DATA = '#d7d6cf';
    const renderer = L.canvas({ padding: 0.3 });

    const state = {
      enabled: false,
      metric: metrics[0],
      opacity: 0.72,
      level: null,        // 'county' | 'tract'
      layer: null,
      breaksCache: {},    // `${level}:${metric.id}` -> {breaks,min,max}
      lastError: null
    };

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const metricSel = U.el('select', { class: 'input', 'aria-label': 'Metric' },
      metrics.map(m => U.el('option', { value: m.id, text: m.label })));
    const desc = U.el('div', { class: 'hint' });
    const opacityRow = U.el('div', { class: 'row-inline' }, [
      U.el('label', { class: 'mini-label', text: 'Opacity' }),
      U.el('input', { type: 'range', min: '20', max: '95', value: '72', class: 'slider', 'aria-label': 'Layer opacity' })
    ]);
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    body.append(metricSel, desc, opacityRow, status);
    const opacityInput = opacityRow.querySelector('input');

    const legendBox = U.el('div', { class: 'legend-block', 'data-layer': id });
    WAMAP.legendHost.appendChild(legendBox);
    legendBox.style.display = 'none';

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    function updateDesc() { desc.textContent = state.metric.desc || ''; }
    updateDesc();

    // ---- data helpers ---------------------------------------------------
    function levelForZoom() { return map.getZoom() >= CFG.MAP.tractZoom ? 'tract' : 'county'; }

    function valueFor(geoid, acs, feature) {
      const row = acs.rows[geoid];
      if (!row) return null;
      if (state.metric.needsArea) {
        const aland = feature && feature.properties.AREALAND != null
          ? feature.properties.AREALAND : geoStore.alandOf(geoid);
        if (aland == null) return null;
        return state.metric.value(Object.assign({}, row, { aland }));
      }
      return state.metric.value(row);
    }

    async function computeBreaks(level, acs) {
      const key = level + ':' + state.metric.id + ':' + acs.vintage;
      if (state.breaksCache[key]) return state.breaksCache[key];
      let values;
      if (state.metric.needsArea) {
        if (level === 'county') {
          const fc = await geoStore.loadCounties();
          values = fc.features.map(f => {
            const geoid = f.properties.GEOID;
            const aland = f.properties.AREALAND;
            const row = acs.rows[geoid];
            return (row && aland > 0) ? state.metric.value(Object.assign({}, row, { aland })) : null;
          });
        } else {
          const idx = await geoStore.loadTractIndex().catch(() => null);
          if (idx) {
            values = idx.map(p => {
              const row = acs.rows[p.geoid];
              return (row && p.aland > 0) ? state.metric.value(Object.assign({}, row, { aland: p.aland })) : null;
            });
          } else { // fall back to whatever tracts are cached
            values = Array.from(geoStore.tractCache.values()).map(f =>
              valueFor(f.properties.GEOID, acs, f));
          }
        }
      } else {
        values = Object.values(acs.rows).map(r => state.metric.value(r));
      }
      const q = U.geo.quantileBreaks(values, ramp.length);
      state.breaksCache[key] = q;
      return q;
    }

    function colorFor(v, q) {
      if (v == null || !q) return NO_DATA;
      return ramp[Math.min(U.geo.binIndex(v, q.breaks), ramp.length - 1)];
    }

    // ---- rendering ------------------------------------------------------
    let renderToken = 0;
    async function render() {
      if (!state.enabled) return;
      const token = ++renderToken;
      const level = levelForZoom();
      try {
        setStatus('Loading ' + (level === 'tract' ? 'census tracts' : 'counties') + '…', 'busy');
        const acs = await U.censusStore.load(level);
        let features;
        if (level === 'county') {
          const fc = await geoStore.loadCounties();
          features = fc.features;
        } else {
          await geoStore.loadTractsInView(map);
          if (state.metric.needsArea) await geoStore.loadTractIndex().catch(() => {});
          features = Array.from(geoStore.tractCache.values());
        }
        if (token !== renderToken || !state.enabled) return;
        const q = await computeBreaks(level, acs);
        if (token !== renderToken || !state.enabled) return;

        if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
        state.level = level;
        state.layer = L.geoJSON({ type: 'FeatureCollection', features }, {
          renderer,
          style: f => {
            const v = valueFor(f.properties.GEOID, acs, f);
            return {
              fillColor: colorFor(v, q), fillOpacity: state.opacity,
              color: '#ffffff', weight: level === 'county' ? 1.2 : 0.7, opacity: 0.9
            };
          },
          onEachFeature: (f, lyr) => {
            const geoid = f.properties.GEOID;
            lyr.on('mouseover', () => {
              lyr.setStyle({ weight: 2.5, color: '#0b0b0b' });
              if (lyr.bringToFront) lyr.bringToFront();
            });
            lyr.on('mouseout', () => state.layer && state.layer.resetStyle(lyr));
            const row = acs.rows[geoid];
            const v = valueFor(geoid, acs, f);
            const name = (row && row.name ? row.name.split(';')[0] : f.properties.NAME) || geoid;
            lyr.bindTooltip(
              `<strong>${U.escapeHTML(name)}</strong><br>${U.escapeHTML(state.metric.label)}: ${U.fmt.by(state.metric.fmt, v)}`,
              { sticky: true, direction: 'top', opacity: 0.95 });
            lyr.on('click', e => {
              L.popup({ maxWidth: 340 })
                .setLatLng(e.latlng)
                .setContent(profileHTML(geoid, f, acs))
                .openOn(map);
            });
          }
        }).addTo(map);
        state.layer.bringToBack();
        renderLegend(q, acs, level);
        const n = features.length;
        setStatus(`ACS 5-Year ${acs.span} · ${n.toLocaleString()} ${level === 'tract' ? 'tracts loaded' : 'counties'}`
          + (level === 'county' && geoStore.countiesSource === 'bundled' ? ' (bundled boundaries)' : ''), 'ok');
        state.lastError = null;
      } catch (err) {
        if (token !== renderToken) return;
        state.lastError = err;
        setStatus('Could not load data: ' + err.message, 'err');
        WAMAP.toast('Area data unavailable right now (' + err.message + ')', 'critical');
      }
    }

    function profileHTML(geoid, feature, acs) {
      const row = acs.rows[geoid] || null;
      const name = (row && row.name ? row.name : (feature.properties.NAME || geoid));
      const aland = feature.properties.AREALAND != null ? feature.properties.AREALAND : geoStore.alandOf(geoid);
      const withArea = row ? Object.assign({}, row, { aland }) : null;
      const lines = [];
      const push = (label, val) => lines.push(
        `<tr><td>${U.escapeHTML(label)}</td><td class="num">${val}</td></tr>`);
      if (withArea) {
        for (const m of CFG.DEMO_METRICS) push(m.label, U.fmt.by(m.fmt, m.value(withArea)));
        push('Per-capita income', U.fmt.money(withArea.perCap));
        push('Households', U.fmt.int(withArea.households));
        for (const m of CFG.INSURANCE_METRICS) push(m.label, U.fmt.by(m.fmt, m.value(withArea)));
        if (aland > 0) push('Land area', U.fmt.sqmi(aland * CFG.SQMI_PER_SQM));
      } else {
        lines.push('<tr><td colspan="2">No ACS data for this area.</td></tr>');
      }
      return `<div class="popup-profile"><h3>${U.escapeHTML(name)}</h3>
        <table>${lines.join('')}</table>
        <div class="popup-src">ACS 5-Year ${acs.span} · GEOID ${U.escapeHTML(geoid)} · estimates carry margins of error</div></div>`;
    }

    function renderLegend(q, acs, level) {
      if (!q) { legendBox.style.display = 'none'; return; }
      const f = v => U.fmt.by(state.metric.fmt, v);
      const stops = [q.min, ...q.breaks, q.max];
      const rows = ramp.map((c, i) =>
        `<div class="legend-row"><span class="swatch" style="background:${c}"></span>` +
        `<span>${f(stops[i])} – ${f(stops[i + 1])}</span></div>`).join('');
      legendBox.innerHTML =
        `<div class="legend-title">${U.escapeHTML(state.metric.label)}</div>` +
        `<div class="legend-sub">${level === 'tract' ? 'by census tract' : 'by county'} · quintiles statewide</div>` +
        rows +
        `<div class="legend-row"><span class="swatch" style="background:${NO_DATA}"></span><span>No data</span></div>` +
        `<div class="legend-src">ACS 5-Year ${acs.span}, U.S. Census Bureau</div>`;
      legendBox.style.display = '';
    }

    // ---- events ---------------------------------------------------------
    const onMove = U.debounce(() => {
      if (!state.enabled) return;
      const level = levelForZoom();
      if (level === 'tract' || level !== state.level) render();
    }, 450);
    map.on('moveend zoomend', onMove);

    metricSel.addEventListener('change', () => {
      state.metric = metrics.find(m => m.id === metricSel.value) || metrics[0];
      updateDesc();
      if (state.enabled) render();
    });
    opacityInput.addEventListener('input', () => {
      state.opacity = opacityInput.value / 100;
      if (state.layer) state.layer.setStyle({ fillOpacity: state.opacity });
    });

    const api = {
      id,
      get enabled() { return state.enabled; },
      onForcedOff: null,
      setEnabled(on, silent) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          if (!silent) coordinator.activate(api);
          render();
        } else {
          renderToken++;
          if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
          legendBox.style.display = 'none';
          setStatus('Off');
        }
      }
    };
    coordinator.register(api);
    return api;
  };
})();

'use strict';

(() => {
  const FEED_URL = 'https://fire-api-prod.web.app/events.atom';
  const ATOM = 'http://www.w3.org/2005/Atom';
  const SVG = 'http://www.w3.org/2000/svg';
  const REFRESH_MS = 5 * 60 * 1000;
  const PAGE_ROWS = 200;
  const DAY = 864e5;
  const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };
  const RANGE_NOTES = { '24h': 'in the last 24 hours', '7d': 'in the last 7 days', '30d': 'in the last 30 days' };

  // Fixed categorical order: a type keeps its color no matter what is filtered.
  const KNOWN_TYPES = [
    ['new_fire', 'New fire'],
    ['acres', 'Acreage update'],
    ['containment', 'Containment update'],
    ['perimeter', 'Perimeter mapped'],
    ['ipaws_alert', 'IPAWS alert'],
  ];
  const typeMeta = new Map(KNOWN_TYPES.map(([key, label], i) => [key, { key, label, slot: i + 1 }]));

  const STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };
  const SLUG_TO_STATE = Object.fromEntries(Object.values(STATES).map((n) => [n.toLowerCase().replace(/\s+/g, '-'), n]));

  const $ = (id) => document.getElementById(id);
  const intFmt = new Intl.NumberFormat();
  const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const acresFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const fmtCount = (n) => (n >= 10000 ? compactFmt.format(n) : intFmt.format(n));

  // ---------- state ----------
  let stored = [];
  let live = [];
  let all = [];
  let manifest = null;
  let storedError = null;
  let liveStatus = { ok: null, at: 0 };
  let pendingCount = 0;
  let lastChart = null;
  const view = { range: 'all', types: new Set(), state: '', q: '', mode: 'chart', rows: PAGE_ROWS };

  // ---------- DOM helpers (all text goes through textContent) ----------
  function h(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid instanceof Node ? kid : String(kid));
    }
    return node;
  }
  function s(tag, attrs = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    return node;
  }
  const colorOf = (type) => {
    const slot = metaFor(type).slot;
    return slot ? `var(--s${slot})` : 'var(--other)';
  };
  function swatch(type, cls) {
    const node = h('span', { class: cls });
    node.style.background = colorOf(type);
    return node;
  }

  // ---------- parsing ----------
  function metaFor(key) {
    if (!typeMeta.has(key)) {
      const slot = typeMeta.size < 8 ? typeMeta.size + 1 : 0; // 0 folds into gray "other"
      const label = key.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
      typeMeta.set(key, { key, label, slot });
    }
    return typeMeta.get(key);
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decode(str) {
    return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        try { return String.fromCodePoint(n); } catch { return m; }
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    });
  }
  const num = (str) => {
    const n = parseFloat(String(str).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  function parseSize(str) {
    const m = /^([\d.,]+)\s*acres?(?:\s*\(was\s*([^)]*)\))?/i.exec(str || '');
    return m ? { now: num(m[1]), was: m[2] ? num(m[2]) : null } : { now: null, was: null };
  }
  function parsePct(str) {
    const m = /^([\d.]+)\s*%(?:\s*\(was\s*([\d.]+)\s*%?\))?/.exec(str || '');
    return m ? { now: num(m[1]), was: m[2] != null ? num(m[2]) : null } : { now: null, was: null };
  }
  function titleCase(str) {
    return str.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bOf\b/g, 'of');
  }
  function stateFrom(link, location) {
    const m = link && /\/fire\/([a-z-]+?)_/i.exec(link);
    if (m) {
      const slug = m[1].toLowerCase();
      return SLUG_TO_STATE[slug] || titleCase(slug.replace(/-/g, ' '));
    }
    const a = location && /,\s*([A-Z]{2})\s*$/.exec(location);
    return (a && STATES[a[1]]) || 'Unknown';
  }
  function describe(ev) {
    const f = ev.fields;
    const acres = ev.acres != null ? `${acresFmt.format(ev.acres)} acres` : null;
    switch (ev.type) {
      case 'new_fire':
        return [acres, f.location, f.cause && `Cause: ${f.cause}`].filter(Boolean).join(' · ');
      case 'acres':
      case 'perimeter':
        if (!acres) return f.size || '';
        return ev.acresWas != null ? `${acres} (was ${acresFmt.format(ev.acresWas)})` : acres;
      case 'containment':
        if (ev.contained == null) return f.containment || '';
        return `${ev.contained}% contained${ev.containedWas != null ? ` (was ${ev.containedWas}%)` : ''}`;
      default:
        return Object.entries(f)
          .filter(([k]) => k !== 'updated' && k !== 'source')
          .map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`)
          .join(' · ');
    }
  }

  // raw = {id, title, link, published, updated, category, content} — same shape from storage and the live feed.
  function normalize(raw) {
    const lines = String(raw.content || '')
      .split(/<br\s*\/?>/i)
      .map((part) => decode(part.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const fields = {};
    let lead = null;
    for (const line of lines) {
      const m = /^([A-Za-z][A-Za-z ]{0,30}):\s*(.+)$/.exec(line);
      if (m) fields[m[1].toLowerCase()] = m[2];
      else if (lead === null) lead = line;
    }
    const title = decode(String(raw.title || '')).trim();
    const name = lead || title.replace(/^[^:]*:\s*/, '') || 'Unknown';
    const link = /^https?:\/\//i.test(raw.link || '') ? raw.link : null;
    const type = raw.category || 'unknown';
    metaFor(type);
    const size = parseSize(fields.size);
    const pct = parsePct(fields.containment);
    const ev = {
      id: raw.id,
      t: Date.parse(raw.published || raw.updated) || 0,
      published: raw.published || raw.updated || '',
      type, title, name, link, fields,
      state: stateFrom(link, fields.location),
      acres: size.now, acresWas: size.was,
      contained: pct.now, containedWas: pct.was,
    };
    ev.details = describe(ev);
    ev.fireKey = link ? link.replace(/[?#].*$/, '') : `${name}|${ev.state}`;
    ev.search = `${name} ${title} ${ev.state} ${ev.details}`.toLowerCase();
    return ev;
  }

  function parseAtom(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('feed is not valid XML');
    return [...doc.getElementsByTagNameNS(ATOM, 'entry')].map((entry) => {
      const get = (tag) => entry.getElementsByTagNameNS(ATOM, tag)[0]?.textContent?.trim() || null;
      const link = [...entry.getElementsByTagNameNS(ATOM, 'link')]
        .find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
      const category = entry.getElementsByTagNameNS(ATOM, 'category')[0];
      return {
        id: get('id'), title: get('title'), link: link?.getAttribute('href') || null,
        published: get('published') || get('updated'), updated: get('updated'),
        category: category?.getAttribute('term') || null, content: get('content'),
      };
    }).filter((raw) => raw.id);
  }

  // ---------- loading ----------
  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  }
  async function loadStored() {
    try {
      const m = await getJSON('data/manifest.json');
      const files = m.months.map((x) => x.file).filter((f) => /^events\/[\w-]+\.json$/.test(f));
      const shards = await Promise.all(files.map((f) => getJSON(`data/${f}`)));
      manifest = m;
      stored = shards.flat().map(normalize);
      storedError = null;
    } catch (err) {
      storedError = err;
    }
  }
  async function loadLive() {
    try {
      const res = await fetch(FEED_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`feed returned ${res.status}`);
      live = parseAtom(await res.text()).map(normalize);
      liveStatus = { ok: true, at: Date.now() };
    } catch (err) {
      liveStatus = { ok: false, at: Date.now(), error: err };
    }
  }
  function merge() {
    const byId = new Map(stored.map((e) => [e.id, e]));
    pendingCount = 0;
    for (const e of live) {
      if (!byId.has(e.id)) pendingCount++;
      byId.set(e.id, e);
    }
    all = [...byId.values()].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
  }

  // ---------- formatting ----------
  function fmtTime(t) {
    const d = new Date(t);
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleString(undefined, opts);
  }
  const fmtDay = (t, withYear) => new Date(t).toLocaleDateString(undefined,
    withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  const fmtHour = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' });
  function ago(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  // ---------- filtering ----------
  function slices() {
    const cutoff = Date.now() - RANGES[view.range];
    const q = view.q.trim().toLowerCase();
    const inRange = all.filter((e) => e.t >= cutoff && (!q || e.search.includes(q)));
    const typeOk = (e) => view.types.size === 0 || view.types.has(e.type);
    const stateOk = (e) => !view.state || e.state === view.state;
    return {
      cutoff,
      forTypeChips: inRange.filter(stateOk),
      forStates: inRange.filter(typeOk),
      rows: inRange.filter((e) => typeOk(e) && stateOk(e)),
    };
  }
  const presentTypes = (events) => [...new Set(events.map((e) => e.type))]
    .sort((a, b) => (metaFor(a).slot || 99) - (metaFor(b).slot || 99));

  // ---------- render ----------
  function render() {
    const { cutoff, forTypeChips, forStates, rows } = slices();
    renderStatus();
    renderControls(forTypeChips, forStates);
    renderTiles(rows);
    renderTimeline(rows, cutoff);
    renderStates(forStates);
    renderFires(rows);
    renderLog(rows);
    writeHash();
  }

  function renderStatus() {
    const parts = [];
    if (manifest && !storedError) {
      parts.push(h('span', { text: `${intFmt.format(manifest.total)} events stored since ${fmtDay(Date.parse(manifest.oldest), true)}` }));
      parts.push(h('span', { text: `history updated ${ago(Date.parse(manifest.updated_at))}` }));
    } else if (storedError) {
      parts.push(h('span', { class: 'live' }, h('span', { class: 'dot warning', 'aria-hidden': 'true' }),
        'Stored history unavailable, showing the live feed only'));
    }
    if (liveStatus.ok) {
      const extra = pendingCount ? `, ${pendingCount} not yet stored` : '';
      parts.push(h('span', { class: 'live' }, h('span', { class: 'dot good', 'aria-hidden': 'true' }),
        `Live feed checked ${new Date(liveStatus.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${extra}`));
    } else if (liveStatus.ok === false) {
      parts.push(h('span', { class: 'live' }, h('span', { class: 'dot warning', 'aria-hidden': 'true' }),
        'Live feed unreachable, showing stored history'));
    }
    $('status').replaceChildren(...parts);
  }

  function renderControls(forTypeChips, forStates) {
    for (const btn of $('range').querySelectorAll('button')) btn.setAttribute('aria-pressed', btn.dataset.range === view.range);
    for (const btn of $('mode').querySelectorAll('button')) btn.setAttribute('aria-pressed', btn.dataset.mode === view.mode);

    const typeCounts = countBy(forTypeChips, (e) => e.type);
    const typeKeys = presentTypes(all);
    $('types').classList.toggle('filtered', view.types.size > 0);
    $('types').replaceChildren(...typeKeys.map((key) => h('button', {
      type: 'button', class: 'chip', 'data-type': key, 'aria-pressed': view.types.has(key),
    }, swatch(key, 'dot'), metaFor(key).label, h('span', { class: 'n', text: intFmt.format(typeCounts.get(key) || 0) }))));

    const stateCounts = countBy(forStates, (e) => e.state);
    const names = [...new Set(all.map((e) => e.state))].sort();
    if (view.state && !names.includes(view.state)) names.unshift(view.state);
    const select = $('state');
    select.replaceChildren(
      h('option', { value: '', text: 'All states' }),
      ...names.map((n) => h('option', { value: n, text: `${n} (${intFmt.format(stateCounts.get(n) || 0)})` })),
    );
    select.value = view.state;
    if ($('q').value !== view.q) $('q').value = view.q;
    $('reset').hidden = !(view.types.size || view.state || view.q);
  }

  function countBy(events, keyFn) {
    const map = new Map();
    for (const e of events) map.set(keyFn(e), (map.get(keyFn(e)) || 0) + 1);
    return map;
  }

  function renderTiles(rows) {
    const fires = new Set(rows.map((e) => e.fireKey)).size;
    const states = new Set(rows.map((e) => e.state).filter((st) => st !== 'Unknown')).size;
    const newFires = rows.filter((e) => e.type === 'new_fire').length;
    const oldest = all.length ? all[all.length - 1].t : null;
    const heroNote = view.range === 'all'
      ? (oldest ? `since ${fmtDay(oldest, true)}` : '')
      : RANGE_NOTES[view.range];
    const tile = (label, value, note, hero) => h('div', { class: hero ? 'tile hero' : 'tile' },
      h('div', { class: 'label', text: label }),
      h('div', {}, h('div', { class: 'value', text: fmtCount(value) }), note ? h('div', { class: 'note', text: note }) : null));
    $('tiles').replaceChildren(
      tile('Events', rows.length, heroNote, true),
      tile('New fires detected', newFires),
      tile('Fires with activity', fires),
      tile('States', states),
    );
  }

  // ----- timeline -----
  function floorTo(t, unit) {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    if (unit !== 'hour') {
      d.setHours(0);
      if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    }
    return d;
  }
  function stepDate(d, unit) {
    const n = new Date(d);
    if (unit === 'hour') n.setHours(n.getHours() + 1);
    else n.setDate(n.getDate() + (unit === 'week' ? 7 : 1));
    return n;
  }
  function binLabel(t0, unit) {
    if (unit === 'hour') return `${fmtDay(t0)}, ${fmtHour(t0)}`;
    if (unit === 'week') return `Week of ${fmtDay(t0, true)}`;
    return new Date(t0).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function buildBins(rows, cutoff) {
    const now = Date.now();
    const start = view.range === 'all' ? Math.min(...rows.map((e) => e.t), now) : cutoff;
    const end = Math.max(now, ...rows.map((e) => e.t));
    const span = end - start;
    const unit = span <= 3 * DAY ? 'hour' : span <= 120 * DAY ? 'day' : 'week';
    const bins = [];
    const index = new Map();
    for (let d = floorTo(start, unit); d.getTime() <= end && bins.length < 2000; d = stepDate(d, unit)) {
      const bin = { t0: d.getTime(), counts: new Map(), total: 0 };
      index.set(bin.t0, bin);
      bins.push(bin);
    }
    for (const e of rows) {
      const bin = index.get(floorTo(e.t, unit).getTime());
      if (!bin) continue;
      bin.counts.set(e.type, (bin.counts.get(e.type) || 0) + 1);
      bin.total++;
    }
    return { bins, unit };
  }

  function renderTimeline(rows, cutoff) {
    const types = presentTypes(rows);
    const { bins, unit } = rows.length ? buildBins(rows, cutoff) : { bins: [], unit: 'day' };
    $('timeline-sub').textContent = rows.length
      ? `Events per ${unit}, stacked by type`
      : 'No events match these filters';

    const counts = countBy(rows, (e) => e.type);
    $('legend').replaceChildren(...types.map((t) => h('span', { class: 'key' },
      swatch(t, 'sw'), metaFor(t).label, h('span', { class: 'n', text: intFmt.format(counts.get(t)) }))));

    lastChart = { bins, unit, types };
    if (view.mode === 'table') renderBinTable(bins, unit, types);
    else drawChart();
  }

  function niceStep(max, count = 4) {
    const raw = max / count;
    const p = 10 ** Math.floor(Math.log10(raw));
    const n = raw / p;
    return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  }
  function topRounded(x, y, w, ht, r) {
    r = Math.min(r, w / 2, ht);
    return `M${x},${y + ht}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + ht}Z`;
  }

  function drawChart() {
    const host = $('chart');
    hideTooltip();
    const { bins, unit, types } = lastChart || {};
    if (!bins || !bins.some((b) => b.total)) {
      host.replaceChildren(h('div', { class: 'empty', text: 'No events match these filters.' }));
      return;
    }
    const W = Math.max(280, host.clientWidth);
    const H = 240;
    const max = Math.max(...bins.map((b) => b.total));
    const stepY = niceStep(max);
    const yMax = Math.ceil(max / stepY) * stepY;
    const tickFmt = (v) => (yMax >= 10000 ? compactFmt.format(v) : intFmt.format(v));
    const labelW = Math.max(...[0, yMax].map((v) => tickFmt(v).length)) * 7 + 10;
    const m = { l: labelW, r: 16, t: 10, b: 26 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const band = pw / bins.length;
    const barW = Math.min(24, Math.max(1, band - Math.max(2, band * 0.3)));
    const y = (v) => m.t + ph - (v / yMax) * ph;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Events per ${unit}, stacked by type` });
    for (let v = 0; v <= yMax; v += stepY) {
      if (v > 0) svg.append(s('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const label = s('text', { class: 'tick', x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = tickFmt(v);
      svg.append(label);
    }

    // x labels: hours land on round hours, days/weeks on an even stride
    const need = Math.ceil(70 / band);
    const hourStride = [1, 2, 3, 4, 6, 12, 24].find((n) => n >= need) || 24;
    bins.forEach((bin, i) => {
      const d = new Date(bin.t0);
      const show = unit === 'hour' ? d.getHours() % hourStride === 0 : i % need === 0;
      if (!show) return;
      const text = unit === 'hour' && d.getHours() !== 0 ? fmtHour(bin.t0) : fmtDay(bin.t0);
      const label = s('text', { class: 'tick', x: m.l + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' });
      label.textContent = text;
      svg.append(label);
    });

    const plot = s('g', { class: 'plot' });
    bins.forEach((bin, i) => {
      const col = s('g', { class: 'col' });
      const x = m.l + i * band + (band - barW) / 2;
      const stack = types.filter((t) => bin.counts.get(t));
      let acc = 0;
      stack.forEach((t, k) => {
        const v = bin.counts.get(t);
        const top = y(acc + v);
        const ht = y(acc) - top;
        acc += v;
        const isTop = k === stack.length - 1;
        const gap = isTop ? 0 : Math.min(2, ht / 2); // 2px surface gap between segments
        const mark = isTop
          ? s('path', { d: topRounded(x, top, barW, ht, 4) })
          : s('rect', { x, y: top + gap, width: barW, height: Math.max(0.5, ht - gap) });
        mark.setAttribute('class', 'seg-mark');
        mark.style.fill = colorOf(t);
        col.append(mark);
      });
      const hit = s('rect', {
        class: 'hit', x: m.l + i * band, y: m.t, width: band, height: ph, tabindex: bin.total ? 0 : -1,
        'aria-label': `${binLabel(bin.t0, unit)}: ${bin.total} events${stack.map((t) => `, ${metaFor(t).label} ${bin.counts.get(t)}`).join('')}`,
      });
      const on = () => {
        plot.classList.add('hovering');
        col.classList.add('on');
        showTooltip(bin, unit, types, m.l + i * band + band / 2, band, y(bin.total));
      };
      const off = () => {
        plot.classList.remove('hovering');
        col.classList.remove('on');
        hideTooltip();
      };
      hit.addEventListener('pointerenter', on);
      hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
      col.append(hit);
      plot.append(col);
    });
    svg.append(plot);
    svg.append(s('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
    host.replaceChildren(svg);
  }

  function showTooltip(bin, unit, types, cx, band, topY) {
    const tip = $('tooltip');
    const host = $('chart');
    const card = $('timeline-card');
    const rows = types.filter((t) => bin.counts.get(t)).reverse(); // match stack order, top first
    tip.replaceChildren(
      h('div', { class: 'tt-head', text: binLabel(bin.t0, unit) }),
      ...rows.map((t) => {
        const key = h('span', { class: 'lk' });
        key.style.background = colorOf(t);
        return h('div', { class: 'tt-row' }, key, h('strong', { text: intFmt.format(bin.counts.get(t)) }), h('span', { text: metaFor(t).label }));
      }),
      h('div', { class: 'tt-row tt-total' }, h('span'), h('strong', { text: intFmt.format(bin.total) }), h('span', { text: 'Total' })),
    );
    tip.hidden = false;
    const hostBox = host.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const ox = hostBox.left - cardBox.left;
    const oy = hostBox.top - cardBox.top;
    const tw = tip.offsetWidth;
    let left = ox + cx + band / 2 + 8;
    if (left + tw > cardBox.width - 8) left = ox + cx - band / 2 - 8 - tw;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${oy + Math.max(0, topY - 20)}px`;
  }
  function hideTooltip() {
    $('tooltip').hidden = true;
  }

  function renderBinTable(bins, unit, types) {
    hideTooltip();
    const withData = bins.filter((b) => b.total).reverse();
    if (!withData.length) {
      $('chart').replaceChildren(h('div', { class: 'empty', text: 'No events match these filters.' }));
      return;
    }
    const period = { hour: 'Hour', day: 'Day', week: 'Week' }[unit];
    $('chart').replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: period }),
        ...types.map((t) => h('th', { class: 'num', text: metaFor(t).label })), h('th', { class: 'num', text: 'Total' }))),
      h('tbody', {}, ...withData.map((b) => h('tr', {}, h('td', { text: binLabel(b.t0, unit) }),
        ...types.map((t) => h('td', { class: 'num', text: intFmt.format(b.counts.get(t) || 0) })),
        h('td', { class: 'num', text: intFmt.format(b.total) })))),
    )));
  }

  // ----- bar lists -----
  function barRow(tag, props, label, sub, value, max, valueText) {
    const bar = h('span', { class: 'bar' });
    bar.style.width = `calc((100% - 64px) * ${max ? value / max : 0})`;
    return h(tag, props,
      h('span', { class: 'name', title: label }, label, sub ? h('small', { text: sub }) : null),
      h('span', { class: 'track' }, bar, h('span', { class: 'val', text: valueText })));
  }

  function renderStates(events) {
    const host = $('states');
    const counts = [...countBy(events, (e) => e.state)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!counts.length) {
      host.replaceChildren(h('div', { class: 'empty', text: 'No events match these filters.' }));
      return;
    }
    const top = counts.slice(0, 10);
    if (view.state && !top.some(([n]) => n === view.state)) {
      const sel = counts.find(([n]) => n === view.state);
      if (sel) top.push(sel);
    }
    const max = counts[0][1];
    host.classList.toggle('selecting', !!view.state);
    host.replaceChildren(
      ...top.map(([name, n]) => barRow('button', {
        type: 'button', class: name === view.state ? 'hbar active' : 'hbar', 'data-state': name,
        'aria-pressed': name === view.state, 'aria-label': `${name}: ${n} events`,
      }, name, null, n, max, intFmt.format(n))),
      counts.length > top.length ? h('div', { class: 'rest', text: `+ ${counts.length - top.length} more states` }) : null,
    );
  }

  function renderFires(rows) {
    const host = $('fires');
    const latest = new Map();
    for (const e of rows) {
      if (e.acres == null || e.acres <= 0) continue;
      const prev = latest.get(e.fireKey);
      if (!prev || e.t > prev.t) latest.set(e.fireKey, e);
    }
    const top = [...latest.values()].sort((a, b) => b.acres - a.acres).slice(0, 10);
    if (!top.length) {
      host.replaceChildren(h('div', { class: 'empty', text: 'No size reports in this selection.' }));
      return;
    }
    const max = top[0].acres;
    host.replaceChildren(...top.map((e) => barRow(e.link ? 'a' : 'div', {
      class: 'hbar', href: e.link, target: e.link ? '_blank' : null, rel: e.link ? 'noopener' : null,
      title: `${e.name}, ${e.state}: ${acresFmt.format(e.acres)} acres (reported ${fmtTime(e.t)})`,
    }, e.name, e.state, e.acres, max, `${acresFmt.format(e.acres)} ac`)));
  }

  // ----- event log -----
  function renderLog(rows) {
    const shown = rows.slice(0, view.rows);
    $('log-sub').textContent = rows.length
      ? `Showing ${intFmt.format(shown.length)} of ${intFmt.format(rows.length)} events, newest first`
      : 'No events match these filters';
    $('log').replaceChildren(...shown.map((e) => h('tr', {},
      h('td', { class: 'time', text: fmtTime(e.t) }),
      h('td', { class: 'type' }, swatch(e.type, 'dot'), metaFor(e.type).label),
      h('td', { class: 'fire' }, e.link ? h('a', { href: e.link, target: '_blank', rel: 'noopener', text: e.name }) : e.name),
      h('td', { class: 'state', text: e.state }),
      h('td', { class: 'details', text: e.details }),
    )));
    const more = $('more');
    more.hidden = rows.length <= shown.length;
    more.textContent = `Show ${intFmt.format(Math.min(PAGE_ROWS, rows.length - shown.length))} more`;
  }

  function downloadCSV() {
    const { rows } = slices();
    const cell = (v) => {
      let str = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`; // keep spreadsheets from evaluating it
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const header = ['published', 'type', 'fire', 'state', 'details', 'acres', 'contained_pct', 'link', 'id'];
    const lines = rows.map((e) => [e.published, e.type, e.name, e.state, e.details, e.acres, e.contained, e.link, e.id].map(cell).join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `wildfire-events-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- URL hash keeps filters shareable ----------
  function writeHash() {
    const p = new URLSearchParams();
    if (view.range !== 'all') p.set('range', view.range);
    if (view.types.size) p.set('type', [...view.types].join(','));
    if (view.state) p.set('state', view.state);
    if (view.q) p.set('q', view.q);
    if (view.mode !== 'chart') p.set('view', view.mode);
    const hash = p.toString();
    if (hash !== location.hash.slice(1)) history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (RANGES[p.get('range')]) view.range = p.get('range');
    view.types = new Set((p.get('type') || '').split(',').filter(Boolean));
    view.state = p.get('state') || '';
    view.q = p.get('q') || '';
    view.mode = p.get('view') === 'table' ? 'table' : 'chart';
  }

  // ---------- wiring ----------
  function update(changes) {
    Object.assign(view, changes, { rows: PAGE_ROWS });
    render();
  }

  function bind() {
    $('range').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-range]');
      if (btn) update({ range: btn.dataset.range });
    });
    $('mode').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-mode]');
      if (btn) update({ mode: btn.dataset.mode });
    });
    $('types').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-type]');
      if (!btn) return;
      const next = new Set(view.types);
      next.has(btn.dataset.type) ? next.delete(btn.dataset.type) : next.add(btn.dataset.type);
      update({ types: next });
    });
    $('states').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-state]');
      if (btn) update({ state: btn.dataset.state === view.state ? '' : btn.dataset.state });
    });
    $('state').addEventListener('change', (ev) => update({ state: ev.target.value }));
    let timer;
    $('q').addEventListener('input', (ev) => {
      clearTimeout(timer);
      timer = setTimeout(() => update({ q: ev.target.value }), 150);
    });
    $('reset').addEventListener('click', () => update({ types: new Set(), state: '', q: '' }));
    $('more').addEventListener('click', () => {
      view.rows += PAGE_ROWS;
      renderLog(slices().rows);
    });
    $('csv').addEventListener('click', downloadCSV);
    window.addEventListener('hashchange', () => {
      readHash();
      render();
    });

    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width !== lastWidth && view.mode === 'chart' && lastChart) {
        lastWidth = width;
        drawChart();
      }
    }).observe($('chart'));
  }

  async function refresh() {
    if (document.hidden) return;
    await Promise.all([loadStored(), loadLive()]);
    merge();
    render();
  }

  async function init() {
    readHash();
    bind();
    await Promise.all([loadStored(), loadLive()]);
    merge();
    render();
    setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - liveStatus.at > REFRESH_MS) refresh();
    });
  }

  init();
})();

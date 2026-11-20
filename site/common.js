'use strict';

// Shared helpers for the alerts and users tabs. All text goes through textContent.
window.Dash = (() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const DAY = 864e5;

  function h(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k.startsWith('aria-')) { node.setAttribute(k, String(v)); continue; }
      if (v === false) continue;
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
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  function s(tag, attrs = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    return node;
  }

  const intFmt = new Intl.NumberFormat();
  const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const fmtCount = (n) => (n >= 10000 ? compactFmt.format(n) : intFmt.format(n));
  function fmtTime(t) {
    if (t == null || Number.isNaN(t)) return '—';
    const d = new Date(t);
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleString(undefined, opts);
  }
  const fmtDay = (t, withYear) => (t == null || Number.isNaN(t) ? '—' : new Date(t).toLocaleDateString(undefined,
    withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }));
  function ago(t) {
    if (t == null || Number.isNaN(t)) return 'never';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days < 60 ? `${days} days ago` : fmtDay(t, true);
  }
  const parseTime = (str) => (str ? Date.parse(str) : null);
  const countBy = (items, keyFn) => {
    const map = new Map();
    for (const item of items) {
      for (const key of [].concat(keyFn(item))) map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };

  async function getJSON(url, opts = {}) {
    const res = await fetch(url, { cache: 'no-cache', ...opts });
    if (!res.ok) {
      const err = new Error(`${url} returned ${res.status}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('Retry-After')) || null;
      throw err;
    }
    return res.json();
  }

  // ----- URL hash: each tab owns a few keys and leaves the others alone -----
  const hashParams = () => new URLSearchParams(location.hash.slice(1));
  function writeHashKeys(values) {
    const p = hashParams();
    for (const [k, v] of Object.entries(values)) (v ? p.set(k, v) : p.delete(k));
    const hash = p.toString();
    if (hash !== location.hash.slice(1)) history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }

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
  const stateName = (code) => STATES[String(code).toUpperCase()] || String(code);

  // ----- small building blocks -----
  const tile = (label, value, note, hero) => h('div', { class: hero ? 'tile hero' : 'tile' },
    h('div', { class: 'label', text: label }),
    h('div', {}, h('div', { class: 'value', text: typeof value === 'number' ? fmtCount(value) : value }),
      note ? h('div', { class: 'note', text: note }) : null));

  // Ranked horizontal bars (single series). items: [{key, label, sub, value}]
  function hbars(host, items, { active, onPick, emptyText = 'Nothing to show.', limit = 10, unit = '' } = {}) {
    if (!items.length) return fill(host, h('div', { class: 'empty', text: emptyText }));
    const top = items.slice(0, limit);
    if (active && !top.some((i) => i.key === active)) {
      const sel = items.find((i) => i.key === active);
      if (sel) top.push(sel);
    }
    const max = Math.max(...items.map((i) => i.value));
    host.classList.toggle('selecting', !!active);
    fill(host,
      top.map((item) => {
        const bar = h('span', { class: 'bar' });
        bar.style.width = `calc((100% - 64px) * ${max ? item.value / max : 0})`;
        const tag = onPick ? 'button' : 'div';
        return h(tag, {
          type: onPick ? 'button' : null, class: item.key === active ? 'hbar active' : 'hbar',
          'aria-pressed': onPick ? item.key === active : null,
          onclick: onPick ? () => onPick(item.key === active ? '' : item.key) : null,
        },
        h('span', { class: 'name', title: item.label }, item.label, item.sub ? h('small', { text: item.sub }) : null),
        h('span', { class: 'track' }, bar, h('span', { class: 'val', text: `${intFmt.format(item.value)}${unit}` })));
      }),
      items.length > top.length ? h('div', { class: 'rest', text: `+ ${items.length - top.length} more` }) : null);
  }

  // Single-series column chart over time with a per-column tooltip.
  // rows: items with a timestamp; timeOf(item) -> ms. Returns nothing; draws into host.
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
    if (unit === 'hour') return `${fmtDay(t0)}, ${new Date(t0).toLocaleTimeString(undefined, { hour: 'numeric' })}`;
    if (unit === 'week') return `Week of ${fmtDay(t0, true)}`;
    return new Date(t0).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function bin(rows, timeOf, start, end) {
    const span = end - start;
    const unit = span <= 3 * DAY ? 'hour' : span <= 120 * DAY ? 'day' : 'week';
    const bins = [];
    const index = new Map();
    for (let d = floorTo(start, unit); d.getTime() <= end && bins.length < 2000; d = stepDate(d, unit)) {
      const b = { t0: d.getTime(), n: 0 };
      bins.push(b);
      index.set(b.t0, b);
    }
    for (const r of rows) {
      const b = index.get(floorTo(timeOf(r), unit).getTime());
      if (b) b.n++;
    }
    return { bins, unit };
  }
  function niceStep(max, count = 4) {
    const raw = max / count;
    const p = 10 ** Math.floor(Math.log10(raw));
    const n = raw / p;
    return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
  }
  function columnChart(host, tip, card, { bins, unit }, noun) {
    tip.hidden = true;
    if (!bins.some((b) => b.n)) return fill(host, h('div', { class: 'empty', text: 'Nothing in this range.' }));
    const W = Math.max(280, host.clientWidth);
    const H = 200;
    const max = Math.max(...bins.map((b) => b.n));
    const step = niceStep(max);
    const yMax = Math.ceil(max / step) * step;
    const m = { l: String(yMax).length * 7 + 12, r: 16, t: 10, b: 26 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const band = pw / bins.length;
    const barW = Math.min(24, Math.max(1, band - Math.max(2, band * 0.3)));
    const y = (v) => m.t + ph - (v / yMax) * ph;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${noun} per ${unit}` });
    for (let v = 0; v <= yMax; v += step) {
      if (v > 0) svg.append(s('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const t = s('text', { class: 'tick', x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = intFmt.format(v);
      svg.append(t);
    }
    const need = Math.ceil(70 / band);
    const hourStride = [1, 2, 3, 4, 6, 12, 24].find((n) => n >= need) || 24;
    bins.forEach((b, i) => {
      const d = new Date(b.t0);
      if (unit === 'hour' ? d.getHours() % hourStride : i % need) return;
      const t = s('text', { class: 'tick', x: m.l + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = unit === 'hour' && d.getHours() ? d.toLocaleTimeString(undefined, { hour: 'numeric' }) : fmtDay(b.t0);
      svg.append(t);
    });
    const plot = s('g', { class: 'plot' });
    bins.forEach((b, i) => {
      const col = s('g', { class: 'col' });
      if (b.n) {
        const x = m.l + i * band + (band - barW) / 2;
        const top = y(b.n);
        const ht = y(0) - top;
        const r = Math.min(4, barW / 2, ht);
        const mark = s('path', { class: 'seg-mark', d: `M${x},${top + ht}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + barW - r}A${r},${r} 0 0 1 ${x + barW},${top + r}V${top + ht}Z` });
        mark.style.fill = 'var(--s1)';
        col.append(mark);
      }
      const hit = s('rect', { class: 'hit', x: m.l + i * band, y: m.t, width: band, height: ph, tabindex: b.n ? 0 : -1,
        'aria-label': `${binLabel(b.t0, unit)}: ${b.n} ${noun}` });
      const on = () => {
        plot.classList.add('hovering');
        col.classList.add('on');
        fill(tip, h('div', { class: 'tt-head', text: binLabel(b.t0, unit) }),
          h('div', { class: 'tt-row' }, h('span'), h('strong', { text: intFmt.format(b.n) }), h('span', { text: noun })));
        tip.hidden = false;
        const hb = host.getBoundingClientRect();
        const cb = card.getBoundingClientRect();
        let left = hb.left - cb.left + m.l + (i + 1) * band + 8;
        if (left + tip.offsetWidth > cb.width - 8) left = hb.left - cb.left + m.l + i * band - 8 - tip.offsetWidth;
        tip.style.left = `${Math.max(8, left)}px`;
        tip.style.top = `${hb.top - cb.top + Math.max(0, y(b.n) - 20)}px`;
      };
      const off = () => {
        plot.classList.remove('hovering');
        col.classList.remove('on');
        tip.hidden = true;
      };
      hit.addEventListener('pointerenter', on);
      hit.addEventListener('focus', on);
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
      col.append(hit);
      plot.append(col);
    });
    svg.append(plot, s('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
    fill(host, svg);
  }

  return {
    DAY, h, fill, s, intFmt, fmtCount, fmtTime, fmtDay, ago, parseTime, countBy, getJSON,
    hashParams, writeHashKeys, stateName, tile, hbars, bin, columnChart,
  };
})();

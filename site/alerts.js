'use strict';

// Official alerts tab. Reads alerts the GitHub Action stored from the admin API
// (site/data/alerts/YYYY-MM.json, listed under "alerts" in data/manifest.json).
(() => {
  const D = window.Dash;
  const { h, fill } = D;
  const $ = (id) => document.getElementById(id);
  const RANGES = { '24h': D.DAY, '7d': 7 * D.DAY, '30d': 30 * D.DAY, all: Infinity };
  const PAGE = 50;
  const KEYS = { range: 'arange', status: 'astatus', state: 'astate', q: 'aq' };

  let alerts = [];
  let info = null; // manifest.alerts
  let loaded = false;
  let loadError = null;
  let visible = false;
  const view = { range: 'all', status: '', state: '', q: '', rows: PAGE };

  function normalize(raw) {
    const sent = D.parseTime(raw.sent_at) ?? D.parseTime(raw.first_seen_at);
    const states = (raw.states || []).map(D.stateName);
    const headline = raw.headline || raw.title || 'Official alert';
    return {
      id: raw.id, t: sent, sent,
      firstSeen: D.parseTime(raw.first_seen_at),
      expires: D.parseTime(raw.expires_at),
      headline, title: raw.title, summary: raw.summary, instruction: raw.instruction,
      sender: raw.sender || 'Unknown sender', area: raw.area, states,
      fire: raw.fire && raw.fire.cornea_id ? raw.fire : null,
      // The poller resolves the fire's page from its events; its slug is the events tab's fire key.
      fireSlug: (/\/fire\/([^/?#]+)/.exec(raw.fire_url || '') || [])[1] || null,
      url: /^https?:\/\//i.test(raw.url || '') ? raw.url : null,
      search: [headline, raw.title, raw.summary, raw.instruction, raw.sender, raw.area, states.join(' '), raw.fire?.name]
        .filter(Boolean).join(' ').toLowerCase(),
    };
  }
  const isActive = (a, now = Date.now()) => a.expires == null || a.expires > now;

  async function load() {
    try {
      const manifest = await D.getJSON('data/manifest.json');
      info = manifest.alerts || null;
      const files = (info?.months || []).map((m) => m.file).filter((f) => /^alerts\/[\w-]+\.json$/.test(f));
      const shards = await Promise.all(files.map((f) => D.getJSON(`data/${f}`)));
      alerts = shards.flat().map(normalize).sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
      loadError = null;
    } catch (err) {
      loadError = err;
    }
    loaded = true;
  }

  function readHash() {
    const p = D.hashParams();
    view.range = RANGES[p.get(KEYS.range)] ? p.get(KEYS.range) : 'all';
    view.status = ['active', 'expired'].includes(p.get(KEYS.status)) ? p.get(KEYS.status) : '';
    view.state = p.get(KEYS.state) || '';
    view.q = p.get(KEYS.q) || '';
  }
  function writeHash() {
    D.writeHashKeys({
      [KEYS.range]: view.range === 'all' ? '' : view.range,
      [KEYS.status]: view.status, [KEYS.state]: view.state, [KEYS.q]: view.q,
    });
  }

  function slices() {
    const now = Date.now();
    const cutoff = now - RANGES[view.range];
    const q = view.q.trim().toLowerCase();
    const base = alerts.filter((a) => a.t >= cutoff && (!q || a.search.includes(q))
      && (!view.status || (view.status === 'active') === isActive(a, now)));
    return {
      cutoff,
      forStates: base,
      rows: base.filter((a) => !view.state || a.states.includes(view.state)),
    };
  }

  function render() {
    if (!visible || !loaded) return;
    const { cutoff, forStates, rows } = slices();
    for (const b of $('a-range').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.range === view.range);
    for (const b of $('a-status').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.status === view.status);

    const stateCounts = D.countBy(forStates, (a) => a.states);
    const names = [...new Set(alerts.flatMap((a) => a.states))].sort();
    if (view.state && !names.includes(view.state)) names.unshift(view.state);
    fill($('a-state'), h('option', { value: '', text: 'All states' }),
      names.map((n) => h('option', { value: n, text: `${n} (${D.intFmt.format(stateCounts.get(n) || 0)})` })));
    $('a-state').value = view.state;
    if ($('a-q').value !== view.q) $('a-q').value = view.q;
    $('a-reset').hidden = !(view.status || view.state || view.q);

    const now = Date.now();
    const oldest = alerts.length ? alerts[alerts.length - 1].t : null;
    fill($('a-tiles'),
      D.tile('Official alerts', rows.length, view.range === 'all' ? (oldest ? `since ${D.fmtDay(oldest, true)}` : '') : `in the last ${{ '24h': '24 hours', '7d': '7 days', '30d': '30 days' }[view.range]}`, true),
      D.tile('Active now', rows.filter((a) => isActive(a, now)).length),
      D.tile('States', new Set(rows.flatMap((a) => a.states)).size),
      D.tile('Linked to a fire', rows.filter((a) => a.fire).length));

    $('a-timeline-sub').textContent = rows.length ? 'Alerts by time sent' : '';
    const start = view.range === 'all' ? Math.min(now, ...rows.map((a) => a.t)) : cutoff;
    D.columnChart($('a-chart'), $('a-tooltip'), $('a-timeline-card'), D.bin(rows, (a) => a.t, start, now), 'alerts');

    D.hbars($('a-states'), [...stateCounts].map(([key, value]) => ({ key, label: key, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
    { active: view.state, onPick: (state) => update({ state }), emptyText: 'No alerts in this selection.' });
    D.hbars($('a-senders'), [...D.countBy(rows, (a) => a.sender)].map(([key, value]) => ({ key, label: key, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)), { emptyText: 'No alerts in this selection.' });

    renderLog(rows);
    writeHash();
  }

  function renderLog(rows) {
    const shown = rows.slice(0, view.rows);
    $('a-log-sub').textContent = rows.length
      ? `Showing ${D.intFmt.format(shown.length)} of ${D.intFmt.format(rows.length)} alerts, newest first`
      : '';
    if (!rows.length) {
      let text = 'No alerts match these filters.';
      if (loadError) text = 'Stored alerts could not be loaded.';
      else if (!info) text = 'No official alerts stored yet. They appear after the Action\'s next poll of the admin API.';
      fill($('a-log'), h('div', { class: 'empty', text }));
    } else {
      const now = Date.now();
      fill($('a-log'), shown.map((a) => alertItem(a, now)));
    }
    $('a-more').hidden = rows.length <= shown.length;
    $('a-more').textContent = `Show ${D.intFmt.format(Math.min(PAGE, rows.length - shown.length))} more`;
  }

  function alertItem(a, now) {
    const active = isActive(a, now);
    const expiry = a.expires == null ? 'No expiry given'
      : active ? `Expires ${D.fmtTime(a.expires)}` : `Expired ${D.fmtTime(a.expires)}`;
    const area = a.area && a.area !== 'Location' ? a.area : null; // some senders put a placeholder here
    const meta = [a.sender, area, a.states.join(', '), expiry].filter(Boolean).join(' · ');
    const details = [a.summary !== a.headline ? a.summary : null, a.instruction].filter(Boolean);
    let linkText = 'Source ↗';
    try {
      if (a.url && new URL(a.url).hostname === 'fires.cornea.is') linkText = 'On Wildfire Explorer ↗';
    } catch { /* keep the generic label */ }
    return h('article', { class: 'alert-item' },
      h('div', { class: 'alert-top' },
        h('span', { class: active ? 'badge active' : 'badge' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), active ? 'Active' : 'Expired'),
        h('h3', { text: a.headline }),
        h('time', { class: 'alert-time', datetime: new Date(a.sent).toISOString(), text: D.fmtTime(a.sent) })),
      h('p', { class: 'alert-meta', text: meta }),
      (a.fire || a.url) ? h('p', { class: 'alert-links' },
        a.fire && a.fireSlug ? h('a', { href: `#fire=${encodeURIComponent(a.fireSlug)}`, text: `Fire events: ${a.fire.name || 'this fire'}` }) : null,
        a.fire && !a.fireSlug ? h('span', { text: `About: ${a.fire.name || 'a fire'}` }) : null,
        a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener', text: linkText }) : null) : null,
      details.length ? h('details', {}, h('summary', { text: 'Details' }), details.map((text) => h('p', { text }))) : null);
  }

  function update(changes) {
    Object.assign(view, changes, { rows: PAGE });
    render();
  }

  $('a-range').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-range]');
    if (b) update({ range: b.dataset.range });
  });
  $('a-status').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-status]');
    if (b) update({ status: b.dataset.status });
  });
  $('a-state').addEventListener('change', (ev) => update({ state: ev.target.value }));
  let timer;
  $('a-q').addEventListener('input', (ev) => {
    clearTimeout(timer);
    timer = setTimeout(() => update({ q: ev.target.value }), 150);
  });
  $('a-reset').addEventListener('click', () => update({ status: '', state: '', q: '' }));
  $('a-more').addEventListener('click', () => {
    view.rows += PAGE;
    renderLog(slices().rows);
  });
  window.addEventListener('hashchange', () => {
    readHash();
    render();
  });
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w && w !== lastWidth) {
      lastWidth = w;
      render();
    }
  }).observe($('a-chart'));

  document.addEventListener('dash:tab', async (ev) => {
    visible = ev.detail === 'alerts';
    if (!visible) return;
    if (!loaded) {
      readHash();
      fill($('a-log'), h('div', { class: 'empty', text: 'Loading alerts…' }));
      await load();
    }
    render();
  });
})();

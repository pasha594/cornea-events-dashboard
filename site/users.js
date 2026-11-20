'use strict';

// Users tab: only on the private copy behind IAP. Users come live from
// /private/users, which that server answers from the admin API. Nothing about
// users is stored in this repository, the public site, or the browser.
(() => {
  const D = window.Dash;
  const { h, fill } = D;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  const MAX_PAGES = 100; // 10,000 users; past that, search goes to the server
  const EVENT_TYPES = { new_fire: 'New fire', acres: 'Acreage', containment: 'Containment', perimeter: 'Perimeter', ipaws_alert: 'Official alerts' };

  let enabled = false;
  let visible = false;
  let started = false;
  let users = [];
  let complete = false; // every page loaded
  let loading = false;
  let loadError = null;
  let serverHits = null; // results of a server-side search when not every user is loaded
  let selected = null;
  const view = { q: '', show: '', sort: 'created', dir: -1, rows: PAGE };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One request at a time, honouring the admin API's 429 Retry-After and retrying 503s.
  async function fetchJSON(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await D.getJSON(url, { cache: 'no-store' });
      } catch (err) {
        if (err.status === 429 && attempt <= 5) {
          setStatus(`Rate limited by the admin API, retrying in ${err.retryAfter || 5}s…`);
          await sleep((err.retryAfter || 5) * 1000);
        } else if ((err.status === 503 || err.status === 502) && attempt <= 3) {
          await sleep(3000 * attempt);
        } else {
          throw err;
        }
      }
    }
  }

  function normalize(summary) {
    const u = summary.user || {};
    const a = summary.activity || {};
    return {
      uid: u.uid, email: u.email || '(no email)', verified: !!u.email_verified, disabled: !!u.disabled,
      created: D.parseTime(u.created_at), signin: D.parseTime(u.last_sign_in_at),
      subs: a.subscriptions || 0, activeSubs: a.active_subscriptions || 0,
      emails: a.emails_sent || 0, lastEmail: D.parseTime(a.last_email_at),
      search: `${u.email || ''} ${u.uid || ''}`.toLowerCase(),
    };
  }

  async function loadAll() {
    loading = true;
    let page = '';
    try {
      for (let n = 0; n < MAX_PAGES; n++) {
        const data = await fetchJSON(`private/users${page ? `?page=${encodeURIComponent(page)}` : ''}`);
        users.push(...(data.users || []).map(normalize));
        setStatus(`Loading users… ${D.intFmt.format(users.length)} so far`);
        render();
        if (!data.next_page) {
          complete = true;
          break;
        }
        page = data.next_page;
      }
      loadError = null;
    } catch (err) {
      loadError = err;
    }
    loading = false;
    setStatus('');
    render();
  }

  let whoami = '';
  function setStatus(text) {
    $('u-status').textContent = text || (whoami ? `Signed in as ${whoami}` : '');
  }

  function rowsFor() {
    const q = view.q.trim().toLowerCase();
    let rows = serverHits && q ? serverHits : users.filter((u) => !q || u.search.includes(q));
    if (view.show === 'subscribed') rows = rows.filter((u) => u.activeSubs > 0);
    if (view.show === 'emailed') rows = rows.filter((u) => u.emails > 0);
    const key = view.sort;
    return [...rows].sort((a, b) => {
      const av = a[key] ?? -Infinity;
      const bv = b[key] ?? -Infinity;
      return av === bv ? a.email.localeCompare(b.email) : (av < bv ? -1 : 1) * view.dir;
    });
  }

  function render() {
    if (!enabled || !visible) return;
    for (const b of $('u-show').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.show === view.show);
    for (const b of document.querySelectorAll('.users .sort')) {
      const on = b.dataset.sort === view.sort;
      b.closest('th').setAttribute('aria-sort', on ? (view.dir < 0 ? 'descending' : 'ascending') : 'none');
      b.classList.toggle('on', on);
    }

    const count = (fn) => users.filter(fn).length;
    const verified = count((u) => u.verified);
    fill($('u-tiles'),
      D.tile('Users', users.length, complete ? '' : loading ? 'loading…' : 'first pages only', true),
      D.tile('Verified email', verified, users.length ? `${Math.round((verified / users.length) * 100)}%` : ''),
      D.tile('With active subscriptions', count((u) => u.activeSubs > 0)),
      D.tile('Alert emails, 30 days', users.reduce((sum, u) => sum + u.emails, 0)));

    const rows = rowsFor();
    const shown = rows.slice(0, view.rows);
    $('u-sub').textContent = loadError
      ? `Could not load users (${loadError.message}).`
      : `${D.intFmt.format(rows.length)} ${rows.length === 1 ? 'user' : 'users'}${complete ? '' : ' loaded so far'}. Select one for subscriptions and emails.`;
    fill($('u-rows'), shown.length ? shown.map(userRow)
      : h('tr', {}, h('td', { colspan: 6, class: 'empty', text: loading ? 'Loading users…' : 'No users match.' })));
    $('u-more').hidden = rows.length <= shown.length;
    $('u-more').textContent = `Show ${D.intFmt.format(Math.min(PAGE, rows.length - shown.length))} more`;
  }

  function userRow(u) {
    return h('tr', { class: selected === u.uid ? 'selected' : null },
      h('td', { class: 'email' },
        h('button', { type: 'button', class: 'cell-filter', 'data-uid': u.uid, text: u.email }),
        !u.verified ? h('span', { class: 'tag', text: 'unverified' }) : null,
        u.disabled ? h('span', { class: 'tag', text: 'disabled' }) : null),
      h('td', { class: 'time', text: D.fmtDay(u.created, true) }),
      h('td', { class: 'time', text: D.ago(u.signin) }),
      h('td', { class: 'num', text: u.subs ? `${u.activeSubs} of ${u.subs} active` : '0' }),
      h('td', { class: 'num', text: D.intFmt.format(u.emails) }),
      h('td', { class: 'time', text: u.lastEmail ? D.ago(u.lastEmail) : '—' }));
  }

  // ----- detail panel -----
  async function openUser(uid) {
    selected = uid;
    render();
    const panel = $('u-detail');
    panel.hidden = false;
    fill(panel, h('div', { class: 'empty', text: 'Loading user…' }));
    try {
      const detail = await fetchJSON(`private/users/${encodeURIComponent(uid)}`);
      if (selected === uid) fill(panel, detailView(detail));
    } catch (err) {
      if (selected === uid) fill(panel, closeButton(), h('div', { class: 'empty', text: err.status === 404 ? 'No user has that uid.' : `Could not load this user (${err.message}).` }));
    }
    if (window.matchMedia('(max-width: 1100px)').matches) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeButton() {
    return h('button', { type: 'button', class: 'btn close', text: 'Close', onclick: () => {
      selected = null;
      $('u-detail').hidden = true;
      render();
    } });
  }

  function detailView(d) {
    const u = d.user || {};
    const claims = Object.entries(u.claims || {});
    const subs = d.subscriptions || [];
    const emails = d.emails || { rows: [], total: 0 };
    return [
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', { text: u.email || d.uid }), h('p', { class: 'card-sub mono', text: d.uid })),
        closeButton()),
      h('dl', { class: 'facts' },
        fact('Email', u.email_verified ? 'Verified' : 'Not verified'),
        fact('Account', u.disabled ? 'Disabled' : 'Active'),
        fact('Joined', D.fmtTime(D.parseTime(u.created_at))),
        fact('Last sign-in', D.fmtTime(D.parseTime(u.last_sign_in_at))),
        claims.length ? fact('Claims', claims.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')) : null),
      h('h3', { class: 'detail-h', text: `Subscriptions (${subs.length})` }),
      subs.length ? h('ul', { class: 'subs' }, subs.map(subscriptionItem)) : h('p', { class: 'empty small', text: 'No subscriptions.' }),
      h('h3', { class: 'detail-h', text: `Alert emails, last 30 days (${D.intFmt.format(emails.total)})` }),
      emails.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'emails' },
        h('thead', {}, h('tr', {}, ['Queued', 'Status', 'About', 'Kind'].map((t) => h('th', { text: t })))),
        h('tbody', {}, emails.rows.map(emailRow)))) : h('p', { class: 'empty small', text: 'No alert emails in the last 30 days.' }),
      emails.total > emails.rows.length ? h('p', { class: 'card-sub', text: `Showing the latest ${emails.rows.length}.` }) : null,
    ];
  }
  const fact = (label, value) => [h('dt', { text: label }), h('dd', { text: value })];

  function subscriptionItem(s) {
    const types = (s.event_types || []).map((t) => EVENT_TYPES[t] || t).join(', ') || 'All updates';
    let where;
    if (s.kind === 'location') {
      where = h('span', {}, `${s.location_name || s.label} · within ${s.radius_mi} mi`,
        h('small', { class: 'mono', text: ` ${Number(s.lat).toFixed(3)}, ${Number(s.lon).toFixed(3)}` }));
    } else {
      // permalink_slug is the fire page slug, which the events tab uses as its fire key.
      where = s.permalink_slug
        ? h('a', { href: `#fire=${encodeURIComponent(s.permalink_slug)}`, text: s.fire_name || s.label })
        : h('span', { text: s.fire_name || s.label });
    }
    return h('li', { class: s.active ? '' : 'paused' },
      h('span', { class: 'tag', text: s.kind === 'location' ? 'Area' : 'Fire' }),
      h('div', {}, where, h('div', { class: 'card-sub', text: `${types} · ${s.active ? 'active' : 'paused'} · since ${D.fmtDay(D.parseTime(s.created_at), true)}` })));
  }

  function emailRow(e) {
    const failed = e.status && !/^(sent|delivered|ok)$/i.test(e.status);
    return h('tr', {},
      h('td', { class: 'time', text: D.fmtTime(D.parseTime(e.queued_at)) }),
      h('td', {}, h('span', { class: failed ? 'tag warn' : 'tag', text: e.status }), e.error ? h('div', { class: 'card-sub', text: e.error }) : null),
      h('td', { text: e.fire_title || e.headline || '—' }),
      h('td', { text: EVENT_TYPES[e.kind] || e.kind }));
  }

  // ----- server-side search, only needed when not every user could be loaded -----
  let searchSeq = 0;
  async function serverSearch(q) {
    const seq = ++searchSeq;
    if (complete || !q.trim()) {
      serverHits = null;
      return render();
    }
    try {
      const data = await fetchJSON(`private/users?q=${encodeURIComponent(q.trim())}`);
      if (seq === searchSeq) serverHits = (data.users || []).map(normalize);
    } catch {
      if (seq === searchSeq) serverHits = null;
    }
    render();
  }

  // ----- wiring -----
  let timer;
  $('u-q').addEventListener('input', (ev) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      view.q = ev.target.value;
      view.rows = PAGE;
      render();
      serverSearch(view.q);
    }, 200);
  });
  $('u-show').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-show]');
    if (!b) return;
    view.show = b.dataset.show;
    view.rows = PAGE;
    render();
  });
  document.querySelector('.users thead').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-sort]');
    if (!b) return;
    view.dir = view.sort === b.dataset.sort ? -view.dir : -1;
    view.sort = b.dataset.sort;
    render();
  });
  $('u-rows').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-uid]');
    if (b) openUser(b.dataset.uid);
  });
  $('u-more').addEventListener('click', () => {
    view.rows += PAGE;
    render();
  });

  document.addEventListener('dash:private', (ev) => {
    enabled = true;
    whoami = ev.detail?.email || '';
    setStatus('');
  });
  document.addEventListener('dash:tab', (ev) => {
    visible = ev.detail === 'users';
    if (!visible || !enabled) return;
    if (!started) {
      started = true;
      loadAll();
    }
    render();
  });
})();

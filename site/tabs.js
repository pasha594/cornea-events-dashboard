'use strict';

// Tab bar. The active tab lives in the URL hash (tab=alerts), so links and reloads keep it.
// Other scripts listen for 'dash:tab' (a tab became visible) and 'dash:private' (this is
// the private copy behind IAP, which answers /private/whoami; the public site 404s).
(() => {
  const { hashParams, writeHashKeys, getJSON } = window.Dash;
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  const available = () => tabs.filter((t) => !t.hidden).map((t) => t.dataset.tab);
  let current = null;

  function show(name, { focus = false } = {}) {
    if (!available().includes(name)) name = 'events';
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', on);
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) tab.focus();
    }
    writeHashKeys({ tab: name === 'events' ? '' : name });
    if (name !== current) {
      current = name;
      document.dispatchEvent(new CustomEvent('dash:tab', { detail: name }));
    }
  }

  const tabFromHash = () => hashParams().get('tab') || 'events';

  document.querySelector('.tabs').addEventListener('click', (ev) => {
    const tab = ev.target.closest('[role="tab"]');
    if (tab) show(tab.dataset.tab);
  });
  document.querySelector('.tabs').addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    const names = available();
    const i = names.indexOf(current);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? names.length - 1
      : (i + (ev.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
    show(names[next], { focus: true });
    ev.preventDefault();
  });
  window.addEventListener('hashchange', () => show(tabFromHash()));

  const requested = tabFromHash(); // may be 'users', which only exists once whoami answers
  show(requested);

  getJSON('private/whoami')
    .then((who) => {
      document.getElementById('tab-users').hidden = false;
      document.dispatchEvent(new CustomEvent('dash:private', { detail: who }));
      if (requested === 'users') show('users');
    })
    .catch(() => { /* public site: no Users tab */ });
})();

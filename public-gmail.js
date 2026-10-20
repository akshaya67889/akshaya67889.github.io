(() => {
  'use strict';
  const config = window.POLLPE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/$/, '');
  const apiKey = String(config.key || '');
  const pageSize = 25;
  let adminToken = '', ownerExpires = 0, rows = [], offset = 0, hasMore = false;
  let statusData = null, busy = false, feedBusy = false, statusBusy = false, refreshTimer = null;
  const $ = id => document.getElementById(id);
  const el = {
    panel: $('gmail-integration'), status: $('gmail-status'), setup: $('gmail-setup'),
    mailbox: $('gmail-mailbox'), email: $('gmail-connected-email'), synced: $('gmail-last-synced'),
    error: $('gmail-error'), unlockForm: $('gmail-unlock-form'), password: $('gmail-admin-password'),
    unlockStatus: $('gmail-unlock-status'), connect: $('gmail-connect'), sync: $('gmail-sync'), disconnect: $('gmail-disconnect'),
    actions: $('gmail-actions'), feedStatus: $('gmail-feed-status'), list: $('gmail-feed-list'), count: $('gmail-feed-count'), load: $('gmail-load-more'),
  };
  if (!el.panel) return;
  const mailTab = $('mail');
  const configured = () => Boolean(baseUrl && apiKey);
  const mailVisible = () => Boolean(mailTab && !mailTab.hidden && document.visibilityState === 'visible');
  const headers = (extra = {}) => Object.assign({ apikey: apiKey, Accept: 'application/json' }, extra);
  const setText = (node, value) => { if (node) node.textContent = value || ''; };
  const message = (node, text, kind = '') => { if (node) { node.textContent = text || ''; node.className = `status ${kind}`.trim(); } };
  const errorText = (data, fallback) => typeof data?.error === 'string' ? data.error : data?.error?.message || fallback;
  function formatDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }
  function ownerEnabled() {
    if (ownerExpires && Date.now() >= ownerExpires) { adminToken = ''; ownerExpires = 0; message(el.unlockStatus, 'Owner session expired. Unlock again to manage Gmail.'); }
    el.actions.hidden = !adminToken;
    return Boolean(adminToken);
  }
  async function requestStatus() {
    if (statusBusy) return;
    if (!configured()) { statusData = { configured: false }; renderStatus(); return; }
    statusBusy = true;
    try {
      const r = await fetch(`${baseUrl}/functions/v1/public-gmail?action=status`, { headers: headers(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Status request failed (${r.status}).`);
      statusData = await r.json(); renderStatus();
    } catch (e) { message(el.status, e.message || 'Could not check Gmail status.', 'error'); }
    finally { statusBusy = false; }
  }
  function renderStatus() {
    const s = statusData || {};
    el.setup.hidden = s.configured !== false;
    el.mailbox.hidden = !s.connected;
    setText(el.email, s.email || 'Unknown mailbox');
    setText(el.synced, s.last_synced_at ? `Last synced ${formatDate(s.last_synced_at)}. Automatic checks run about every minute after connection; delivery is not instant.` : 'No synchronization has completed yet.');
    setText(el.error, s.error ? `Synchronization needs attention: ${typeof s.error === 'string' ? s.error : s.error.message || 'Please reconnect Gmail.'}` : '');
    if (!s.configured) message(el.status, 'Gmail setup is pending. Google OAuth configuration is required before live inbox sync can begin.');
    else if (s.connected && (s.error || s.status === 'error' || s.status === 'needs_reauth')) message(el.status, 'Gmail is connected, but synchronization needs attention. The feed may be out of date.', 'error');
    else if (s.connected) message(el.status, `Connected${s.email ? ` as ${s.email}` : ''}. Imported messages are public until they expire.`, 'success');
    else message(el.status, 'Gmail is not connected. The owner can connect it below.');
    el.connect.hidden = !s.configured || Boolean(s.connected);
    el.sync.hidden = !s.connected;
    el.disconnect.hidden = !s.connected;
    ownerEnabled();
  }
  async function unlock(event) {
    event.preventDefault();
    if (busy) return;
    const password = el.password.value;
    if (!password) { message(el.unlockStatus, 'Enter the admin password.', 'error'); return; }
    busy = true; message(el.unlockStatus, 'Unlocking…');
    try {
      const r = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_admin_unlock`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_password: password }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Password was not accepted.');
      const data = await r.json();
      adminToken = typeof data === 'string' ? data : (data?.token || '');
      if (!adminToken) throw new Error('Password was not accepted.');
      ownerExpires = Date.now() + 55 * 60 * 1000;
      message(el.unlockStatus, 'Owner controls unlocked temporarily. Reloading this page locks them again.', 'success');
    } catch (e) { adminToken = ''; ownerExpires = 0; message(el.unlockStatus, e.message || 'Could not unlock owner controls.', 'error'); }
    finally { el.password.value = ''; busy = false; ownerEnabled(); }
  }
  function validGoogleUrl(value) {
    try { const u = new URL(value); return u.origin === 'https://accounts.google.com' && !u.username && !u.password; }
    catch (_) { return false; }
  }
  async function action(name) {
    if (!ownerEnabled() || busy) return;
    busy = true;
    [el.connect, el.sync, el.disconnect].forEach(button => { button.disabled = true; });
    message(el.status, name === 'sync' ? 'Checking Gmail…' : name === 'disconnect' ? 'Disconnecting Gmail…' : 'Starting Google authorization…');
    try {
      const r = await fetch(`${baseUrl}/functions/v1/public-gmail`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: name, admin_token: adminToken }), signal: AbortSignal.timeout(110000) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401) { adminToken = ''; ownerExpires = 0; ownerEnabled(); }
      if (!r.ok) throw new Error(errorText(data, `Gmail request failed (${r.status}).`));
      if (name === 'oauth.start') {
        if (!validGoogleUrl(data.url)) throw new Error('The authorization URL was not a valid Google Accounts URL.');
        window.location.assign(data.url); return;
      }
      await requestStatus();
      if (name === 'sync') await loadFeed(false);
      else if (name === 'disconnect') message(el.status, data.revoked === false ? 'Disconnected locally. Google revocation could not be confirmed; remove this app in your Google Account as well. Existing public messages expire normally.' : 'Gmail disconnected. Existing public messages remain until their expiry.', data.revoked === false ? 'error' : 'success');
    } catch (e) { message(el.status, e.message || 'Gmail action failed.', 'error'); }
    finally { busy = false; [el.connect, el.sync, el.disconnect].forEach(button => { button.disabled = false; }); }
  }
  function uniqueVisible(input) {
    const seen = new Set();
    return input.filter(row => {
      const id = row.gmail_message_id || row.id;
      if (!id || seen.has(id) || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return false;
      seen.add(id); return true;
    });
  }
  function renderFeed() {
    rows = uniqueVisible(rows);
    el.list.replaceChildren();
    setText(el.count, rows.length ? `${rows.length} imported message${rows.length === 1 ? '' : 's'}` : '');
    if (!rows.length) message(el.feedStatus, 'No imported Gmail messages are available yet.', 'empty');
    else {
      message(el.feedStatus, '');
      rows.forEach(row => {
        const card = document.createElement('article'); card.className = 'mail-card gmail-card';
        const heading = document.createElement('div'); heading.className = 'mail-meta'; heading.textContent = `Mailbox: ${row.mailbox_email || 'Unknown mailbox'} · ${formatDate(row.received_at)}`;
        const sender = document.createElement('p'); sender.className = 'gmail-sender'; sender.textContent = `From: ${row.sender || 'Unknown sender'}`;
        const subject = document.createElement('h3'); subject.className = 'gmail-subject'; subject.textContent = row.subject || '(No subject)';
        const body = document.createElement('p'); body.className = 'mail-content'; body.textContent = row.body_text || '';
        const source = document.createElement('p'); source.className = 'gmail-source'; source.textContent = 'Forwarding source: Unknown (not inferred from sender)';
        card.append(heading, sender, subject, body, source); el.list.append(card);
      });
    }
    el.load.hidden = !hasMore;
  }
  async function loadFeed(append = false) {
    if (!configured() || feedBusy) return;
    feedBusy = true;
    const count = append ? pageSize : Math.max(pageSize, offset);
    const nextOffset = append ? offset : 0;
    if (!rows.length) message(el.feedStatus, 'Loading imported Gmail…');
    el.load.disabled = true;
    const params = new URLSearchParams({ select: 'id,gmail_message_id,mailbox_email,sender,subject,body_text,received_at,source_account_status,expires_at', order: 'received_at.desc,id.desc', limit: String(count), offset: String(nextOffset), expires_at: `gt.${new Date().toISOString()}` });
    try {
      const r = await fetch(`${baseUrl}/rest/v1/pollpe_gmail_messages?${params}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Gmail feed request failed (${r.status}).`);
      const next = await r.json();
      if (!Array.isArray(next)) throw new Error('Unexpected Gmail feed response.');
      rows = uniqueVisible(append ? rows.concat(next) : next);
      offset = nextOffset + next.length;
      hasMore = next.length === count;
      renderFeed();
    } catch (e) {
      renderFeed();
      message(el.feedStatus, `${e.message || 'Could not load imported Gmail.'}${rows.length ? ' Previously loaded messages are shown.' : ''}`, 'error');
    } finally { feedBusy = false; el.load.disabled = false; }
  }
  function refresh() {
    ownerEnabled();
    if (!mailVisible()) return;
    requestStatus(); loadFeed(false);
  }
  function startRefresh() {
    clearInterval(refreshTimer); refreshTimer = null;
    if (mailVisible()) { refresh(); refreshTimer = setInterval(refresh, 30000); }
  }
  el.unlockForm.addEventListener('submit', unlock);
  el.connect.addEventListener('click', () => action('oauth.start'));
  el.sync.addEventListener('click', () => action('sync'));
  el.disconnect.addEventListener('click', () => action('disconnect'));
  el.load.addEventListener('click', () => loadFeed(true));
  document.addEventListener('visibilitychange', startRefresh);
  window.addEventListener('hashchange', startRefresh);
  new MutationObserver(startRefresh).observe(mailTab, { attributes: true, attributeFilter: ['hidden'] });
  startRefresh();
})();

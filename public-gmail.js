(() => {
  'use strict';
  const config = window.POLLPE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/$/, '');
  const apiKey = String(config.key || '');
  const pageSize = 25;
  let adminToken = '', ownerExpires = 0, rows = [], offset = 0, hasMore = false;
  let statusData = null, busy = false, feedBusy = false, statusBusy = false, refreshTimer = null, selectedId = null;
  const $ = id => document.getElementById(id);
  const el = {
    panel: $('gmail-integration'), status: $('gmail-status'), setup: $('gmail-setup'),
    mailbox: $('gmail-mailbox'), email: $('gmail-connected-email'), synced: $('gmail-last-synced'),
    error: $('gmail-error'), unlockForm: $('gmail-unlock-form'), password: $('gmail-admin-password'),
    unlockStatus: $('gmail-unlock-status'), connect: $('gmail-connect'), sync: $('gmail-sync'), disconnect: $('gmail-disconnect'),
    reader: $('gmail-reader'), readerClose: $('gmail-reader-close'),
    readerSubject: $('gmail-reader-subject'), readerSender: $('gmail-reader-sender'),
    readerMailbox: $('gmail-reader-mailbox'), readerDate: $('gmail-reader-date'),
    readerExpiry: $('gmail-reader-expiry'), readerBody: $('gmail-reader-body'),
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
  const rowId = row => String(row.gmail_message_id || row.id);
  function senderName(value) {
    const sender = String(value || 'Unknown sender');
    return sender.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || sender;
  }
  function shortDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'Unknown time';
    const today = new Date();
    return new Intl.DateTimeFormat(undefined, d.toDateString() === today.toDateString()
      ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(d);
  }
  function fillReader(row) {
    setText(el.readerSubject, row.subject || '(No subject)');
    setText(el.readerSender, row.sender || 'Unknown sender');
    setText(el.readerMailbox, row.mailbox_email || 'Unknown mailbox');
    setText(el.readerDate, formatDate(row.received_at));
    setText(el.readerExpiry, row.expires_at ? formatDate(row.expires_at) : 'Six hours after import');
    // Email is untrusted. Plain text preserves content without executing HTML or loading trackers.
    setText(el.readerBody, row.body_text || 'This message has no text content.');
  }
  function openMessage(row) {
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) { renderFeed(); return; }
    selectedId = rowId(row);
    fillReader(row);
    el.reader.showModal();
    el.reader.scrollTop = 0;
  }
  function renderFeed() {
    const focusedId = el.list.contains(document.activeElement) ? document.activeElement.dataset.messageId : null;
    rows = uniqueVisible(rows);
    el.list.replaceChildren();
    setText(el.count, rows.length ? `${rows.length} message${rows.length === 1 ? '' : 's'}` : '');
    if (!rows.length) message(el.feedStatus, 'Your public inbox is empty. New Gmail messages will appear here automatically after sync.', 'empty');
    else {
      message(el.feedStatus, '');
      rows.forEach(row => {
        const name = senderName(row.sender);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'gmail-message-row';
        button.dataset.messageId = rowId(row);
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'gmail-reader');
        const avatar = document.createElement('span'); avatar.className = 'gmail-avatar'; avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = Array.from(name)[0].toUpperCase();
        let color = 0; for (const char of name) color = (color + char.charCodeAt(0)) % 5;
        avatar.dataset.color = String(color);
        const content = document.createElement('span'); content.className = 'gmail-row-content';
        const top = document.createElement('span'); top.className = 'gmail-row-top';
        const sender = document.createElement('span'); sender.className = 'gmail-row-sender'; sender.textContent = name; sender.title = row.sender || name;
        const date = document.createElement('time'); date.className = 'gmail-row-date'; date.textContent = shortDate(row.received_at); date.title = formatDate(row.received_at);
        if (!Number.isNaN(Date.parse(row.received_at))) date.dateTime = new Date(row.received_at).toISOString();
        const subject = document.createElement('span'); subject.className = 'gmail-row-subject'; subject.textContent = row.subject || '(No subject)';
        const snippet = document.createElement('span'); snippet.className = 'gmail-row-snippet'; snippet.textContent = String(row.body_text || 'No text content').replace(/\s+/g, ' ').trim().slice(0, 180);
        top.append(sender, date); content.append(top, subject, snippet); button.append(avatar, content);
        button.addEventListener('click', () => openMessage(row)); el.list.append(button);
      });
    }
    el.load.hidden = !hasMore;
    if (focusedId) Array.from(el.list.children).find(node => node.dataset.messageId === focusedId)?.focus({ preventScroll: true });
    if (el.reader.open) {
      const selected = rows.find(row => rowId(row) === selectedId);
      if (selected) fillReader(selected);
      else { el.reader.close(); message(el.feedStatus, 'That message is no longer available. Messages expire six hours after import.'); }
    }
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
  el.readerClose.addEventListener('click', () => el.reader.close());
  el.reader.addEventListener('close', () => {
    const previousId = selectedId; selectedId = null; el.readerBody.textContent = '';
    Array.from(el.list.children).find(node => node.dataset.messageId === previousId)?.focus({ preventScroll: true });
  });
  // Enforce expiry locally even when the network is unavailable.
  setInterval(() => { if (rows.some(row => row.expires_at && Date.parse(row.expires_at) <= Date.now())) renderFeed(); }, 1000);
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

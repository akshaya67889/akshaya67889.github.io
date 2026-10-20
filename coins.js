(() => {
  'use strict';
  const config = window.POLLPE_CONFIG || {};
  const base = String(config.url || '').replace(/\/$/, '');
  const $ = id => document.getElementById(id);
  const email = $('coins-email'), yesterday = $('coins-yesterday'), credited = $('coins-credited'), total = $('coins-total');
  const submit = $('coins-submit'), lookup = $('coins-lookup'), editBalance = $('coins-edit-balance');
  const accountStatus = $('coins-account-status'), status = $('coins-status');
  let context = null, contextEmail = '', lookupVersion = 0, saving = false, baselineUnlocked = false;
  let historyOffset = 0, historyBusy = false, historyLoaded = false;
  let historyRequest = 0, historyController = null, searchTimer = null;
  const normalizedEmail = () => email.value.trim().toLowerCase();
  const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const whole = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
  const headers = () => ({ apikey: config.key, Accept: 'application/json', 'Content-Type': 'application/json' });
  const number = value => Number(value).toLocaleString();
  function message(text, error = false) { status.textContent = text; status.className = `form-status${error ? ' error' : ''}`; }
  async function rpc(name, body) {
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 400 || response.status === 409 ? 'The balance or day may have changed. Load the account again and check your entry.' : `Could not connect (${response.status}). Please try again.`);
    return response.json();
  }
  function setBaselineEditing(unlocked) {
    baselineUnlocked = Boolean(unlocked) && Boolean(context) && !saving;
    yesterday.readOnly = !baselineUnlocked;
    editBalance.disabled = !context || saving;
    editBalance.textContent = baselineUnlocked ? 'Lock starting balance' : 'Edit starting balance';
    editBalance.setAttribute('aria-pressed', String(baselineUnlocked));
  }
  function invalidate() {
    lookupVersion += 1; context = null; contextEmail = ''; baselineUnlocked = false;
    yesterday.value = ''; yesterday.readOnly = true; credited.value = ''; credited.disabled = true;
    total.value = ''; submit.disabled = true; editBalance.disabled = true; editBalance.textContent = 'Edit starting balance'; editBalance.setAttribute('aria-pressed', 'false');
    accountStatus.textContent = 'Enter an email and load its current balance.';
    if (!saving) lookup.disabled = false;
  }
  function calculate() {
    const valid = context && contextEmail === normalizedEmail() && whole(yesterday.value) && whole(credited.value);
    const sum = valid ? Number(yesterday.value) + Number(credited.value) : NaN;
    total.value = Number.isSafeInteger(sum) ? String(sum) : '';
    submit.disabled = saving || !Number.isSafeInteger(sum);
  }
  async function loadAccount() {
    if (saving) return;
    const value = normalizedEmail();
    invalidate(); message('');
    if (!validEmail(value)) { accountStatus.textContent = 'Enter a valid PollPe account email address.'; return; }
    const version = lookupVersion;
    lookup.disabled = true; accountStatus.textContent = 'Loading the current balance…';
    try {
      const result = await rpc('pollpe_coin_context', { p_email: value });
      if (version !== lookupVersion || value !== normalizedEmail()) return;
      context = result; contextEmail = value;
      yesterday.value = String(result.yesterday_coins);
      credited.disabled = false;
      const existing = result.today_entry;
      credited.value = existing ? String(existing.credited_today) : '';
      total.value = existing ? String(existing.total_today) : '';
      setBaselineEditing(!result.has_history && !existing);
      accountStatus.textContent = `Tracking day: ${result.tracking_date} (India time). ` + (existing ? `Already saved today: ${number(existing.credited_today)} credited; ${number(existing.total_today)} total. Edit the starting balance or credited amount to replace today's entry.` : result.has_history ? 'Current balance loaded. Enter the coins credited today, or edit the starting balance.' : 'New account: opening balance starts at 0. Set its starting balance if needed, then enter today’s credited coins.');
      calculate();
    } catch (error) {
      if (version === lookupVersion) { invalidate(); accountStatus.textContent = error.message; lookup.disabled = false; }
    } finally {
      if (version === lookupVersion) lookup.disabled = false;
    }
  }
  async function save(event) {
    event.preventDefault(); calculate();
    if (saving || submit.disabled || !context) return;
    const value = contextEmail, expected = context;
    saving = true; submit.disabled = true; lookup.disabled = true; email.disabled = true; credited.disabled = true; setBaselineEditing(false);
    message('Saving publicly…');
    try {
      const row = await rpc('pollpe_save_coins', { p_email: value, p_credited: Number(credited.value), p_opening_balance: Number(yesterday.value), p_expected_date: expected.tracking_date, p_expected_yesterday: Number(expected.yesterday_coins) });
      context = { ...expected, yesterday_coins: row.yesterday_coins, has_history: true, today_entry: row };
      yesterday.value = String(row.yesterday_coins); credited.value = String(row.credited_today); total.value = String(row.total_today);
      accountStatus.textContent = `Saved for ${row.tracking_date} (India time): ${number(row.credited_today)} credited; ${number(row.total_today)} total. You can edit the starting balance or credited amount and save a replacement.`;
      message('Coin balance saved publicly.');
      window.dispatchEvent(new CustomEvent('pollpe:coins-saved'));
      await loadHistory(false, true);
    } catch (error) { message(error.message, true); invalidate(); }
    finally {
      saving = false; lookup.disabled = false; email.disabled = false;
      if (context) { credited.disabled = false; setBaselineEditing(false); }
      else { credited.disabled = true; editBalance.disabled = true; }
      calculate();
    }
  }
  function renderEntry(row) {
    const card = document.createElement('article'); card.className = 'mail-card';
    const title = document.createElement('h4'); title.className = 'mail-meta'; title.textContent = row.email_address;
    const day = document.createElement('p'); day.className = 'timestamp-note'; day.textContent = `Last tracking day: ${row.tracking_date} (India time)`;
    const values = document.createElement('dl'); values.className = 'coin-values';
    [['Total coins yesterday', row.yesterday_coins], ['Coins credited today', row.credited_today], ['Total coins today', row.total_today]].forEach(([label, value]) => {
      const group = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = number(value); group.append(dt, dd); values.append(group);
    });
    const timestamp = document.createElement('p'); timestamp.className = 'timestamp-note'; timestamp.textContent = `Last saved: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(row.updated_at))} (India time)`;
    const actions = document.createElement('div'); actions.className = 'form-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button button-quiet'; edit.textContent = 'Edit balance';
    edit.addEventListener('click', () => { if (saving) return; email.value = row.email_address; loadAccount().then(() => { $('coins-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); email.focus(); }); });
    actions.append(edit); card.append(title, day, values, timestamp, actions); $('coins-list').append(card);
  }
  function escapeIlike(value) {
    // PostgREST uses * as the wildcard alias for %, while \, %, and _ have
    // pattern meaning. Escape them before URLSearchParams encodes the query.
    return value.replace(/\\/g, '\\').replace(/[\%_*]/g, char => `\${char}`).replace(/"/g, '\"');
  }
  function searchValue() { return $('coins-email-filter').value.trim(); }
  async function loadHistory(append = false, force = false) {
    if (historyBusy && !force) return;
    if (historyController) historyController.abort();
    const request = ++historyRequest;
    const controller = new AbortController(); historyController = controller;
    historyBusy = true;
    const listStatus = $('coins-list-status'), more = $('coins-load-more');
    const filter = searchValue();
    if (!append) { historyOffset = 0; $('coins-list').replaceChildren(); }
    listStatus.className = 'status'; listStatus.textContent = 'Loading current balances…'; more.hidden = true; more.disabled = true;
    try {
      const params = new URLSearchParams({ select: 'id,email_address,tracking_date,yesterday_coins,credited_today,total_today,created_at,updated_at', order: 'tracking_date.desc,updated_at.desc,id.desc', limit: '50', offset: String(historyOffset) });
      if (filter) params.set('email_address', `ilike.*${escapeIlike(filter)}*`);
      const response = await fetch(`${base}/rest/v1/pollpe_coin_entries?${params}`, { headers: headers(), signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load current balances (${response.status}). Use Refresh balances to retry.`);
      const rows = await response.json();
      if (request !== historyRequest) return;
      rows.forEach(renderEntry); historyOffset += rows.length; historyLoaded = true;
      listStatus.textContent = historyOffset ? '' : (filter ? 'No current balance matches that email search.' : 'No current balances saved yet. Add the first account above.');
      listStatus.className = historyOffset ? 'status' : 'status empty'; more.hidden = rows.length < 50; more.disabled = false;
    } catch (error) {
      if (error.name === 'AbortError' || request !== historyRequest) return;
      listStatus.className = 'status error'; listStatus.textContent = error.message; more.disabled = false;
    } finally {
      if (request === historyRequest) { historyBusy = false; historyController = null; }
    }
  }
  email.addEventListener('input', () => { invalidate(); message(''); });
  $('coins-email-filter').addEventListener('input', () => {
    clearTimeout(searchTimer);
    // Invalidate the previous request immediately, not only when the debounce
    // fires. Otherwise an old response can paint stale rows during the 200ms
    // debounce window (or leave an aborted request marked busy).
    historyRequest += 1;
    if (historyController) historyController.abort();
    historyController = null;
    historyBusy = false;
    searchTimer = setTimeout(() => loadHistory(false, true), 200);
  });
  email.addEventListener('change', () => { if (validEmail(normalizedEmail())) loadAccount(); });
  lookup.addEventListener('click', loadAccount);
  editBalance.addEventListener('click', () => setBaselineEditing(!baselineUnlocked));
  yesterday.addEventListener('input', calculate); credited.addEventListener('input', calculate);
  $('coins-form').addEventListener('submit', save);
  $('coins-refresh').addEventListener('click', () => loadHistory(false, true));
  $('coins-load-more').addEventListener('click', () => loadHistory(true));
  function enterTab() { if (window.location.hash === '#coins' && !historyLoaded) loadHistory(false); }
  window.addEventListener('hashchange', enterTab); enterTab();
})();

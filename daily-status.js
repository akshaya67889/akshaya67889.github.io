(() => {
  'use strict';

  const config = window.POLLPE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/$/, '');
  const apiKey = String(config.key || '');
  const PAGE_SIZE = 100;
  const INDIA_TIME_ZONE = 'Asia/Kolkata';
  const REFRESH_MS = 60 * 1000;

  const state = {
    rows: [],
    request: 0,
    controller: null,
    timer: null,
    searchTimer: null,
    loaded: false,
    loading: false,
    day: '',
    clockOffset: 0,
    error: ''
  };

  const byId = id => document.getElementById(id);
  const els = {};

  function partsFor(date) {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: INDIA_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    return parts.reduce((result, part) => {
      if (part.type === 'year' || part.type === 'month' || part.type === 'day') result[part.type] = part.value;
      return result;
    }, {});
  }

  function indiaDate(date = new Date()) {
    const parts = partsFor(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function indiaDateFromServer(response) {
    const value = response.headers?.get('Date');
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function correctedNow() { return new Date(Date.now() + state.clockOffset); }

  function headers() {
    return { apikey: apiKey, Accept: 'application/json' };
  }

  function configured() {
    return Boolean(baseUrl && apiKey);
  }

  function active() {
    return document.visibilityState === 'visible' &&
      (window.location.hash === '#daily-status' || !els.section.hidden);
  }

  function setMessage(text, kind = '') {
    els.message.textContent = text;
    els.message.className = `daily-status-message${kind ? ` ${kind}` : ''}`;
  }

  function formatDate(value) {
    const parsed = new Date(`${value}T12:00:00+05:30`);
    return Number.isNaN(parsed.getTime()) ? `${value} · IST` :
      `${new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: INDIA_TIME_ZONE }).format(parsed)} · IST`;
  }

  function formatSubmission(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Last submission time unavailable.';
    return `Last submission: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: INDIA_TIME_ZONE }).format(parsed)} (India time)`;
  }

  function hasPositiveCredit(row) {
    const value = typeof row.credited_today === 'number' ? row.credited_today : Number(row.credited_today);
    return Number.isSafeInteger(value) && value > 0;
  }

  function completedToday(row) {
    return row.tracking_date === state.day && hasPositiveCredit(row);
  }

  function filteredRows() {
    const query = els.search.value.trim().toLocaleLowerCase();
    return query ? state.rows.filter(row => String(row.email_address || '').toLocaleLowerCase().includes(query)) : state.rows;
  }

  function render() {
    const rows = filteredRows();
    const completed = state.rows.filter(completedToday).length;
    els.date.textContent = state.day ? formatDate(state.day) : '';
    els.summary.textContent = state.rows.length ? `${completed} completed · ${state.rows.length - completed} pending · ${state.rows.length} emails` : '';
    els.list.replaceChildren();

    if (!state.rows.length) {
      setMessage(state.error || 'No current coin submissions yet.', state.error ? 'error' : 'empty');
      return;
    }
    if (!rows.length) {
      setMessage(state.error || 'No submissions match that email search.', state.error ? 'error' : 'empty');
      return;
    }
    setMessage(state.error, state.error ? 'error' : '');
    const fragment = document.createDocumentFragment();
    rows.forEach(row => {
      const item = document.createElement('article');
      item.className = 'daily-status-card';
      item.setAttribute('role', 'listitem');
      const heading = document.createElement('h3');
      heading.className = 'daily-status-email';
      heading.textContent = row.email_address || 'Email unavailable';
      const completed = completedToday(row);
      const badge = document.createElement('span');
      badge.className = `daily-status-badge ${completed ? 'is-completed' : 'is-pending'}`;
      badge.textContent = completed ? 'Completed' : 'Pending';
      badge.setAttribute('aria-label', completed ? 'Completed today' : 'Pending today');
      const note = document.createElement('p');
      note.className = 'daily-status-note';
      note.textContent = formatSubmission(row.updated_at);
      item.append(heading, badge, note);
      fragment.append(item);
    });
    els.list.append(fragment);
  }

  async function fetchAllRows(request, controller) {
    const rows = [];
    let offset = 0;
    let serverNow = null;
    let serverDay = '';
    while (true) {
      const params = new URLSearchParams({
        select: 'email_address,tracking_date,credited_today,updated_at',
        order: 'email_address.asc',
        limit: String(PAGE_SIZE),
        offset: String(offset)
      });
      const response = await fetch(`${baseUrl}/rest/v1/pollpe_coin_entries?${params}`, {
        headers: headers(), cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error('Could not load daily completion status. Please try again.');
      const responseDate = indiaDateFromServer(response);
      if (responseDate) {
        const pageDay = indiaDate(responseDate);
        if (!serverDay) serverDay = pageDay;
        if (serverDay !== pageDay) throw new Error('The India date changed while loading. Please refresh.');
        serverNow = responseDate;
        state.clockOffset = responseDate.getTime() - Date.now();
      }
      const page = await response.json();
      if (!Array.isArray(page)) throw new Error('Could not read daily completion status. Please try again.');
      rows.push(...page);
      offset += page.length;
      if (page.length < PAGE_SIZE) break;
    }
    const referenceNow = serverNow || correctedNow();
    const day = serverDay || indiaDate(referenceNow);
    return { rows, day };
  }

  async function load(force = false) {
    if (!active() || state.loading && !force || !configured()) {
      if (!configured() && active()) setMessage('Daily completion status is not configured.', 'error');
      return;
    }
    if (state.controller) state.controller.abort();
    const request = ++state.request;
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    els.refresh.disabled = true;
    setMessage('Loading daily completion status…');
    try {
      const result = await fetchAllRows(request, controller);
      if (request !== state.request || controller.signal.aborted) return;
      const nowDay = indiaDate(correctedNow());
      if (nowDay !== result.day) { await load(true); return; }
      state.rows = result.rows;
      state.day = result.day;
      state.error = '';
      state.loaded = true;
      render();
    } catch (error) {
      if (error.name === 'AbortError' || request !== state.request) return;
      state.error = error.message || 'Could not load daily completion status. Please try again.';
      setMessage(state.error, 'error');
    } finally {
      if (request === state.request) {
        state.loading = false;
        state.controller = null;
        els.refresh.disabled = false;
        scheduleMidnight();
      }
    }
  }

  function nextMidnightDelay() {
    const now = correctedNow();
    const midnight = Date.parse(`${indiaDate(now)}T00:00:00+05:30`) + 86400000;
    return Math.max(25, midnight - now.getTime() + 25);
  }

  function rollover() {
    const day = indiaDate(correctedNow());
    if (day === state.day) return;
    state.day = day;
    render();
  }

  function scheduleMidnight() {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      rollover();
      if (active()) load(true);
      scheduleMidnight();
    }, nextMidnightDelay());
  }

  function maybeRefresh() {
    rollover();
    scheduleMidnight();
    if (!active()) return;
    load(true);
  }

  function init() {
    els.section = byId('daily-status');
    els.date = byId('completion-date');
    els.summary = byId('completion-summary');
    els.search = byId('completion-search');
    els.refresh = byId('completion-refresh');
    els.message = byId('completion-message');
    els.list = byId('completion-list');
    if (Object.values(els).some(element => !element)) return;

    els.search.addEventListener('input', () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(render, 120);
    });
    els.refresh.addEventListener('click', () => load(true));
    window.addEventListener('hashchange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);
    const savedHandler = () => { if (active()) load(true); };
    window.addEventListener('pollpe:coins-saved', savedHandler);
    document.addEventListener('pollpe:coins-saved', savedHandler);
    window.setInterval(() => { rollover(); if (active()) load(true); }, REFRESH_MS);
    rollover();
    scheduleMidnight();
    if (active()) load();
  }

  window.PollPeDailyStatus = Object.freeze({ indiaDate, formatDate, hasPositiveCredit, completedToday });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

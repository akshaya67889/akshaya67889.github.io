(() => {
  'use strict';
  const config = window.POLLPE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/$/, '');
  const apiKey = config.key || '';
  const PAGE_SIZE = 100;
  let offset = 0;
  let hasMore = false;
  let allLoaded = [];
  let editingId = null;
  let isBusy = false;
  let publishingKey = '';
  let unlockAttempt = 0;
  let mailOffset = 0;
  let mailHasMore = false;
  let mailRows = [];
  const answerSelections = new Map();

  const $ = (id) => document.getElementById(id);
  const els = { list: $('poll-list'), status: $('archive-status'), count: $('result-count'), load: $('load-more'), today: $('today-date'), admin: $('admin-panel'), adminToggle: $('admin-toggle'), adminClose: $('admin-close'), form: $('poll-form'), key: $('publishing-key'), date: $('poll-date'), question: $('poll-question'), options: $('poll-options'), selected: $('poll-selected'), note: $('poll-note'), publish: $('publish-button'), cancel: $('cancel-edit'), formStatus: $('form-status'), dialog: $('unlock-dialog'), unlockForm: $('unlock-form'), unlockButton: $('unlock-button'), unlockStatus: $('unlock-status'), mailForm: $('mail-form'), mailEmail: $('mail-email'), mailContent: $('mail-content'), mailSubmit: $('mail-submit'), mailStatus: $('mail-status'), mailList: $('mail-list'), mailListStatus: $('mail-list-status'), mailCount: $('mail-count'), mailLoad: $('mail-load-more') };

  function setStatus(text, kind = '') { els.status.textContent = text; els.status.className = `status ${kind}`.trim(); }
  function setFormStatus(text, kind = '') { els.formStatus.textContent = text; els.formStatus.className = `form-status ${kind}`.trim(); }
  function headers(extra = {}) { return Object.assign({ apikey: apiKey, Accept: 'application/json' }, extra); }
  function configured() { return Boolean(baseUrl && apiKey); }
  function formatDate(value) { const date = new Date(`${value}T12:00:00`); return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date); }
  function localToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  let displayedDay = localToday();
  let pollRequest = 0;
  let rolloverTimer;
  function syncDayLabel() { els.today.textContent = `${formatDate(displayedDay)} · IST`; }
  function formatMailTimestamp(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
  function optionValues() { return els.options.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
  function syncSelected() { const values = optionValues(); const old = Number(els.selected.value); els.selected.textContent = ''; if (values.length < 2) { els.selected.disabled = true; const opt = document.createElement('option'); opt.textContent = 'Add at least two options'; opt.value = ''; els.selected.append(opt); return; } els.selected.disabled = false; values.forEach((value, i) => { const opt = document.createElement('option'); opt.value = String(i); opt.textContent = value; els.selected.append(opt); }); els.selected.value = String(Math.min(Number.isInteger(old) ? old : 0, values.length - 1)); }

  async function fetchPolls(append = false) {
    if (!configured()) { setStatus('Add your Supabase URL and public key in config.js to load today’s questions.', 'error'); return; }
    const day = localToday(); const request = ++pollRequest;
    if (day !== displayedDay) { append = false; displayedDay = day; answerSelections.clear(); }
    syncDayLabel();
    if (!append) { offset = 0; allLoaded = []; els.list.replaceChildren(); }
    setStatus('Loading today’s questions…'); els.load.hidden = true;
    try {
      const params = new URLSearchParams({ select: 'id,poll_date,question,options,selected_option,note,updated_at', order: 'poll_date.desc,created_at.desc', limit: String(PAGE_SIZE), offset: String(offset) });
      params.set('poll_date', 'eq.' + day);
      const response = await fetch(`${baseUrl}/rest/v1/pollpe_polls?${params}`, { headers: headers() });
      if (!response.ok) throw new Error(`Question request failed (${response.status}).`);
      const rows = await response.json();
      if (request !== pollRequest) return;
      if (day !== localToday()) { await refreshDay(); return; }
      allLoaded = append ? allLoaded.concat(rows) : rows; offset += rows.length; hasMore = rows.length === PAGE_SIZE; render();
    } catch (error) { if (request === pollRequest) setStatus(error.message || "Could not load today’s questions. Please try again.", 'error'); }
  }

  function filteredRows() { return allLoaded.filter(row => row.poll_date === localToday()); }
  async function refreshDay() {
    const day = localToday();
    if (day === displayedDay) return;
    displayedDay = day; answerSelections.clear(); allLoaded = []; offset = 0; hasMore = false;
    resetForm(); syncDayLabel(); render();
    await fetchPolls(false);
  }
  function scheduleRollover() {
    clearTimeout(rolloverTimer);
    const now = Date.now();
    const midnight = Date.parse(`${localToday()}T00:00:00+05:30`) + 86400000;
    rolloverTimer = setTimeout(() => { refreshDay(); scheduleRollover(); }, Math.max(50, midnight - now + 50));
  }
  function render() {
    const rows = filteredRows(); els.list.replaceChildren(); els.count.textContent = rows.length ? `${rows.length} question${rows.length === 1 ? '' : 's'}` : '';
    if (!rows.length) { setStatus("No questions have been published for today (IST). Check back soon.", 'empty'); } else { setStatus(''); rows.forEach(renderCard); }
    els.load.hidden = !hasMore;
  }
  function renderCard(row) {
    const card = document.createElement('article'); card.className = 'poll-card';
    const date = document.createElement('div'); date.className = 'poll-card-date'; date.textContent = formatDate(row.poll_date); card.append(date);
    const question = document.createElement('h3'); question.textContent = row.question || ''; card.append(question);
    const choices = Array.isArray(row.options) ? row.options : [];
    const answers = document.createElement('fieldset'); answers.className = 'answer-list';
    const legend = document.createElement('legend'); legend.className = 'sr-only'; legend.textContent = `Choose one answer: ${row.question || 'Question'}`; answers.append(legend);
    const signature = JSON.stringify([choices, row.selected_option]);
    const previous = answerSelections.get(row.id);
    const publishedIndex = row.selected_option == null || row.selected_option === '' ? -1 : Number(row.selected_option);
    const selectedIndex = previous && previous.signature === signature ? previous.index : publishedIndex;
    choices.forEach((choice, index) => {
      const label = document.createElement('label'); label.className = 'answer';
      const input = document.createElement('input'); input.type = 'radio'; input.name = `answer-${row.id}`; input.value = String(index); input.checked = index === selectedIndex;
      const text = document.createElement('span'); text.className = 'answer-text'; text.textContent = choice;
      const tag = document.createElement('span'); tag.className = 'answer-tag'; tag.textContent = 'Selected'; tag.setAttribute('aria-hidden', 'true');
      label.classList.toggle('selected', input.checked); tag.hidden = !input.checked;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        answerSelections.set(row.id, { index, signature });
        answers.querySelectorAll('.answer').forEach(answer => {
          const checked = answer.querySelector('input').checked;
          answer.classList.toggle('selected', checked);
          answer.querySelector('.answer-tag').hidden = !checked;
        });
      });
      label.append(input, text, tag); answers.append(label);
    });
    card.append(answers);
    if (row.note) { const note = document.createElement('p'); note.className = 'poll-note'; note.textContent = row.note; card.append(note); }
    if (publishingKey && !els.admin.hidden) { const actions = document.createElement('div'); actions.className = 'card-actions'; const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.addEventListener('click', () => beginEdit(row)); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', () => deletePoll(row)); actions.append(edit, remove); card.append(actions); }
    els.list.append(card);
  }
  async function fetchMail(append = false) {
    if (!configured()) { els.mailListStatus.textContent = 'Add your Supabase URL and public key in config.js to load public mail.'; els.mailListStatus.className = 'status error'; return; }
    if (!append) { mailOffset = 0; mailRows = []; els.mailList.replaceChildren(); }
    els.mailListStatus.textContent = 'Loading public mail…'; els.mailListStatus.className = 'status'; els.mailLoad.hidden = true;
    try { const params = new URLSearchParams({ select: 'id,email_address,content,mail_timestamp,created_at', order: 'mail_timestamp.desc,created_at.desc,id.desc', limit: '50', offset: String(mailOffset) }); const response = await fetch(`${baseUrl}/rest/v1/pollpe_mail_posts?${params}`, { headers: headers() }); if (!response.ok) throw new Error(`Mail request failed (${response.status}).`); const rows = await response.json(); mailRows = append ? mailRows.concat(rows) : rows; mailOffset += rows.length; mailHasMore = rows.length === 50; renderMail(); } catch (error) { els.mailListStatus.textContent = error.message || 'Could not load public mail. Please try again.'; els.mailListStatus.className = 'status error'; }
  }
  function renderMail() {
    els.mailList.replaceChildren(); els.mailCount.textContent = mailRows.length ? `${mailRows.length} post${mailRows.length === 1 ? '' : 's'}` : '';
    if (!mailRows.length) { els.mailListStatus.textContent = 'No public mail has been submitted yet.'; els.mailListStatus.className = 'status empty'; } else { els.mailListStatus.textContent = ''; mailRows.forEach(row => { const card = document.createElement('article'); card.className = 'mail-card'; const meta = document.createElement('div'); meta.className = 'mail-meta'; meta.textContent = `${row.email_address || 'Anonymous'} · ${formatMailTimestamp(row.mail_timestamp)}`; const content = document.createElement('p'); content.className = 'mail-content'; content.textContent = row.content || ''; card.append(meta, content); els.mailList.append(card); }); }
    els.mailLoad.hidden = !mailHasMore;
  }
  async function submitMail(event) {
    event.preventDefault(); if (els.mailSubmit.disabled) return; const email = els.mailEmail.value.trim(); const content = els.mailContent.value;
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { els.mailStatus.textContent = 'Enter a valid email address (254 characters maximum).'; els.mailStatus.className = 'form-status error'; els.mailEmail.focus(); return; }
    if (!content.trim() || content.length > 20000) { els.mailStatus.textContent = 'Enter content (20,000 characters maximum).'; els.mailStatus.className = 'form-status error'; els.mailContent.focus(); return; }
    els.mailSubmit.disabled = true; els.mailStatus.className = 'form-status'; els.mailStatus.textContent = 'Publishing publicly…';
    try { const response = await fetch(`${baseUrl}/rest/v1/pollpe_mail_posts`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify({ email_address: email, content }) }); if (!response.ok) throw new Error(`Submission failed (${response.status}).`); els.mailForm.reset(); els.mailStatus.textContent = 'Published publicly.'; await fetchMail(false); } catch (error) { els.mailStatus.textContent = error.message || 'Could not publish. Please try again.'; els.mailStatus.className = 'form-status error'; } finally { els.mailSubmit.disabled = false; }
  }
  function beginEdit(row) { if (!publishingKey) return; if (row.poll_date !== localToday()) { refreshDay(); return; } editingId = row.id; els.date.value = row.poll_date || ''; els.question.value = row.question || ''; els.options.value = (Array.isArray(row.options) ? row.options : []).join('\n'); syncSelected(); els.selected.value = String(row.selected_option ?? 0); els.note.value = row.note || ''; els.publish.textContent = 'Save changes'; els.cancel.hidden = false; els.form.scrollIntoView({ behavior: 'smooth', block: 'start' }); setFormStatus('Editing this question.'); }
  function resetForm() { editingId = null; els.form.reset(); els.date.value = localToday(); syncSelected(); els.publish.textContent = 'Publish question'; els.cancel.hidden = true; setFormStatus(''); }
  async function publish(event) { event.preventDefault(); if (isBusy) return; if (!publishingKey) { openUnlock(); return; } if (els.date.value !== localToday()) { refreshDay(); setFormStatus('The India date has changed. Please publish for today.', 'error'); return; } const values = optionValues(); if ( !els.date.value || !els.question.value.trim() || values.length < 2 || values.length > 6 || els.selected.value === '' || !Number.isInteger(Number(els.selected.value)) || Number(els.selected.value) < 0 || Number(els.selected.value) >= values.length) { setFormStatus('Please complete the date, question, and 2–6 options.', 'error'); return; } isBusy = true; els.publish.disabled = true; setFormStatus(editingId ? 'Saving…' : 'Publishing…'); const body = { p_key: publishingKey, p_id: editingId, p_date: els.date.value, p_question: els.question.value.trim(), p_options: values, p_selected: Number(els.selected.value), p_note: els.note.value.trim() };
    try { const response = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_publish`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(body) }); if (!response.ok) throw new Error('Publishing failed. Check the key and try again.'); resetForm(); setFormStatus('Published successfully.'); await fetchPolls(false); } catch (error) { setFormStatus(error.message || 'Could not publish. Please try again.', 'error'); } finally { isBusy = false; els.publish.disabled = false; }
  }
  async function deletePoll(row) { if (!publishingKey || isBusy || !window.confirm(`Delete the question from ${formatDate(row.poll_date)}? This cannot be undone.`)) return; const key = publishingKey; isBusy = true; setFormStatus('Deleting…'); try { const response = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_delete`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_key: key, p_id: row.id }) }); if (!response.ok) throw new Error('Delete failed. Check the key and try again.'); if (editingId === row.id) resetForm(); setFormStatus('Deleted.'); await fetchPolls(false); } catch (error) { setFormStatus(error.message || 'Could not delete. Please try again.', 'error'); } finally { isBusy = false; } }
  function lockAdmin() {
    publishingKey = ''; unlockAttempt += 1; els.key.value = '';
    els.admin.hidden = true; els.adminToggle.setAttribute('aria-expanded', 'false');
    els.adminToggle.setAttribute('aria-label', 'Unlock admin'); els.adminToggle.title = 'Unlock admin';
    resetForm(); render();
  }
  function closeUnlock() {
    unlockAttempt += 1; els.key.value = ''; els.unlockButton.disabled = false;
    els.unlockButton.textContent = 'Unlock'; els.unlockStatus.textContent = '';
    if (els.dialog.open) els.dialog.close();
  }
  function openUnlock() {
    if (publishingKey) { lockAdmin(); return; }
    activateTab('archive');
    if (window.location.hash !== '#archive') window.location.hash = 'archive';
    els.unlockStatus.textContent = ''; els.key.value = '';
    els.dialog.showModal(); els.key.focus();
  }
  async function unlockAdmin(event) {
    event.preventDefault();
    if (els.unlockButton.disabled) return;
    const candidate = els.key.value;
    if (!candidate.trim()) { els.unlockStatus.textContent = 'Enter your admin password.'; els.key.focus(); return; }
    const attempt = ++unlockAttempt;
    els.unlockButton.disabled = true; els.unlockButton.textContent = 'Checking…';
    els.unlockStatus.className = 'form-status'; els.unlockStatus.textContent = 'Checking your key…';
    try {
      const response = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_admin_unlock`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_password: candidate }) });
      const token = response.ok ? await response.json() : null;
      const accepted = typeof token === 'string' && token.length >= 32;
      if (attempt !== unlockAttempt || !els.dialog.open) return;
      if (!accepted) { els.unlockStatus.className = 'form-status error'; els.unlockStatus.textContent = 'Could not unlock. Check your admin password and try again.'; els.key.value = ''; els.key.focus(); return; }
      publishingKey = token; closeUnlock(); resetForm();
      els.admin.hidden = false; els.adminToggle.setAttribute('aria-expanded', 'true');
      els.adminToggle.setAttribute('aria-label', 'Lock admin'); els.adminToggle.title = 'Lock admin';
      render(); els.admin.scrollIntoView({ behavior: 'smooth', block: 'start' }); els.date.focus({ preventScroll: true });
    } catch (_) {
      if (attempt === unlockAttempt) { els.unlockStatus.className = 'form-status error'; els.unlockStatus.textContent = 'Unable to check your key. Please try again.'; }
    } finally {
      if (attempt === unlockAttempt) { els.unlockButton.disabled = false; els.unlockButton.textContent = 'Unlock'; }
    }
  }
  els.unlockForm.addEventListener('submit', unlockAdmin);
  $('unlock-close').addEventListener('click', closeUnlock);
  $('unlock-cancel').addEventListener('click', closeUnlock);
  els.dialog.addEventListener('cancel', event => { event.preventDefault(); closeUnlock(); });
  window.addEventListener('pagehide', () => { closeUnlock(); lockAdmin(); });

  els.options.addEventListener('input', syncSelected); els.form.addEventListener('submit', publish); els.cancel.addEventListener('click', resetForm); els.adminToggle.addEventListener('click', openUnlock); els.adminClose.addEventListener('click', () => { lockAdmin(); els.adminToggle.focus(); }); els.load.addEventListener('click', () => fetchPolls(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshDay(); scheduleRollover(); } });
  window.addEventListener('focus', () => { refreshDay(); scheduleRollover(); });
  els.mailForm.addEventListener('submit', submitMail); els.mailLoad.addEventListener('click', () => fetchMail(true));
  const tabLinks = [...document.querySelectorAll('.tab-link')]; const panels = { archive: $('archive'), mail: $('mail'), coins: $('coins') };
  function activateTab(name, focus = false) { const selected = Object.hasOwn(panels, name) ? name : 'archive'; if (selected !== 'archive' && publishingKey) lockAdmin(); tabLinks.forEach(tab => { const active = tab.id === `${selected}-tab`; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; }); Object.entries(panels).forEach(([key, panel]) => { panel.hidden = key !== selected; }); if (selected === 'mail' && !mailRows.length) fetchMail(false); if (focus) document.getElementById(`${selected}-tab`).focus(); }
  function hashTab() { activateTab(window.location.hash.slice(1)); }
  tabLinks.forEach((tab, index) => tab.addEventListener('keydown', event => { let next = null; if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = tabLinks[(index + 1) % tabLinks.length]; if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = tabLinks[(index - 1 + tabLinks.length) % tabLinks.length]; if (event.key === 'Home') next = tabLinks[0]; if (event.key === 'End') next = tabLinks[tabLinks.length - 1]; if (next) { event.preventDefault(); if (window.location.hash !== next.hash) window.addEventListener('hashchange', () => next.focus({ preventScroll: true }), { once: true }); next.focus(); next.click(); } }));
  window.addEventListener('hashchange', hashTab); els.date.value = localToday(); syncSelected(); syncDayLabel(); scheduleRollover(); hashTab(); fetchPolls(false);
})();

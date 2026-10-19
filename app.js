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
  const answerSelections = new Map();

  const $ = (id) => document.getElementById(id);
  const els = { list: $('poll-list'), status: $('archive-status'), count: $('result-count'), load: $('load-more'), search: $('search-input'), month: $('month-input'), clear: $('clear-filters'), admin: $('admin-panel'), adminToggle: $('admin-toggle'), adminClose: $('admin-close'), form: $('poll-form'), key: $('publishing-key'), date: $('poll-date'), question: $('poll-question'), options: $('poll-options'), selected: $('poll-selected'), note: $('poll-note'), publish: $('publish-button'), cancel: $('cancel-edit'), formStatus: $('form-status'), dialog: $('unlock-dialog'), unlockForm: $('unlock-form'), unlockButton: $('unlock-button'), unlockStatus: $('unlock-status') };

  function setStatus(text, kind = '') { els.status.textContent = text; els.status.className = `status ${kind}`.trim(); }
  function setFormStatus(text, kind = '') { els.formStatus.textContent = text; els.formStatus.className = `form-status ${kind}`.trim(); }
  function headers(extra = {}) { return Object.assign({ apikey: apiKey, Accept: 'application/json' }, extra); }
  function configured() { return Boolean(baseUrl && apiKey); }
  function formatDate(value) { const date = new Date(`${value}T12:00:00`); return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date); }
  function localToday() { const d = new Date(); const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function optionValues() { return els.options.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean); }
  function syncSelected() { const values = optionValues(); const old = Number(els.selected.value); els.selected.textContent = ''; if (values.length < 2) { els.selected.disabled = true; const opt = document.createElement('option'); opt.textContent = 'Add at least two options'; opt.value = ''; els.selected.append(opt); return; } els.selected.disabled = false; values.forEach((value, i) => { const opt = document.createElement('option'); opt.value = String(i); opt.textContent = value; els.selected.append(opt); }); els.selected.value = String(Math.min(Number.isInteger(old) ? old : 0, values.length - 1)); }

  async function fetchPolls(append = false) {
    if (!configured()) { setStatus('Add your Supabase URL and public key in config.js to load the archive.', 'error'); return; }
    if (!append) { offset = 0; allLoaded = []; els.list.replaceChildren(); }
    setStatus('Loading the archive…'); els.load.hidden = true;
    try {
      const params = new URLSearchParams({ select: 'id,poll_date,question,options,selected_option,note,updated_at', order: 'poll_date.desc,created_at.desc', limit: String(PAGE_SIZE), offset: String(offset) });
      if (els.month.value) params.set('poll_date', 'eq.' + els.month.value);
      if (els.search.value.trim()) params.set('question', 'ilike.' + '*' + els.search.value.trim().replace(/[\\%_*]/g, '\\$&') + '*');
      const response = await fetch(`${baseUrl}/rest/v1/pollpe_polls?${params}`, { headers: headers() });
      if (!response.ok) throw new Error(`Archive request failed (${response.status}).`);
      const rows = await response.json(); allLoaded = append ? allLoaded.concat(rows) : rows; offset += rows.length; hasMore = rows.length === PAGE_SIZE; render();
    } catch (error) { setStatus(error.message || 'Could not load the archive. Please try again.', 'error'); }
  }

  function filteredRows() { const query = els.search.value.trim().toLowerCase(); const month = els.month.value; return allLoaded.filter(row => (!query || String(row.question || '').toLowerCase().includes(query)) && (!month || String(row.poll_date || '').startsWith(month))); }
  function render() {
    const rows = filteredRows(); els.list.replaceChildren(); els.count.textContent = rows.length ? `${rows.length} question${rows.length === 1 ? '' : 's'}` : '';
    if (!rows.length) { setStatus(allLoaded.length ? 'No questions match those filters.' : 'No questions have been published yet. Check back soon.', 'empty'); } else { setStatus(''); rows.forEach(renderCard); }
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
  function beginEdit(row) { if (!publishingKey) return; editingId = row.id; els.date.value = row.poll_date || ''; els.question.value = row.question || ''; els.options.value = (Array.isArray(row.options) ? row.options : []).join('\n'); syncSelected(); els.selected.value = String(row.selected_option ?? 0); els.note.value = row.note || ''; els.publish.textContent = 'Save changes'; els.cancel.hidden = false; els.form.scrollIntoView({ behavior: 'smooth', block: 'start' }); setFormStatus('Editing this question.'); }
  function resetForm() { editingId = null; els.form.reset(); els.date.value = localToday(); syncSelected(); els.publish.textContent = 'Publish question'; els.cancel.hidden = true; setFormStatus(''); }
  async function publish(event) { event.preventDefault(); if (isBusy) return; if (!publishingKey) { openUnlock(); return; } const values = optionValues(); if ( !els.date.value || !els.question.value.trim() || values.length < 2 || values.length > 6 || els.selected.value === '' || !Number.isInteger(Number(els.selected.value)) || Number(els.selected.value) < 0 || Number(els.selected.value) >= values.length) { setFormStatus('Please complete the date, question, and 2–6 options.', 'error'); return; } isBusy = true; els.publish.disabled = true; setFormStatus(editingId ? 'Saving…' : 'Publishing…'); const body = { p_key: publishingKey, p_id: editingId, p_date: els.date.value, p_question: els.question.value.trim(), p_options: values, p_selected: Number(els.selected.value), p_note: els.note.value.trim() };
    try { const response = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_publish`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(body) }); if (!response.ok) throw new Error('Publishing failed. Check the key and try again.'); resetForm(); setFormStatus('Published successfully.'); await fetchPolls(false); } catch (error) { setFormStatus(error.message || 'Could not publish. Please try again.', 'error'); } finally { isBusy = false; els.publish.disabled = false; }
  }
  async function deletePoll(row) { if (!publishingKey || isBusy || !window.confirm(`Delete the question from ${formatDate(row.poll_date)}? This cannot be undone.`)) return; const key = publishingKey; isBusy = true; setFormStatus('Deleting…'); try { const response = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_delete`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_key: key, p_id: row.id }) }); if (!response.ok) throw new Error('Delete failed. Check the key and try again.'); setFormStatus('Deleted.'); await fetchPolls(false); } catch (error) { setFormStatus(error.message || 'Could not delete. Please try again.', 'error'); } finally { isBusy = false; } }
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
    els.unlockStatus.textContent = ''; els.key.value = '';
    els.dialog.showModal(); els.key.focus();
  }
  async function unlockAdmin(event) {
    event.preventDefault();
    if (els.unlockButton.disabled) return;
    const candidate = els.key.value;
    if (!candidate.trim()) { els.unlockStatus.textContent = 'Enter your publishing key.'; els.key.focus(); return; }
    const attempt = ++unlockAttempt;
    els.unlockButton.disabled = true; els.unlockButton.textContent = 'Checking…';
    els.unlockStatus.className = 'form-status'; els.unlockStatus.textContent = 'Checking your key…';
    try {
      const response = await fetch(`${baseUrl}/rest/v1/rpc/pollpe_unlock`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_key: candidate }) });
      const accepted = response.ok && await response.json() === true;
      if (attempt !== unlockAttempt || !els.dialog.open) return;
      if (!accepted) { els.unlockStatus.className = 'form-status error'; els.unlockStatus.textContent = 'Could not unlock. Check your publishing key and try again.'; els.key.value = ''; els.key.focus(); return; }
      publishingKey = candidate; closeUnlock(); resetForm();
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

  els.options.addEventListener('input', syncSelected); els.form.addEventListener('submit', publish); els.cancel.addEventListener('click', resetForm); els.adminToggle.addEventListener('click', openUnlock); els.adminClose.addEventListener('click', () => { lockAdmin(); els.adminToggle.focus(); }); let searchTimer; els.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => fetchPolls(false), 300); }); els.month.addEventListener('input', () => fetchPolls(false)); els.clear.addEventListener('click', () => { clearTimeout(searchTimer); els.search.value = ''; els.month.value = ''; fetchPolls(false); }); els.load.addEventListener('click', () => fetchPolls(true));
  $('filter-form').addEventListener('submit', e => e.preventDefault());
  els.date.value = localToday(); syncSelected(); fetchPolls(false);
})();

(() => {
  'use strict';

  const KEY = 'cityfix-citizen-reports-v1';
  const STATUSES = ['Received', 'Under review', 'Scheduled', 'Resolved', 'Not actionable'];
  const $ = (selector, root = document) => root.querySelector(selector);
  let reports = readReports();
  let filter = 'all';
  let search = '';
  let priorOverdue = null;
  let deskToastTimer = null;

  function readReports() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function writeReports() {
    try { localStorage.setItem(KEY, JSON.stringify(reports)); render(); return true; }
    catch (_) { alert('This browser could not save the update. Clear some browser storage and try again.'); return false; }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function safeDate(value, options = {}) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not set' : date.toLocaleString(undefined, options);
  }

  function localInputValue(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function statusClass(status) {
    return ({ 'Received': 'received', 'Under review': 'review', 'Scheduled': 'scheduled', 'Resolved': 'resolved', 'Not actionable': 'closed' })[status] || 'received';
  }

  function recordHistory(report, status, note, at = new Date().toISOString()) {
    if (!Array.isArray(report.history)) report.history = [];
    report.history.push({ status, at, note });
    report.updatedAt = at;
  }

  function render() {
    const filtered = [...reports].filter((report) => {
      const text = `${report.id} ${report.title} ${report.category} ${report.place} ${report.department} ${report.assignee}`.toLowerCase().replace(/_/g, ' ').replace(/\bzone\s+0+(\d+)/g, 'zone $1');
      const query = search.replace(/_/g, ' ').replace(/\bzone\s+0+(\d+)/g, 'zone $1');
      const queryTerms = query.split(/\s+/).filter(Boolean);
      const open = !['Resolved', 'Not actionable'].includes(report.status);
      const target = report.targetAt || new Date(new Date(report.createdAt || Date.now()).getTime() + suggestedHours(report.category) * 3600000).toISOString();
      const overdue = open && new Date(target).getTime() < Date.now();
      return (!queryTerms.length || queryTerms.every((term) => text.includes(term))) && (filter === 'all' || (filter === 'open' ? open : filter === 'overdue' ? overdue : report.status === filter));
    }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const openCount = reports.filter((report) => !['Resolved', 'Not actionable'].includes(report.status)).length;
    const overdueCount = reports.filter((report) => !['Resolved', 'Not actionable'].includes(report.status) && report.targetAt && new Date(report.targetAt).getTime() < Date.now()).length;
    if (priorOverdue !== null && overdueCount > priorOverdue) deskNotice(`${overdueCount - priorOverdue} complaint${overdueCount - priorOverdue === 1 ? '' : 's'} passed the target time.`);
    priorOverdue = overdueCount;
    const done = reports.filter((report) => report.status === 'Resolved' && report.resolvedAt);
    const avgHours = done.length ? Math.round(done.reduce((sum, report) => sum + Math.max(0, new Date(report.resolvedAt) - new Date(report.createdAt)) / 3600000, 0) / done.length) : null;
    $('#citizenInboxTotal').textContent = String(reports.length);
    $('#citizenInboxCount').textContent = String(openCount);
    $('#citizenInboxMetrics').innerHTML = `<div class="inbox-metric"><span>Open reports</span><strong>${openCount}</strong><small>Need a next step</small></div><div class="inbox-metric"><span>Past target</span><strong>${overdueCount}</strong><small>Review these first</small></div><div class="inbox-metric"><span>Resolved</span><strong>${done.length}</strong><small>${avgHours === null ? 'Resolution time appears here' : `Average ${avgHours < 24 ? `${avgHours}h` : `${(avgHours / 24).toFixed(1)} days`}`}</small></div>`;
    const list = $('#citizenReportList');
    if (!filtered.length) {
      list.innerHTML = `<div class="inbox-empty"><strong>${reports.length ? 'No reports match this view' : 'No citizen reports yet'}</strong><p>${reports.length ? 'Change the status or search filters to see more.' : 'Reports submitted from the citizen portal appear here on this browser.'}</p>${reports.length ? '<button class="button button-light" id="clearInboxFilters" type="button">Clear filters</button>' : ''}</div>`;
      $('#clearInboxFilters')?.addEventListener('click', () => { filter = 'all'; search = ''; $('#citizenStatusFilter').value = 'all'; $('#citizenReportSearch').value = ''; render(); });
      return;
    }
    list.innerHTML = filtered.map(renderReport).join('');
  }

  function renderReport(report) {
    const category = report.category || 'Other';
    const department = report.department || suggestedDepartment(category);
    const target = report.targetAt || new Date(new Date(report.createdAt || Date.now()).getTime() + suggestedHours(category) * 3600000).toISOString();
    const statusOptions = STATUSES.map((status) => `<option${status === report.status ? ' selected' : ''}>${status}</option>`).join('');
    const overdue = !['Resolved', 'Not actionable'].includes(report.status) && new Date(target).getTime() < Date.now();
    const resolution = report.status === 'Resolved' && report.resolvedAt ? `Resolved ${esc(safeDate(report.resolvedAt))}` : `${overdue ? 'Past target' : 'Target'} · ${esc(safeDate(target))}`;
    const history = Array.isArray(report.history) ? report.history.slice(-3).reverse() : [];
    return `<article class="admin-report-card" data-report="${esc(report.id)}">
      <div class="admin-report-summary"><div class="admin-report-heading"><div><span class="report-code">${esc(report.id)}</span><span class="report-status status-${statusClass(report.status)}">${esc(report.status || 'Received')}</span></div><small>${esc(safeDate(report.createdAt))}</small></div>
      <h3>${esc(report.title || category)}</h3><p class="admin-report-place">${esc(category)} · ${esc(report.place || 'Location not provided')}</p><p>${esc(report.description || '')}</p>
      <div class="admin-report-meta"><span>⌖ ${report.latitude && report.longitude ? `${Number(report.latitude).toFixed(5)}, ${Number(report.longitude).toFixed(5)}` : 'No map pin'}</span><span>${overdue ? '⚠ ' : ''}${resolution}</span></div>
      ${history.length ? `<div class="admin-recent-updates"><strong>Latest activity</strong>${history.map((item) => `<p><b>${esc(item.status || 'Update')}</b> · ${esc(item.note || '')} <time>${esc(safeDate(item.at))}</time></p>`).join('')}</div>` : ''}
      </div>
      <form class="admin-report-form" data-report-form="${esc(report.id)}">
        <div class="admin-form-grid"><label>Status<select name="status">${statusOptions}</select></label><label>Department<input name="department" maxlength="60" value="${esc(department)}" placeholder="e.g. Public Works"></label><label>Assigned staff<input name="assignee" list="assigneeOptions" maxlength="60" value="${esc(report.assignee || '')}" placeholder="Choose an owner"></label><label>Target completion<input name="targetAt" type="datetime-local" value="${esc(localInputValue(target))}"></label></div>
        <label>Update for the reporter<textarea name="publicUpdate" maxlength="420" rows="2" placeholder="Share the next action, timing, or resolution.">${esc(report.publicUpdate || '')}</textarea></label>
        <label>Internal staff note <span class="field-hint">Only stored in this demo; never shown to the reporter</span><textarea name="staffNote" maxlength="420" rows="2" placeholder="Handover details for the team.">${esc(report.staffNote || '')}</textarea></label>
        <div class="admin-form-foot"><span class="admin-save-status">${report.updatedAt ? `Last updated ${esc(safeDate(report.updatedAt))}` : 'No staff update yet'}</span><button class="button button-dark" type="submit">Save update</button></div>
      </form>
    </article>`;
  }

  function suggestedHours(category) {
    return ({ 'Signal failure': 12, 'Collision hazard': 24, Flooding: 24, 'Blocked drain': 48, 'Waste or sanitation': 48, Pothole: 72, 'Streetlight outage': 72 })[category] || 72;
  }

  function suggestedDepartment(category) {
    return ({ 'Blocked drain': 'Drainage', Flooding: 'Drainage', 'Streetlight outage': 'Electrical', 'Signal failure': 'Traffic', 'Collision hazard': 'Traffic', 'Waste or sanitation': 'Sanitation', Pothole: 'Public Works' })[category] || 'Unassigned';
  }

  function saveReport(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const report = reports.find((item) => item.id === form.dataset.reportForm);
    if (!report) return;
    const data = new FormData(form);
    const previousStatus = report.status || 'Received';
    const previousAssignee = report.assignee || '';
    const previousTarget = report.targetAt || '';
    const previousPublicUpdate = report.publicUpdate || '';
    const nextStatus = String(data.get('status') || previousStatus);
    const assignee = String(data.get('assignee') || '').trim();
    const targetInput = String(data.get('targetAt') || '');
    const publicUpdate = String(data.get('publicUpdate') || '').trim();
    const staffNote = String(data.get('staffNote') || '').trim();
    const now = new Date().toISOString();
    report.status = nextStatus;
    report.department = String(data.get('department') || '').trim() || 'Unassigned';
    report.assignee = assignee;
    report.targetAt = targetInput ? new Date(targetInput).toISOString() : '';
    report.publicUpdate = publicUpdate || (nextStatus === 'Resolved' ? 'This complaint has been marked as resolved.' : report.publicUpdate || '');
    report.staffNote = staffNote;
    if (nextStatus === 'Resolved') report.resolvedAt = report.resolvedAt || now;
    else if (previousStatus === 'Resolved') report.resolvedAt = null;
    const changes = [];
    if (nextStatus !== previousStatus) changes.push(`Status changed to ${nextStatus}.`);
    if (assignee !== previousAssignee) changes.push(assignee ? `Assigned to ${assignee}${report.department && report.department !== 'Unassigned' ? ` · ${report.department}` : ''}.` : 'Staff assignment cleared.');
    if (report.targetAt !== previousTarget) changes.push(report.targetAt ? `Target completion set for ${safeDate(report.targetAt)}.` : 'Target completion time cleared.');
    if (publicUpdate && publicUpdate !== previousPublicUpdate) changes.push(publicUpdate);
    if (changes.length) recordHistory(report, nextStatus, changes.join(' '), now);
    else report.updatedAt = now;
    if (writeReports()) {
      const saved = $(`[data-report="${CSS.escape(report.id)}"] .admin-save-status`);
      if (saved) saved.textContent = 'Saved just now';
    }
  }

  function navigateToInbox(nextFilter = 'all', query = '') {
    filter = nextFilter;
    search = query.toLowerCase();
    $('#citizenStatusFilter').value = nextFilter;
    $('#citizenReportSearch').value = query;
    location.hash = 'citizenInbox';
    $('#citizenInbox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    render();
  }

  function handleCommand(event) {
    event.preventDefault();
    const field = $('#adminCommand');
    const raw = field.value.trim();
    const q = raw.normalize('NFKC').toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9#\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    const result = $('#adminCommandResult');
    const say = (message) => { result.textContent = message; };
    const go = (id) => { location.hash = id; document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    if (!q) { say('Tell me what you want to open, filter, find, update, or export.'); field.focus(); return; }
    const code = raw.match(/\bCF-\d{4}-[A-Z0-9]{6}\b/i)?.[0]?.toUpperCase();
    const report = code ? reports.find((item) => item.id.toUpperCase() === code) : null;
    const zone = q.match(/\b(?:zone|ward)\s*#?\s*0*(\d{1,2})\b/);
    const issueRules = [
      ['Pothole', /\bpotholes?\b/], ['Blocked drain', /\bdrains?|sewers?\b/], ['Flooding', /\bflood(?:ing)?|waterlogging\b/],
      ['Streetlight outage', /\bstreet\s*lights?|lamps?\b/], ['Signal failure', /\bsignals?|traffic lights?\b/], ['Collision', /\bcollisions?|crashes?|accidents?\b/]
    ];
    const issueSelect = $('#issueFilter');
    const matchedRule = issueRules.find(([, pattern]) => pattern.test(q));
    const issueOption = matchedRule && [...issueSelect.options].find((option) => option.textContent === matchedRule[0]);
    const locationCode = raw.match(/\bL\d{3,5}\b/i)?.[0]?.toUpperCase();
    const sortRequest = /\b(sort|rank|order)\b/.test(q)
      || (/\b(show|list|display|open|find|go to|take me to)\b/.test(q) && /\b(?:top|highest|most|largest)\s+(?:(?:\d+)\s+)?(?:open|pending|unresolved|complaints?|citizen reports?|incidents?|severity|severe|critical|risk|priority|workload|backlog|forecast|locations?)\b/.test(q));
    const isQuestion = /\b(what|which|where|why|how many|how much|compare|highest|most|average|top)\b/.test(q);
    if (/\b(assign|give|send)\b/.test(q) && code) {
      if (!report) { navigateToInbox('all', code); say(`I couldn’t find ${code} in this browser. Check the code or open all reports.`); return; }
      const name = raw.match(/\bto\s+(.+?)(?:\s+(?:and|then)\s+.*)?$/i)?.[1]?.trim();
      if (!name) { navigateToInbox('all', code); $(`[data-report-form="${CSS.escape(report.id)}"] [name="assignee"]`)?.focus(); say(`Choose an assignee for ${report.id}, then save the update.`); return; }
      report.assignee = name;
      if (!report.department || report.department === 'Unassigned') report.department = suggestedDepartment(report.category);
      recordHistory(report, report.status || 'Received', `Assigned to ${name}${report.department !== 'Unassigned' ? ` · ${report.department}` : ''}.`);
      writeReports(); navigateToInbox('all', code); say(`${report.id} assigned to ${name}. The change is in its activity history.`); return;
    }
    if (code && /\b(resolve|resolved|complete|completed|close|mark done)\b/.test(q)) {
      if (!report) { navigateToInbox('all', code); say(`I couldn’t find ${code} in this browser.`); return; }
      const now = new Date().toISOString(); report.status = 'Resolved'; report.resolvedAt = now;
      report.publicUpdate = 'This complaint has been marked as resolved.';
      recordHistory(report, 'Resolved', report.publicUpdate, now);
      writeReports(); navigateToInbox('all', code); say(`${report.id} marked resolved. Its public status now shows the update.`); return;
    }
    const nextStatus = /\b(not actionable|invalid|duplicate)\b/.test(q) ? 'Not actionable'
      : /\b(scheduled|inspection booked)\b/.test(q) ? 'Scheduled'
      : /\b(under review|reviewing|being reviewed)\b/.test(q) ? 'Under review'
      : /\b(received|new report)\b/.test(q) ? 'Received' : '';
    if (code && nextStatus && /\b(status|mark|set|change|move|make|to)\b/.test(q)) {
      if (!report) { navigateToInbox('all', code); say(`I couldn’t find ${code} in this browser.`); return; }
      report.status = nextStatus;
      report.resolvedAt = null;
      report.publicUpdate = `Your report status is now ${nextStatus.toLowerCase()}.`;
      recordHistory(report, nextStatus, report.publicUpdate);
      writeReports(); navigateToInbox('all', code); say(`${report.id} updated to ${nextStatus}; the reporter can see the status update.`); return;
    }
    if (/\b(resolve|close|complete)\b/.test(q) && !code) {
      navigateToInbox('open'); $('#citizenReportSearch').focus(); say('Open reports are shown. Enter the report code to resolve the right one.'); return;
    }
    const requestedStatus = /\b(overdue|past target|late)\b/.test(q) ? 'overdue' : /\b(resolved|completed|fixed|closed)\b/.test(q) ? 'Resolved' : /\b(open|unresolved|active|pending)\b/.test(q) ? 'open' : 'all';
    if (code) {
      navigateToInbox('all', code);
      say(report ? `Showing ${report.id}; use its controls below to change status, assign staff, or set a target.` : `I couldn’t find ${code} in this browser. It may be saved on another device.`);
      return;
    }
    const createReportRequest = /\b(new|raise|file|submit|create|make|start|log)\b/.test(q) && /\b(complaint|report|issue|problem|pothole|drain|flood|streetlight|signal)\b/.test(q)
      || /^report\s+(?:a\s+|an\s+|the\s+)?(?:complaint|issue|problem|pothole|drain|flood|streetlight|signal)\b/.test(q);
    if (createReportRequest) {
      say('Opening the citizen report form.'); location.href = 'citizen.html#reportIssue'; return;
    }
    if (/\b(export|download)\b/.test(q)) {
      const button = /\b(log|decision|review)\b/.test(q) ? $('#exportActions') : $('#exportTop');
      button.click(); say(/\b(log|decision|review)\b/.test(q) ? 'Review log downloaded.' : 'Priority queue downloaded.'); return;
    }
    if (/\b(trends?|signals?|monthly reports?)\b/.test(q)) { go('signals'); say('Opened Signals & trends.'); return; }
    if (/\b(scoring|score method|scoring method|how is.*rank|why.*rank)\b/.test(q)) { go('method'); $('#methodButton').click(); say('Opened the scoring method and details.'); return; }
    if (/\b(complaints?|citizen reports?|intake|assign|staff|overdue)\b/.test(q) && !sortRequest && !isQuestion) {
      const inboxTerms = [zone && `zone ${Number(zone[1])}`, matchedRule?.[0], locationCode].filter(Boolean);
      navigateToInbox(requestedStatus, code || inboxTerms.join(' '));
      const scope = inboxTerms.length ? ` matching ${inboxTerms.join(' · ')}` : '';
      say(`${requestedStatus === 'overdue' ? 'Showing open reports past their target time' : requestedStatus === 'open' ? 'Showing open reports that need a next step' : requestedStatus === 'Resolved' ? 'Showing resolved reports' : 'Opened citizen reports and staff assignment controls'}${scope}.`);
      return;
    }

    const sortBy = $('#sortBy');
    const sortValue = sortRequest
      ? /\b(sever|critical|danger|risk)\b/.test(q) ? 'severity'
        : /\b(open|backlog|pending|workload)\b/.test(q) ? 'open'
        : /\b(complaint|citizen)\b/.test(q) ? 'complaints'
        : /\b(incident|event)\b/.test(q) ? 'incidents'
        : /\b(forecast|predict|model)\b/.test(q) ? 'forecast'
        : 'priority'
      : '';
    if (isQuestion && !sortRequest && !/\b(show|open|filter|find|search|go to|display)\b/.test(q)) {
      if (zone || issueOption || locationCode) {
        if (!zone) $('#zoneFilter').value = 'all';
        if (!issueOption) issueSelect.value = 'all';
        if (!locationCode) $('#searchInput').value = '';
      }
      if (zone) {
        const zoneOption = [...$('#zoneFilter').options].find((item) => item.value.match(/\d+/)?.[0].replace(/^0+/, '') === String(Number(zone[1])));
        if (!zoneOption) { say(`I can’t find Zone ${Number(zone[1])} in this review dataset.`); return; }
        $('#zoneFilter').value = zoneOption.value;
      }
      if (issueOption) issueSelect.value = issueOption.value;
      if (locationCode) $('#searchInput').value = locationCode;
      $('#zoneFilter').dispatchEvent(new Event('change', { bubbles: true }));
      issueSelect.dispatchEvent(new Event('change', { bubbles: true }));
      $('#searchInput').dispatchEvent(new Event('input', { bubbles: true }));
      $('#assistantInput').value = raw; $('#assistantForm').requestSubmit(); go('signals');
      say('Answered from the available demo records in the evidence briefing.'); return;
    }
    if (zone || issueOption || locationCode || sortRequest) {
      const applied = [];
      if (zone || issueOption || locationCode) {
        if (!zone) $('#zoneFilter').value = 'all';
        if (!issueOption) issueSelect.value = 'all';
        if (!locationCode) $('#searchInput').value = '';
      }
      if (zone) {
        const zoneOption = [...$('#zoneFilter').options].find((item) => item.value.match(/\d+/)?.[0].replace(/^0+/, '') === String(Number(zone[1])));
        if (zoneOption) { $('#zoneFilter').value = zoneOption.value; applied.push(zoneOption.textContent); }
        else { say(`I can’t find Zone ${Number(zone[1])} in this review dataset.`); return; }
      }
      if (issueOption) { issueSelect.value = issueOption.value; applied.push(issueOption.textContent); }
      if (locationCode) { $('#searchInput').value = locationCode; applied.push(locationCode); }
      if (sortValue && [...sortBy.options].some((option) => option.value === sortValue)) { sortBy.value = sortValue; applied.push(`sorted by ${sortBy.selectedOptions[0].textContent.toLowerCase()}`); }
      zoneFilter.dispatchEvent(new Event('change', { bubbles: true }));
      issueSelect.dispatchEvent(new Event('change', { bubbles: true }));
      sortBy.dispatchEvent(new Event('change', { bubbles: true }));
      $('#searchInput').dispatchEvent(new Event('input', { bubbles: true }));
      go('queue'); say(`Updated the priority queue: ${applied.join(' · ')}.`); return;
    }
    if (/\b(queue|locations?|priority list|worklist)\b/.test(q)) { go('queue'); say('Opened the priority queue.'); return; }
    if (/\b(overview|dashboard|home|start)\b/.test(q)) { go('overview'); say('Back to the overview.'); return; }
    if (/\b(find|search|locate|look up|open)\b/.test(q)) {
      const searchText = raw.replace(/\b(please|find|search|locate|look up|open|location|for|the|in|at)\b/ig, '').trim();
      if (searchText) { $('#searchInput').value = searchText; $('#searchInput').dispatchEvent(new Event('input', { bubbles: true })); go('queue'); say(`Searching locations for “${searchText}”.`); return; }
    }
    say('I couldn’t match that request. Try a report status or code, a zone or issue, queue sorting, trends, scoring, or an export.');
  }

  function init() {
    $('#enableDeskNotifications').addEventListener('click', async () => {
      if (!('Notification' in window)) { alert('This browser does not support desktop alerts. Keep the workspace open to review its overdue-target count.'); return; }
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission === 'granted') { localStorage.setItem('cityfix-notifications-v1', 'on'); $('#enableDeskNotifications').textContent = 'Desk alerts on ✓'; }
      else alert('Allow browser notifications to receive desk alerts.');
    });
    $('#citizenStatusFilter').addEventListener('change', (event) => { filter = event.target.value; render(); });
    $('#citizenReportSearch').addEventListener('input', (event) => { search = event.target.value.trim().toLowerCase(); render(); });
    $('#citizenReportList').addEventListener('submit', saveReport);
    $('#adminCommandForm').addEventListener('submit', handleCommand);
    document.querySelectorAll('.staff-command-shortcuts [data-command]').forEach((button) => button.addEventListener('click', () => {
      $('#adminCommand').value = button.dataset.command;
      $('#adminCommandForm').requestSubmit();
    }));
    window.addEventListener('storage', (event) => {
      if (event.key === KEY) {
        const previous = reports; reports = readReports();
        const added = reports.filter((report) => !previous.some((item) => item.id === report.id));
        if (added.length) deskNotice(`${added.length} new citizen report${added.length === 1 ? '' : 's'} received. Review the inbox.`);
        render();
      }
    });
    window.setInterval(() => { if (document.visibilityState === 'visible') { reports = readReports(); render(); } }, 60_000);
    render();
  }

  function deskNotice(message) {
    if (localStorage.getItem('cityfix-notifications-v1') === 'on' && window.Notification?.permission === 'granted' && document.visibilityState !== 'visible') new Notification('Mana Nagaram desk reminder', { body: message });
    else if (document.visibilityState === 'visible') {
      const toast = $('#toast'); toast.textContent = message; toast.classList.add('visible');
      clearTimeout(deskToastTimer); deskToastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

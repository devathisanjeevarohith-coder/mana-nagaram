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
      const text = `${report.id} ${report.title} ${report.category} ${report.place} ${report.department} ${report.assignee}`.toLowerCase();
      const open = !['Resolved', 'Not actionable'].includes(report.status);
      return (!search || text.includes(search)) && (filter === 'all' || (filter === 'open' ? open : report.status === filter));
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
    const q = raw.toLowerCase();
    const result = $('#adminCommandResult');
    if (!q) { result.textContent = 'Try “show unresolved complaints”, “assign CF-… to Asha”, “open zone 4”, or “export queue”.'; field.focus(); return; }
    const code = raw.match(/\bCF-\d{4}-[A-Z0-9]{6}\b/i)?.[0]?.toUpperCase();
    const report = code ? reports.find((item) => item.id.toUpperCase() === code) : null;
    const assign = q.match(/\bassign\b/);
    if (assign && code && report) {
      const name = raw.match(/\bto\s+(.+)$/i)?.[1]?.trim();
      if (!name) { navigateToInbox('all', code); $(`[data-report-form="${CSS.escape(report.id)}"] [name="assignee"]`)?.focus(); result.textContent = `Choose a staff member for ${report.id}, then save the assignment.`; return; }
      report.assignee = name;
      if (!report.department || report.department === 'Unassigned') report.department = suggestedDepartment(report.category);
      recordHistory(report, report.status || 'Received', `Assigned to ${name}${report.department !== 'Unassigned' ? ` · ${report.department}` : ''}.`);
      writeReports(); navigateToInbox('all', code); result.textContent = `${report.id} assigned to ${name}. The update is visible in its activity history.`; return;
    }
    if ((/\b(resolve|resolved|mark done|close)\b/.test(q)) && code && report) {
      const now = new Date().toISOString(); report.status = 'Resolved'; report.resolvedAt = now;
      report.publicUpdate = 'This complaint has been marked as resolved.';
      recordHistory(report, 'Resolved', report.publicUpdate, now);
      writeReports(); navigateToInbox('all', code); result.textContent = `${report.id} marked resolved and the reporter has a status update.`; return;
    }
    if (code) { navigateToInbox('all', code); result.textContent = report ? `Showing ${report.id} and its assignment and update controls.` : `No report ${code} is saved in this browser.`; return; }
    if (/\b(unresolved|open|active)\b/.test(q)) { navigateToInbox('open'); result.textContent = 'Showing complaints that still need a next step.'; return; }
    if (/\b(resolved|completed)\b/.test(q)) { navigateToInbox('Resolved'); result.textContent = 'Showing resolved complaints.'; return; }
    if (/\b(complaints?|citizen reports?|intake|assign|staff)\b/.test(q)) { navigateToInbox('all'); result.textContent = 'Showing citizen reports and staff assignment controls.'; return; }
    const zone = q.match(/\bzone\s*(\d{1,2})\b/);
    if (zone) {
      const select = $('#zoneFilter');
      const option = [...select.options].find((item) => new RegExp(`(?:^|\\D)0*${zone[1]}(?:\\D|$)`).test(item.value));
      if (option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); location.hash = 'queue'; $('#queue').scrollIntoView({ behavior: 'smooth' }); result.textContent = `Showing ${option.textContent} in the priority queue.`; }
      else result.textContent = `No zone ${zone[1]} is in the current review dataset.`;
      return;
    }
    const locationCode = raw.match(/\bL\d{3,5}\b/i)?.[0];
    if (locationCode || /\b(find|search|location)\b/.test(q)) {
      const searchText = locationCode || raw.replace(/\b(find|search|location|for|in|open)\b/ig, '').trim();
      $('#searchInput').value = searchText; $('#searchInput').dispatchEvent(new Event('input', { bubbles: true }));
      location.hash = 'queue'; $('#queue').scrollIntoView({ behavior: 'smooth' }); result.textContent = `Searching the priority queue for “${searchText}”.`; return;
    }
    if (/\b(export|download)\b/.test(q)) {
      const button = /\b(log|decision|review)\b/.test(q) ? $('#exportActions') : $('#exportTop');
      button.click(); result.textContent = /\b(log|decision|review)\b/.test(q) ? 'Review log exported.' : 'Priority queue exported.'; return;
    }
    if (/\b(trend|signals?)\b/.test(q)) { location.hash = 'signals'; $('#signals').scrollIntoView({ behavior: 'smooth' }); result.textContent = 'Showing signals and trends.'; return; }
    if (/\b(method|score|scoring|how is|why is)\b/.test(q)) { $('#method').scrollIntoView({ behavior: 'smooth' }); $('#methodButton').click(); result.textContent = 'Showing the scoring method and its details.'; return; }
    if (/\b(what|how many|compare|highest|most|why|which)\b/.test(q)) { $('#assistantInput').value = raw; $('#assistantForm').requestSubmit(); $('#signals').scrollIntoView({ behavior: 'smooth' }); result.textContent = 'Asked the evidence assistant about the supplied dataset.'; return; }
    if (/\b(pothole|road|drain|flood|light|signal|traffic|waste|garbage|complaint|location|zone)\b/.test(q)) { $('#searchInput').value = raw; $('#searchInput').dispatchEvent(new Event('input', { bubbles: true })); location.hash = 'queue'; $('#queue').scrollIntoView({ behavior: 'smooth' }); result.textContent = `Searching the priority queue for “${raw}”.`; return; }
    result.textContent = 'I can open or resolve a complaint, assign staff, show open or resolved reports, search a location, filter a zone, show trends or scoring, ask about the dataset, or export a queue.';
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

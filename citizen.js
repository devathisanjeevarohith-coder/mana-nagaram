(() => {
  'use strict';

  const STORAGE_KEY = 'cityfix-citizen-reports-v1';
  const DEFAULT_CENTER = [16.458373, 80.404599];
  const MAX_PHOTO_BYTES = 1024 * 1024;
  const allowedStatuses = ['Received', 'Under review', 'Scheduled', 'Resolved', 'Not actionable'];
  const $ = (selector, root = document) => root.querySelector(selector);
  let reports = readReports();
  let reportMap = null;
  let reportPin = null;
  let toastTimer = null;
  let reportSearch = '';
  let reportFilter = 'all';
  let trackedReportCode = '';

  function readReports() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function saveReports() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(reports)); return true; }
    catch (_) { showToast('This browser could not save the report. Clear some browser storage and try again.'); return false; }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function init() {
    initializeReportMap();
    $('#citizenReportForm').addEventListener('submit', submitReport);
    $('#trackForm').addEventListener('submit', trackReport);
    $('#clearReportPin').addEventListener('click', clearPin);
    observeCitizenSections();
    $('#citizenCommandForm').addEventListener('submit', handleCitizenCommand);
    $('#myReportSearch').addEventListener('input', (event) => { reportSearch = event.target.value.trim().toLowerCase(); renderReports(); });
    $('#myReportFilter').addEventListener('change', (event) => { reportFilter = event.target.value; renderReports(); });
    $('#citizenReportList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-track]');
      if (!button) return;
      $('#trackForm').elements.namedItem('reportCode').value = button.dataset.track;
      trackReport();
      navigateCitizen('track');
    });
    window.setInterval(() => { if (document.visibilityState === 'visible') { renderReports(); if (trackedReportCode) trackReport(); } }, 60_000);
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) { reports = readReports(); renderReports(); if (trackedReportCode) { $('#trackForm').elements.namedItem('reportCode').value = trackedReportCode; trackReport(); } }
    });
    renderReports();
  }

  function handleCitizenCommand(event) {
    event.preventDefault();
    const input = $('#citizenCommand');
    const query = input.value.trim();
    const q = query.toLowerCase();
    const result = $('#citizenCommandResult');
    if (!q) { result.textContent = 'Try “report a pothole”, “track CF-2026-ABC123”, or “show my complaints”.'; input.focus(); return; }
    const code = query.match(/\bCF-\d{4}-[A-Z0-9]{6}\b/i)?.[0];
    if (code || /\b(track|status|follow)\b/.test(q)) {
      const reportCode = code || '';
      if (!reportCode) {
        navigateCitizen('track');
        $('#trackForm').elements.namedItem('reportCode').focus();
        result.textContent = 'Enter your complaint code to see its latest status and public updates.';
        return;
      }
      $('#trackForm').elements.namedItem('reportCode').value = reportCode.toUpperCase();
      trackReport();
      navigateCitizen('track');
      result.textContent = `Showing the saved status for ${reportCode.toUpperCase()}.`;
      return;
    }
    if (/\b(my complaints|my reports|submitted|submission history|history)\b/.test(q)) {
      navigateCitizen('myReports');
      result.textContent = `Showing ${reports.length} complaint${reports.length === 1 ? '' : 's'} saved in this browser.`;
      return;
    }
    if (/\b(staff|admin|operations)\b/.test(q)) { location.href = 'admin.html'; return; }
    if (/\b(report|submit|file|raise|new complaint|new issue|pothole|road damage|drain|flood|street ?light|lamp|signal|traffic light|collision|crash|accident|waste|garbage|trash|sanitation)\b/.test(q)) {
      const categories = [
        [/pothole|road damage/, 'Pothole'], [/drain|sewer|waterway/, 'Blocked drain'], [/flood|waterlogging/, 'Flooding'],
        [/street ?light|lamp/, 'Streetlight outage'], [/signal|traffic light/, 'Signal failure'], [/collision|crash|accident/, 'Collision hazard'],
        [/waste|garbage|trash|sanitation/, 'Waste or sanitation']
      ];
      const match = categories.find(([pattern]) => pattern.test(q));
      if (match) $('#citizenReportForm').elements.namedItem('category').value = match[1];
      navigateCitizen('reportIssue');
      $('#citizenReportForm').elements.namedItem(match ? 'title' : 'category').focus();
      result.textContent = match ? `${match[1]} selected. Add the location and details, then save your complaint.` : 'Choose an issue type, add its location and details, then save your complaint.';
      return;
    }
    result.textContent = 'I can open the complaint form, track a code, show your complaint history, or open the staff workspace. Try one of those requests.';
  }

  function navigateCitizen(section) {
    location.hash = section;
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function observeCitizenSections() {
    if (!('IntersectionObserver' in window)) return;
    const sections = ['reportIssue', 'track', 'myReports'].map((id) => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const current = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!current) return;
      document.querySelectorAll('.citizen-nav a[href^="#"]').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${current.target.id}`));
    }, { rootMargin: '-18% 0px -66% 0px', threshold: [0, .2, .5] });
    sections.forEach((section) => observer.observe(section));
  }

  function initializeReportMap() {
    const container = $('#reportMap');
    if (!window.L) {
      $('#reportMapError').hidden = false;
      container.innerHTML = '<div class="map-fallback">Map library unavailable. Enter the street or public landmark above to describe the location.</div>';
      return;
    }
    try {
      reportMap = L.map(container, { center: DEFAULT_CENTER, zoom: 14, minZoom: 11, maxZoom: 19, scrollWheelZoom: false, zoomAnimation: false });
      const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, keepBuffer: 2, updateWhenIdle: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
      }).addTo(reportMap);
      let tileErrors = 0;
      tiles.on('tileerror', () => { tileErrors += 1; if (tileErrors >= 2) $('#reportMapError').hidden = false; });
      tiles.on('tileload', () => { tileErrors = Math.max(0, tileErrors - 1); if (tileErrors === 0) $('#reportMapError').hidden = true; });
      reportMap.on('click', (event) => placePin(event.latlng));
      reportMap.whenReady(() => requestAnimationFrame(() => reportMap && reportMap.invalidateSize({ pan: false })));
      if ('ResizeObserver' in window) {
        const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => reportMap && reportMap.invalidateSize({ pan: false })));
        resizeObserver.observe($('.report-map-wrap'));
      }
      window.addEventListener('resize', () => requestAnimationFrame(() => reportMap && reportMap.invalidateSize({ pan: false })));
    } catch (_) {
      reportMap = null;
      $('#reportMapError').hidden = false;
      container.innerHTML = '<div class="map-fallback">The map could not start. Enter the street or public landmark above to describe the location.</div>';
    }
  }

  function placePin(latlng) {
    if (!reportMap) return;
    const latitude = Number(latlng.lat.toFixed(6));
    const longitude = Number(latlng.lng.toFixed(6));
    if (!reportPin) {
      reportPin = L.circleMarker([latitude, longitude], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#b85d43', fillOpacity: 1 }).addTo(reportMap);
    } else reportPin.setLatLng([latitude, longitude]);
    $('#citizenReportForm').elements.namedItem('latitude').value = latitude.toFixed(6);
    $('#citizenReportForm').elements.namedItem('longitude').value = longitude.toFixed(6);
    $('#reportMapStatus').textContent = `Pin set at ${latitude.toFixed(5)}, ${longitude.toFixed(5)}.`;
    $('#clearReportPin').hidden = false;
  }

  function clearPin() {
    if (reportMap && reportPin) reportMap.removeLayer(reportPin);
    reportPin = null;
    const form = $('#citizenReportForm');
    form.elements.namedItem('latitude').value = '';
    form.elements.namedItem('longitude').value = '';
    $('#reportMapStatus').textContent = 'Click the map to place a pin. Device location is not requested.';
    $('#clearReportPin').hidden = true;
  }

  function submitReport(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const photo = form.elements.namedItem('photo').files[0];
    if (photo && photo.size > MAX_PHOTO_BYTES) { showToast('Choose an image smaller than 1 MB.'); return; }
    const save = (image) => {
      const now = new Date();
      const report = {
        id: makeReportId(), category: form.elements.namedItem('category').value,
        title: form.elements.namedItem('title').value.trim(), place: form.elements.namedItem('place').value.trim(),
        description: form.elements.namedItem('description').value.trim(),
        latitude: form.elements.namedItem('latitude').value || '', longitude: form.elements.namedItem('longitude').value || '',
        image, status: 'Received', department: suggestedDepartment(form.elements.namedItem('category').value), assignee: '', publicUpdate: '', staffNote: '',
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
        targetAt: new Date(now.getTime() + suggestedHours(form.elements.namedItem('category').value) * 3600000).toISOString(),
        history: [{ status: 'Received', at: now.toISOString(), note: 'Complaint submitted.' }], resolvedAt: null
      };
      reports = [report, ...reports];
      if (!saveReports()) return;
      form.reset(); clearPin();
      $('#submissionNotice').innerHTML = `<strong>Report saved on this device.</strong><span>Your report code is <b>${escapeHtml(report.id)}</b>. Keep it to check the status here. No city office has received this report.</span><a href="#track" class="text-button" data-track-code="${escapeHtml(report.id)}">Track this report ↓</a>`;
      $('#submissionNotice').hidden = false;
      $('#submissionNotice').querySelector('[data-track-code]').addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        $('#trackForm').elements.namedItem('reportCode').value = report.id;
        trackReport(new Event('submit', { cancelable: true }));
        document.querySelector('#track').scrollIntoView({ behavior: 'smooth' });
      });
      renderReports();
      showToast('Your report is saved in this browser.');
    };
    if (!photo) { save(''); return; }
    const reader = new FileReader();
    reader.onload = () => save(String(reader.result || ''));
    reader.onerror = () => showToast('The image could not be read. Try another file.');
    reader.readAsDataURL(photo);
  }

  function makeReportId() {
    let id;
    do { id = `CF-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
    while (reports.some((report) => report.id === id));
    return id;
  }

  function trackReport(event) {
    if (event?.preventDefault) event.preventDefault();
    const code = $('#trackForm').elements.namedItem('reportCode').value.trim().toUpperCase();
    const report = reports.find((item) => item.id.toUpperCase() === code);
    trackedReportCode = report?.id || '';
    const result = $('#trackResult');
    if (!report) {
      result.innerHTML = '<div class="track-empty">No report with that code is saved in this browser. Check the code or use the browser where you submitted it.</div>';
      return;
    }
    const resolvedDays = report.status === 'Resolved' && report.resolvedAt ? ` · Resolved in ${resolutionLabel(report.createdAt, report.resolvedAt)}` : '';
    result.innerHTML = `<article class="track-result-card"><div><span class="report-code">${escapeHtml(report.id)}</span><span class="report-status status-${statusClass(report.status)}">${escapeHtml(report.status)}</span></div><h3>${escapeHtml(report.title)}</h3><p>${escapeHtml(report.category)} · ${escapeHtml(report.place)}</p><small>Submitted ${escapeHtml(formatDate(report.createdAt))}${report.department && report.department !== 'Unassigned' ? ` · ${escapeHtml(report.department)}` : ''}${report.assignee ? ` · ${escapeHtml(report.assignee)}` : ''}${resolvedDays}</small><div class="report-timing">${timingText(report)}</div>${renderProgress(report.status)}${report.publicUpdate ? `<div class="public-update"><strong>Latest staff update</strong><p>${escapeHtml(report.publicUpdate)}</p></div>` : '<div class="public-update muted-update">No staff update has been added yet.</div>'}${renderTimeline(report)}</article>`;
  }

  function renderReports() {
    const list = $('#citizenReportList');
    const count = reports.length;
    $('#myReportCount').textContent = String(count);
    const matches = [...reports].filter((report) => {
      const text = `${report.id} ${report.title} ${report.category} ${report.place}`.toLowerCase();
      return (!reportSearch || text.includes(reportSearch)) && (reportFilter === 'all' || (reportFilter === 'open' ? !['Resolved', 'Not actionable'].includes(report.status) : report.status === reportFilter));
    }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    $('#reportsSummary').textContent = `${count} complaint${count === 1 ? '' : 's'}`;
    if (!count) {
      list.innerHTML = '<div class="citizen-empty"><span class="empty-icon">⌖</span><strong>No complaints saved here yet</strong><p>Submit a complaint and its updates will appear in this list on this device.</p><a class="text-button" href="#reportIssue">Report an issue →</a></div>';
      return;
    }
    if (!matches.length) {
      list.innerHTML = '<div class="citizen-empty"><strong>No complaints match these filters</strong><p>Try a different report code, issue, location, or status.</p><button class="text-button" type="button" id="clearComplaintFilters">Clear filters</button></div>';
      $('#clearComplaintFilters').addEventListener('click', () => { reportSearch = ''; reportFilter = 'all'; $('#myReportSearch').value = ''; $('#myReportFilter').value = 'all'; renderReports(); });
      return;
    }
    list.innerHTML = matches.map((report) => {
      const image = typeof report.image === 'string' && report.image.startsWith('data:image/') ? `<img src="${escapeHtml(report.image)}" alt="Photo attached to ${escapeHtml(report.title)}" loading="lazy" />` : '';
      const latest = report.publicUpdate ? `<div class="public-update"><strong>Latest update</strong><p>${escapeHtml(report.publicUpdate)}</p></div>` : '';
      return `<article class="citizen-report-card"><div class="citizen-report-card-top"><div><span class="report-code">${escapeHtml(report.id)}</span><span class="report-category">${escapeHtml(report.category)}</span></div><span class="report-status status-${statusClass(report.status)}">${escapeHtml(report.status)}</span></div><h3>${escapeHtml(report.title)}</h3><p class="report-place">⌖ ${escapeHtml(report.place)}${report.latitude ? ` · ${Number(report.latitude).toFixed(5)}, ${Number(report.longitude).toFixed(5)}` : ''}</p><p class="report-description">${escapeHtml(report.description)}</p><div class="report-timing">${timingText(report)}</div>${renderProgress(report.status)}${latest}${image}<div class="citizen-report-card-foot"><span>Submitted ${escapeHtml(formatDate(report.createdAt))}${report.assignee ? ` · ${escapeHtml(report.assignee)}` : ''}</span><button class="text-button" type="button" data-track="${escapeHtml(report.id)}">View timeline →</button></div></article>`;
    }).join('');
  }

  function renderProgress(status) {
    const steps = ['Received', 'Under review', 'Scheduled', 'Resolved'];
    const current = status === 'Not actionable' ? 0 : steps.indexOf(status);
    if (status === 'Not actionable') return '<div class="complaint-progress is-closed"><span class="progress-step is-current">Closed with notice</span></div>';
    return `<div class="complaint-progress" aria-label="Complaint progress">${steps.map((step, index) => `<span class="progress-step${index < current ? ' is-done' : ''}${index === current ? ' is-current' : ''}">${step}</span>`).join('')}</div>`;
  }

  function renderTimeline(report) {
    const history = Array.isArray(report.history) && report.history.length ? report.history : [{ status: report.status || 'Received', at: report.updatedAt || report.createdAt, note: report.publicUpdate || 'Complaint submitted.' }];
    return `<div class="complaint-timeline"><strong>Progress updates</strong><ol>${history.map((item) => `<li><span class="timeline-dot"></span><div><b>${escapeHtml(item.status || 'Update')}</b><p>${escapeHtml(item.note || `Status changed to ${item.status || 'updated'}.`)}</p><small>${escapeHtml(formatDate(item.at))}</small></div></li>`).join('')}</ol></div>`;
  }

  function resolutionLabel(start, end) {
    const duration = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(duration) || duration < 0) return 'time unavailable';
    if (duration < 86400000) return `${Math.max(1, Math.round(duration / 3600000))}h`;
    return `${(duration / 86400000).toFixed(1)} days`;
  }

  function timingText(report) {
    if (report.status === 'Resolved' && report.resolvedAt) return `Resolved ${escapeHtml(formatDate(report.resolvedAt))} · ${resolutionLabel(report.createdAt, report.resolvedAt)} total`;
    if (!report.targetAt) return 'Expected completion time not set';
    const left = new Date(report.targetAt).getTime() - Date.now();
    if (!Number.isFinite(left)) return 'Expected completion time unavailable';
    if (left < 0) return `Past expected completion by ${resolutionLabel(report.targetAt, new Date().toISOString())}`;
    const hours = Math.max(1, Math.ceil(left / 3600000));
    return `Target: ${escapeHtml(formatDate(report.targetAt))} · about ${hours < 24 ? `${hours}h` : `${Math.ceil(hours / 24)} days`} remaining`;
  }

  function suggestedHours(category) {
    return ({ 'Signal failure': 12, 'Collision hazard': 24, Flooding: 24, 'Blocked drain': 48, 'Waste or sanitation': 48, Pothole: 72, 'Streetlight outage': 72, Other: 72 })[category] || 72;
  }

  function suggestedDepartment(category) {
    return ({ 'Blocked drain': 'Drainage', Flooding: 'Drainage', 'Streetlight outage': 'Electrical', 'Signal failure': 'Traffic', 'Collision hazard': 'Traffic', 'Waste or sanitation': 'Sanitation', Pothole: 'Public Works' })[category] || 'Unassigned';
  }

  function statusClass(status) {
    return ({ 'Received': 'received', 'Under review': 'review', 'Scheduled': 'scheduled', 'Resolved': 'resolved', 'Not actionable': 'closed' })[status] || 'received';
  }

  function formatDate(date) {
    const value = new Date(date);
    return Number.isNaN(value.getTime()) ? 'recently' : value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message; toast.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

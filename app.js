(() => {
  'use strict';
  const data = window.CITYFIX_DATA;
  if (!data || !Array.isArray(data.locations)) return;

  const fmt = new Intl.NumberFormat('en-US');
  const locations = data.locations;
  const percentile95 = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 1;
  };
  const scale = (value, ceiling) => Math.min(1, value / Math.max(1, ceiling));
  const ceilings = {
    incidents: percentile95(locations.map(x => x.incidentCount)),
    complaints: percentile95(locations.map(x => x.complaintCount)),
    backlog: percentile95(locations.map(x => x.unresolved + x.openComplaints)),
    density: percentile95(locations.map(x => x.density)),
  };
  const roadRisk = {Good: 0.2, Fair: 0.45, Poor: 0.75, Critical: 1};
  const pedestrianRisk = {Low: 0.35, Medium: 0.65, High: 1};
  const weights = [0.30, 0.25, 0.20, 0.15, 0.10];

  locations.forEach((loc) => {
    const exposure = (loc.school ? 0.5 : 0) + (loc.hospital ? 0.5 : 0);
    const context = (roadRisk[loc.condition] || 0.4) * 0.40
      + (pedestrianRisk[loc.pedestrian] || 0.5) * 0.30
      + exposure * 0.20
      + scale(loc.density, ceilings.density) * 0.10;
    const values = [
      scale(loc.incidentCount, ceilings.incidents),
      loc.avgSeverity / 4,
      scale(loc.complaintCount, ceilings.complaints),
      scale(loc.unresolved + loc.openComplaints, ceilings.backlog),
      context,
    ];
    loc.components = values;
    loc.priority = Math.round(values.reduce((sum, value, i) => sum + value * weights[i] * 100, 0));
    loc.openWork = loc.unresolved + loc.openComplaints;
    loc.topIssue = Object.entries(loc.incidentTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'No incidents';
  });

  const $ = (id) => document.getElementById(id);
  const zoneFilter = $('zoneFilter');
  const issueFilter = $('issueFilter');
  const searchInput = $('searchInput');
  const methodDialog = $('methodDialog');
  const locationMap = $('locationMap');
  const mapCoordinates = $('mapCoordinates');
  const googleMapsLink = $('googleMapsLink');
  const mapLocationLabel = $('mapLocationLabel');
  const mapDisclaimer = $('mapDisclaimer');
  const fieldReportsStorageKey = 'cityfix-field-reports-v1';
  const evidenceDatabaseName = 'cityfix-field-evidence-v1';
  const recordsUrl = 'records.json.gz?v=field-evidence-1';
  const googleMapsKey = window.CITYFIX_GOOGLE_MAPS_EMBED_KEY || '';
  let forecastModel = null;
  let recordsByLocationPromise;
  let mapSignature = '';
  let previewUrls = [];
  const reviewStorageKey = 'cityfix-review-decisions-v1';
  const reviewDecisions = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(reviewStorageKey) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch (_) { return {}; }
  })();
  const queueLabels = ['Incident volume', 'Average severity', 'Complaint volume', 'Open backlog', 'Street context'];
  const state = {zone: 'all', issue: 'all', search: '', selected: null, expanded: false, sort: 'priority'};
  const zones = [...new Set(locations.map(x => x.zone))].sort((a, b) => a.localeCompare(b));
  zones.forEach((zone) => zoneFilter.add(new Option(zone.replace('_', ' '), zone)));
  data.incidentTypes.forEach((type) => issueFilter.add(new Option(type, type)));
  data.incidentTypes.forEach((type) => $('reportType').add(new Option(type, type)));
  $('reportType').value = data.incidentTypes[0] || '';

  const scoreClass = (score) => score >= 66 ? 'high' : score >= 40 ? 'mid' : 'low';
  const currentRows = () => locations
    .filter((loc) => state.zone === 'all' || loc.zone === state.zone)
    .filter((loc) => state.issue === 'all' || (loc.incidentTypes[state.issue] || 0) > 0)
    .filter((loc) => !state.search || `${loc.id} ${loc.zone} ${loc.road} ${loc.topIssue}`.toLowerCase().includes(state.search))
    .sort((a, b) => {
      const value = (loc) => state.sort === 'open' ? loc.openWork
        : state.sort === 'complaints' ? loc.complaintCount
        : state.sort === 'incidents' ? (state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0))
        : state.sort === 'forecast' ? (loc.predictedQ4 ?? -1)
        : loc.priority;
      return value(b) - value(a) || b.priority - a.priority || a.id.localeCompare(b.id);
    });
  const currentIncidentCount = (rows) => rows.reduce((sum, loc) => sum + (state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0)), 0);
  const pct = (count, total) => total ? Math.round(count / total * 100) : 0;
  const quoteCsv = (value) => {
    let text = String(value ?? '');
    if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };

  function renderMetrics(rows) {
    const incidentTotal = currentIncidentCount(rows);
    const complaintTotal = rows.reduce((sum, loc) => sum + loc.complaintCount, 0);
    const openTotal = rows.reduce((sum, loc) => sum + loc.openWork, 0);
    $('metricLocations').textContent = fmt.format(rows.length);
    $('metricIncidents').textContent = fmt.format(incidentTotal);
    $('metricComplaints').textContent = fmt.format(complaintTotal);
    $('metricOpen').textContent = fmt.format(openTotal);
    $('metricIncidentShare').textContent = `${pct(incidentTotal, data.summary.incidents)}%`;
    $('metricComplaintShare').textContent = `${pct(complaintTotal, data.summary.complaints)}%`;
    const savedInView = rows.filter(loc => reviewDecisions[loc.id]?.action).length;
    $('queueReviewCount').textContent = `${fmt.format(savedInView)} reviewed`;
    $('navCount').textContent = fmt.format(rows.length);
    $('queueCount').textContent = fmt.format(rows.length);
    $('mapScope').textContent = state.zone === 'all' ? 'ALL ZONES' : state.zone.replace('_', ' ');
  }

  function mapUrl(lat, lon) {
    const delta = 0.012;
    const west = (lon - delta).toFixed(5), east = (lon + delta).toFixed(5);
    const south = (lat - delta).toFixed(5), north = (lat + delta).toFixed(5);
    const bbox = `${west}%2C${south}%2C${east}%2C${north}`;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
  }

  function renderMap(loc) {
    if (!loc) {
      locationMap.removeAttribute('src');
      mapSignature = '';
      mapCoordinates.textContent = 'Choose a problem from the review queue to see its map position.';
      mapLocationLabel.textContent = 'SELECT A PROBLEM';
      mapDisclaimer.textContent = 'Map positions from the supplied dataset are simulated examples.';
      googleMapsLink.href = 'https://www.google.com/maps';
      return;
    }
    const fieldReports = getFieldReports().filter(report => report.locationId === loc.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const verified = fieldReports.find(report => Number.isFinite(report.lat) && Number.isFinite(report.lon));
    const hasExactPin = Boolean(verified);
    const lat = hasExactPin ? verified.lat : Number(loc.lat);
    const lon = hasExactPin ? verified.lon : Number(loc.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      locationMap.removeAttribute('src');
      mapSignature = '';
      mapCoordinates.textContent = 'A valid map position is not available for this record.';
      mapLocationLabel.textContent = 'MAP POSITION UNAVAILABLE';
      mapDisclaimer.textContent = 'Check the report address or enter corrected field coordinates before opening a map.';
      googleMapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.id)}`;
      return;
    }
    const query = verified ? `${verified.lat},${verified.lon}` : (fieldReports[0]?.address || `${loc.lat},${loc.lon}`);
    const signature = `${loc.id}:${lat}:${lon}:${hasExactPin}`;
    if (signature !== mapSignature) {
      locationMap.src = googleMapsKey
        ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(googleMapsKey)}&q=${encodeURIComponent(`${lat},${lon}`)}`
        : mapUrl(lat, lon);
      mapSignature = signature;
    }
    mapCoordinates.textContent = hasExactPin
      ? `${verified.address} · ${lat.toFixed(5)}, ${lon.toFixed(5)}`
      : `${loc.id} · ${lat.toFixed(5)}, ${lon.toFixed(5)} · example coordinate`;
    mapLocationLabel.textContent = hasExactPin ? 'FIELD GPS LOCATION' : 'SIMULATED DATA POINT';
    mapDisclaimer.textContent = hasExactPin
      ? 'Pin is from a reviewer’s field report. Confirm the address and conditions before dispatch.'
      : `This street map uses simulated dataset coordinates, not a verified problem location.${googleMapsKey ? '' : ' Google Maps embed needs a restricted API key; the map link below still opens Google Maps.'}`;
    googleMapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    googleMapsLink.setAttribute('aria-label', `Open ${verified ? verified.address : fieldReports[0]?.address || loc.id} in Google Maps`);
  }

  function modelFeatures(loc) {
    const road = {Good: 0, Fair: 1, Poor: 2, Critical: 3};
    const pedestrian = {Low: 0, Medium: 1, High: 2};
    return [0,3,6].map(start => loc.monthIncidents.slice(start,start+3).reduce((a,b)=>a+b,0))
      .concat([0,3,6].map(start => loc.monthComplaints.slice(start,start+3).reduce((a,b)=>a+b,0)))
      .concat([road[loc.condition] ?? 1, pedestrian[loc.pedestrian] ?? 1, Number(loc.school), Number(loc.hospital), loc.density / 1000]);
  }

  function predictForest(tree, features) {
    while (tree.v === undefined) tree = features[tree.f] <= tree.t ? tree.l : tree.r;
    return tree.v;
  }

  async function loadForecastModel() {
    try {
      const response = await fetch('forecast-model.json?v=rf-holdout-1');
      if (!response.ok) throw new Error('Model file could not be loaded.');
      forecastModel = await response.json();
      locations.forEach(loc => {
        const features = modelFeatures(loc);
        loc.predictedQ4 = Math.max(0, forecastModel.trees.reduce((sum, tree) => sum + predictForest(tree, features), 0) / forecastModel.trees.length);
      });
      const m = forecastModel.metrics;
      const comparison = m.mae < m.baselineMae ? 'It beats the mean baseline on this test.' : 'It does not beat the mean baseline, so treat its ranking as research only.';
      $('forecastNote').textContent = `Random Forest · ${forecastModel.treeCount} trees · estimates Q4 incidents from Q1–Q3 history. Held-out MAE ${m.mae} vs mean-baseline MAE ${m.baselineMae}. ${comparison} Synthetic benchmark.`;
      render();
    } catch (error) {
      $('forecastNote').textContent = 'The forecast model did not load. Review index and queue remain available.';
      console.error('Mana Nagaram forecast:', error);
    }
  }

  function renderZones(rows) {
    const grouped = new Map();
    rows.forEach((loc) => {
      const group = grouped.get(loc.zone) || {zone: loc.zone, count: 0, score: 0, incidents: 0, complaints: 0};
      group.count += 1; group.score += loc.priority;
      group.incidents += state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0);
      group.complaints += loc.complaintCount;
      grouped.set(loc.zone, group);
    });
    const leaders = [...grouped.values()].map(x => ({...x, average: Math.round(x.score / x.count)})).sort((a, b) => b.average - a.average || b.count - a.count).slice(0, 1);
    $('zoneLeaders').innerHTML = leaders.length ? leaders.map((x, i) => `<div class="zone-leader"><span class="zone-rank">0${i + 1}</span><div class="zone-main"><div class="zone-name">${x.zone.replace('_', ' ')}</div><div class="zone-meta">${fmt.format(x.count)} locations · ${fmt.format(x.incidents)} incidents · ${fmt.format(x.complaints)} complaints</div></div><div class="zone-index">${x.average}<small> avg</small></div></div>`).join('') : '<div class="empty-state">No zones match these filters.</div>';
    return leaders;
  }

  function renderBriefing(rows, leaders) {
    if (!rows.length) {
      $('briefingText').textContent = 'No locations match these filters. Clear a filter to explore the supplied records.';
      return;
    }
    const lead = [...rows].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
    const zone = leaders[0];
    const issueScope = state.issue === 'all' ? '' : ` With the ${state.issue.toLowerCase()} filter active, the index remains citywide for comparison.`;
    const hc = lead.highCritical;
    const leadIssueCount = state.issue === 'all' ? lead.incidentCount : (lead.incidentTypes[state.issue] || 0);
    const incidentLabel = state.issue === 'all' ? 'incidents' : `${state.issue.toLowerCase()} incidents`;
    $('briefingText').textContent = `${zone ? `${zone.zone.replace('_', ' ')} has the highest average review index in this view (${zone.average}/100 across ${fmt.format(zone.count)} locations). ` : ''}${lead.id} is the top-ranked location, with ${fmt.format(leadIssueCount)} ${incidentLabel}, ${fmt.format(hc)} high or critical incidents, and ${fmt.format(lead.complaintCount)} complaints. ${fmt.format(lead.openWork)} combined work items remain open.${issueScope}`;
  }

  function answerQuestion(question) {
    const rows = currentRows();
    const query = question.trim().toLowerCase();
    if (!rows.length) {
      $('briefingText').textContent = 'No locations are in the current filter scope. Reset or adjust the filters, then ask again.';
      return;
    }
    if (!query) return;
    const locationId = query.match(/\bl\d{4}\b/i)?.[0]?.toUpperCase();
    if (locationId) {
      const loc = rows.find(item => item.id === locationId);
      $('briefingText').textContent = loc
        ? `${loc.id} (${loc.zone.replace('_', ' ')}) has a review index of ${loc.priority}/100, ${fmt.format(loc.incidentCount)} incidents, ${fmt.format(loc.highCritical)} high or critical incidents, ${fmt.format(loc.complaintCount)} complaints, and ${fmt.format(loc.openWork)} open work items.`
        : `${locationId} is outside the current filter scope. Clear the zone, issue, or search filter to inspect it.`;
      return;
    }
    const requestedType = data.incidentTypes.find(type => query.includes(type.toLowerCase()) || query.includes(`${type.toLowerCase()}s`));
    if (requestedType) {
      const match = [...rows].sort((a, b) => (b.incidentTypes[requestedType] || 0) - (a.incidentTypes[requestedType] || 0))[0];
      $('briefingText').textContent = match && match.incidentTypes[requestedType]
        ? `${match.id} in ${match.zone.replace('_', ' ')} has the most ${requestedType.toLowerCase()} reports in this view: ${fmt.format(match.incidentTypes[requestedType])}. It also has ${fmt.format(match.complaintCount)} public complaints and a ${match.priority}/100 review index.`
        : `No ${requestedType.toLowerCase()} reports are present in the current filter scope.`;
      return;
    }
    if (/complaint|public report|citizen/.test(query)) {
      const ranked = [...rows].sort((a, b) => b.complaintCount - a.complaintCount);
      const match = ranked[0];
      $('briefingText').textContent = `${match.id} (${match.zone.replace('_', ' ')}) has the most complaints in this view: ${fmt.format(match.complaintCount)}. ${fmt.format(match.highPriority)} were marked high priority; ${fmt.format(match.openComplaints)} complaints are open or assigned.`;
      return;
    }
    if (/open|backlog|unresolved|pending/.test(query)) {
      const match = [...rows].sort((a, b) => b.openWork - a.openWork)[0];
      $('briefingText').textContent = `${match.id} (${match.zone.replace('_', ' ')}) has the largest open workload in this view: ${fmt.format(match.unresolved)} unresolved incidents and ${fmt.format(match.openComplaints)} open or assigned complaints (${fmt.format(match.openWork)} total).`;
      return;
    }
    if (/critical|sever|injur/.test(query)) {
      const match = [...rows].sort((a, b) => b.highCritical - a.highCritical || b.injuries - a.injuries)[0];
      $('briefingText').textContent = `${match.id} (${match.zone.replace('_', ' ')}) has ${fmt.format(match.highCritical)} high or critical incidents and ${fmt.format(match.injuries)} recorded injuries in the supplied data. Its review index is ${match.priority}/100.`;
      return;
    }
    if (/school|hospital|pedestrian/.test(query)) {
      const nearby = rows.filter(loc => (query.includes('school') && loc.school) || (query.includes('hospital') && loc.hospital) || (query.includes('pedestrian') && loc.pedestrian === 'High'));
      const match = [...nearby].sort((a, b) => b.priority - a.priority)[0];
      $('briefingText').textContent = match
        ? `${fmt.format(nearby.length)} locations in this view match that context. ${match.id} (${match.zone.replace('_', ' ')}) is the highest-ranked match at ${match.priority}/100, with ${fmt.format(match.incidentCount)} incidents and ${fmt.format(match.complaintCount)} complaints.`
        : 'No locations in the current view match that context.';
      return;
    }
    if (/zone|area|district/.test(query)) {
      const byZone = new Map();
      rows.forEach(loc => {
        const item = byZone.get(loc.zone) || {zone: loc.zone, count: 0, sum: 0, incidents: 0, complaints: 0};
        item.count += 1; item.sum += loc.priority;
        item.incidents += state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0);
        item.complaints += loc.complaintCount;
        byZone.set(loc.zone, item);
      });
      const match = [...byZone.values()].map(item => ({...item, avg: Math.round(item.sum / item.count)})).sort((a, b) => b.avg - a.avg)[0];
      $('briefingText').textContent = `${match.zone.replace('_', ' ')} has the highest average review index in this view (${match.avg}/100 across ${fmt.format(match.count)} locations), with ${fmt.format(match.incidents)} incidents and ${fmt.format(match.complaints)} complaints.`;
      return;
    }
    const match = [...rows].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
    $('briefingText').textContent = `${match.id} (${match.zone.replace('_', ' ')}) is the highest-ranked location in this view at ${match.priority}/100. It has ${fmt.format(match.incidentCount)} incidents, ${fmt.format(match.complaintCount)} complaints, and ${fmt.format(match.openWork)} open work items. Ask about a location, zone, issue type, severity, complaints, or backlog.`;
  }

  function renderTrend(rows) {
    const incidentMonths = Array(12).fill(0);
    const complaintMonths = Array(12).fill(0);
    rows.forEach((loc) => {
      const incidents = state.issue === 'all' ? loc.monthIncidents : (loc.monthByType[state.issue] || Array(12).fill(0));
      incidents.forEach((value, i) => { incidentMonths[i] += value; });
      loc.monthComplaints.forEach((value, i) => { complaintMonths[i] += value; });
    });
    const max = Math.max(1, ...incidentMonths, ...complaintMonths);
    $('trendChart').innerHTML = data.months.map((month, i) => {
      const first = Math.max(2, Math.round(incidentMonths[i] / max * 98));
      const second = Math.max(2, Math.round(complaintMonths[i] / max * 98));
      return `<div class="trend-month-group" title="${month}: ${fmt.format(incidentMonths[i])} incidents, ${fmt.format(complaintMonths[i])} complaints"><div class="trend-bar incident" style="height:${first}px"></div><div class="trend-bar complaint" style="height:${second}px"></div></div>`;
    }).join('');
    $('trendMonths').innerHTML = data.months.map(month => `<span>${month}</span>`).join('');
  }

  function renderQueue(rows) {
    const displayRows = state.expanded ? rows : rows.slice(0, 8);
    const queueRows = $('queueRows');
    if (!rows.length) {
      queueRows.innerHTML = '<div class="empty-state">No locations match these filters. Try resetting the search or selecting another zone.</div>';
    } else {
      queueRows.innerHTML = displayRows.map((loc, i) => {
        const cls = scoreClass(loc.priority);
        const displayIssue = state.issue === 'all' ? loc.topIssue : state.issue;
        const inc = state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0);
        const saved = reviewDecisions[loc.id];
        const reviewLabel = saved ? 'Decision saved' : 'Needs review';
        const forecast = Number.isFinite(loc.predictedQ4) ? ` · RF Q4 ${loc.predictedQ4.toFixed(1)}` : '';
        return `<button class="location-row${loc.id === state.selected ? ' selected' : ''}" data-id="${loc.id}" aria-label="View ${loc.id}, priority ${loc.priority}, ${reviewLabel}${forecast}"><span class="row-location"><span class="row-rank">${String(i + 1).padStart(2, '0')}</span><span class="row-name"><strong>${loc.id} <span class="row-zone">· ${loc.zone.replace('_', ' ')}</span></strong><small>${loc.condition} road · ${displayIssue} · ${fmt.format(inc)} incidents · ${fmt.format(loc.complaintCount)} complaints · ${fmt.format(loc.openWork)} open${forecast} · <span class="row-review${saved ? ' saved' : ''}">${reviewLabel}</span></small></span></span><span class="row-number">${fmt.format(inc)}</span><span class="row-number muted">${fmt.format(loc.complaintCount)}</span><span class="row-number muted">${fmt.format(loc.openWork)}</span><span class="priority-cell"><span class="priority-meter"><i class="${cls}" style="width:${loc.priority}%"></i></span><strong class="priority-score">${state.sort === 'forecast' && Number.isFinite(loc.predictedQ4) ? loc.predictedQ4.toFixed(1) : loc.priority}</strong></span></button>`;
      }).join('');
      queueRows.querySelectorAll('.location-row').forEach((button) => button.addEventListener('click', () => selectLocation(button.dataset.id)));
    }
    $('tableShowing').textContent = rows.length ? `Showing ${fmt.format(displayRows.length)} of ${fmt.format(rows.length)} locations` : 'Showing 0 locations';
    $('showMore').style.display = rows.length > 8 ? 'inline-block' : 'none';
    $('showMore').innerHTML = state.expanded ? 'Show fewer <span>↑</span>' : 'Show more <span>↓</span>';
  }

  function getFieldReports() {
    try {
      const value = JSON.parse(localStorage.getItem(fieldReportsStorageKey) || '[]');
      return Array.isArray(value) ? value.filter(report => report && typeof report === 'object' && report.id && report.locationId) : [];
    } catch (_) { return []; }
  }

  function saveFieldReports(reports) {
    try { localStorage.setItem(fieldReportsStorageKey, JSON.stringify(reports)); return true; }
    catch (_) { showToast('This browser is out of storage space. The field report was not saved.'); return false; }
  }

  function openEvidenceDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('Photo storage is unavailable in this browser.')); return; }
      const request = indexedDB.open(evidenceDatabaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', {keyPath: 'id'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open photo storage.'));
    });
  }

  async function putPhoto(photo) {
    const db = await openEvidenceDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('photos', 'readwrite');
      transaction.objectStore('photos').put(photo);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error || new Error('Could not save a photo.')); };
      transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Photo save was cancelled.')); };
    });
  }

  async function getPhoto(id) {
    const db = await openEvidenceDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('photos', 'readonly').objectStore('photos').get(id);
      request.onsuccess = () => { db.close(); resolve(request.result?.blob || null); };
      request.onerror = () => { db.close(); reject(request.error || new Error('Could not load a photo.')); };
    });
  }

  async function optimizePhoto(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Each image must be smaller than 20 MB.');
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const ratio = Math.min(1, 1500 / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not prepare this image.')), 'image/jpeg', 0.82));
    return {blob, name: file.name.slice(0, 100), type: 'image/jpeg'};
  }

  function releasePhotoPreviews() {
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    previewUrls = [];
  }

  async function renderPhotoPreview() {
    const root = $('photoPreview');
    releasePhotoPreviews();
    root.replaceChildren();
    const files = [...$('reportPhotos').files].slice(0, 3);
    if (!files.length) return;
    if ($('reportPhotos').files.length > 3) showToast('Choose up to three photos.');
    files.forEach(file => {
      const image = document.createElement('img');
      image.alt = `Preview of ${file.name}`;
      image.src = URL.createObjectURL(file);
      previewUrls.push(image.src);
      root.append(image);
    });
  }

  async function loadRecords() {
    if (!recordsByLocationPromise) {
      recordsByLocationPromise = fetch(recordsUrl).then(async response => {
        if (!response.ok) throw new Error('Case history is not available right now.');
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open the compressed case history.');
        const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).json();
      });
    }
    return recordsByLocationPromise;
  }

  function isFollowUp(record) {
    return record.kind === 'Incident' ? record.status === 'Open' : ['Open', 'Assigned', 'In progress'].includes(record.status);
  }

  function renderRecordSummary(records) {
    const openIncidents = records.filter(record => record.kind === 'Incident' && isFollowUp(record)).length;
    const resolvedIncidents = records.filter(record => record.kind === 'Incident' && record.status === 'Resolved').length;
    const activeComplaints = records.filter(record => record.kind === 'Complaint' && isFollowUp(record)).length;
    const closedComplaints = records.filter(record => record.kind === 'Complaint' && !isFollowUp(record)).length;
    $('recordSummary').innerHTML = `<div class="record-stat"><strong>${fmt.format(openIncidents)}</strong><span>open incidents</span></div><div class="record-stat"><strong>${fmt.format(resolvedIncidents)}</strong><span>resolved</span></div><div class="record-stat"><strong>${fmt.format(activeComplaints)}</strong><span>active complaints</span></div><div class="record-stat"><strong>${fmt.format(closedComplaints)}</strong><span>closed / resolved</span></div>`;
    $('sourceRecordsSummary').textContent = `View ${fmt.format(records.length)} source records`;
  }

  function renderSourceRecordList(records) {
    const filter = $('recordsFilter').value;
    const filtered = records.filter(record => filter === 'all'
      || (filter === 'followup' && isFollowUp(record))
      || (filter === 'incident' && record.kind === 'Incident')
      || (filter === 'complaint' && record.kind === 'Complaint'));
    const list = $('sourceRecordList');
    list.replaceChildren();
    filtered.slice(0, 12).forEach(record => {
      const item = document.createElement('article');
      item.className = 'source-record';
      const head = document.createElement('div'); head.className = 'source-record-head';
      const title = document.createElement('strong'); title.textContent = record.type || record.kind;
      const status = document.createElement('span'); status.className = `record-status ${isFollowUp(record) ? 'is-open' : 'is-closed'}`; status.textContent = record.status;
      const meta = document.createElement('p');
      const date = record.date ? new Date(record.date.replace(' ', 'T')).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'}) : 'Date unavailable';
      meta.textContent = `${record.kind} · ${date} · ${record.severity || 'Severity not supplied'}${record.injuries ? ` · ${record.injuries} injuries` : ''}`;
      head.append(title, status); item.append(head, meta); list.append(item);
    });
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.className = 'record-empty'; empty.textContent = 'No records match this filter.'; list.append(empty);
    } else if (filtered.length > 12) {
      const more = document.createElement('p'); more.className = 'record-empty'; more.textContent = `Showing 12 of ${fmt.format(filtered.length)} records. Use the filters to narrow the list.`; list.append(more);
    }
  }

  async function renderRecordHistory(loc) {
    const summary = $('recordSummary');
    if (!loc) { summary.textContent = 'Choose a problem to view report status.'; $('sourceRecordList').replaceChildren(); return; }
    summary.textContent = 'Loading case history…';
    try {
      const recordsByLocation = await loadRecords();
      if (state.selected !== loc.id) return;
      const records = recordsByLocation[loc.id] || [];
      renderRecordSummary(records);
      renderSourceRecordList(records);
    } catch (error) {
      if (state.selected !== loc.id) return;
      summary.textContent = error.message || 'Case history could not be loaded.';
      $('sourceRecordsSummary').textContent = 'Case history unavailable';
      $('sourceRecordList').replaceChildren();
    }
  }

  async function renderFieldReports(loc) {
    const root = $('fieldReportList');
    const reports = loc ? getFieldReports().filter(report => report.locationId === loc.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
    $('fieldReportCount').textContent = `${reports.length} ${reports.length === 1 ? 'report' : 'reports'}`;
    root.replaceChildren();
    if (!loc) return;
    if (!reports.length) {
      const empty = document.createElement('p'); empty.className = 'field-report-empty'; empty.textContent = 'No field photos yet. Add a report after a real-world check.'; root.append(empty); return;
    }
    reports.forEach(report => {
      const card = document.createElement('article'); card.className = 'field-report-card'; card.dataset.reportId = report.id;
      const heading = document.createElement('div'); heading.className = 'field-report-card-head';
      const title = document.createElement('div');
      const problem = document.createElement('strong'); problem.textContent = report.type || 'Field report';
      const when = document.createElement('small'); when.textContent = new Date(report.createdAt).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
      title.append(problem, when);
      const status = document.createElement('select'); status.className = 'report-status-select'; status.setAttribute('aria-label', `Update status for ${report.type || 'field report'}`);
      ['Open', 'Assigned', 'In progress', 'Fixed', 'Verified'].forEach(value => status.add(new Option(value, value)));
      status.value = report.status;
      status.addEventListener('change', () => {
        const all = getFieldReports(); const entry = all.find(item => item.id === report.id);
        if (!entry) return;
        entry.status = status.value; entry.updatedAt = new Date().toISOString();
        if (!saveFieldReports(all)) return;
        report.status = status.value;
        showToast(`Field report updated to ${status.value}.`);
      });
      heading.append(title, status); card.append(heading);
      const address = document.createElement('p'); address.className = 'field-report-address'; address.textContent = report.address || 'Location not supplied'; card.append(address);
      const note = document.createElement('p'); note.className = 'field-report-note'; note.textContent = report.note || ''; card.append(note);
      if (Number.isFinite(report.lat) && Number.isFinite(report.lon)) {
        const gps = document.createElement('small'); gps.className = 'field-report-gps'; gps.textContent = `GPS ${report.lat.toFixed(5)}, ${report.lon.toFixed(5)}`; card.append(gps);
      }
      if (report.photoIds?.length) {
        const images = document.createElement('div'); images.className = 'field-report-images'; card.append(images);
        report.photoIds.forEach(async (id, index) => {
          try {
            const blob = await getPhoto(id);
            if (!blob || !card.isConnected) return;
            const image = document.createElement('img'); image.alt = `Field evidence photo ${index + 1} for ${report.type || 'problem'}`; image.loading = 'lazy';
            const url = URL.createObjectURL(blob); image.src = url; image.addEventListener('load', () => URL.revokeObjectURL(url), {once: true});
            images.append(image);
          } catch (_) { /* The report still displays if browser photo storage is unavailable. */ }
        });
      }
      root.append(card);
    });
  }

  function resetFieldReportForm() {
    $('fieldReportForm').reset();
    $('reportType').value = data.incidentTypes[0] || '';
    releasePhotoPreviews();
    $('photoPreview').replaceChildren();
    $('fieldReportDetails').open = false;
  }

  async function saveFieldReport(event) {
    event.preventDefault();
    const loc = locations.find(item => item.id === state.selected);
    if (!loc) { showToast('Select a location before adding field evidence.'); return; }
    const latValue = $('reportLat').value.trim(), lonValue = $('reportLon').value.trim();
    if (Boolean(latValue) !== Boolean(lonValue)) { showToast('Enter both GPS coordinates, or leave both blank.'); return; }
    const files = [...$('reportPhotos').files].slice(0, 3);
    const reportId = crypto.randomUUID ? crypto.randomUUID() : `report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const photoIds = [];
    try {
      for (const [index, file] of files.entries()) {
        const prepared = await optimizePhoto(file);
        const photoId = `${reportId}-photo-${index + 1}`;
        await putPhoto({id: photoId, blob: prepared.blob, name: prepared.name, type: prepared.type});
        photoIds.push(photoId);
      }
    } catch (error) {
      showToast(error.message || 'Could not save the attached photos.');
      return;
    }
    const report = {
      id: reportId, locationId: loc.id, type: $('reportType').value,
      severity: $('reportSeverity').value, status: $('reportStatus').value,
      address: $('reportAddress').value.trim(), lat: latValue ? Number(latValue) : null,
      lon: lonValue ? Number(lonValue) : null, note: $('reportNote').value.trim(),
      photoIds, createdAt: new Date().toISOString(),
    };
    const all = getFieldReports(); all.push(report);
    if (!saveFieldReports(all)) return;
    resetFieldReportForm();
    renderMap(loc);
    await renderFieldReports(loc);
    showToast(`Field evidence saved for ${loc.id}.`);
  }

  function renderDetails(loc) {
    if (!loc) {
      $('detailId').textContent = 'No location selected';
      $('detailPriority').textContent = '—';
      $('detailMeta').textContent = 'Clear or adjust filters to see location evidence.';
      ['detailIncidents', 'detailComplaints', 'detailSeverity', 'detailOpen'].forEach(id => $(id).textContent = '—');
      $('detailReasons').innerHTML = '';
      $('detailIssue').textContent = '—'; $('detailIssueSub').textContent = ''; $('detailIssueCount').textContent = '—';
      $('decisionAction').value = ''; $('decisionNote').value = '';
      $('decisionSavedState').textContent = 'No decision';
      $('decisionSavedState').className = 'decision-state';
      $('saveDecision').disabled = true;
      $('fieldReportForm').dataset.locationId = '';
      $('fieldReportForm').querySelector('button[type="submit"]').disabled = true;
      renderRecordHistory(null);
      renderFieldReports(null);
      return;
    }
    if ($('fieldReportForm').dataset.locationId !== loc.id) resetFieldReportForm();
    $('fieldReportForm').dataset.locationId = loc.id;
    $('fieldReportForm').querySelector('button[type="submit"]').disabled = false;
    $('saveDecision').disabled = false;
    const cls = scoreClass(loc.priority);
    $('detailId').textContent = loc.id;
    $('detailPriority').textContent = `${loc.priority}/100`;
    $('detailPriority').className = `priority-chip ${cls}`;
    const context = [loc.condition, `${loc.road} road`, `${loc.pedestrian.toLowerCase()} pedestrian activity`, loc.school ? 'near a school' : '', loc.hospital ? 'near a hospital' : ''].filter(Boolean).join(' · ');
    $('detailMeta').textContent = `${loc.zone.replace('_', ' ')} · ${context} · ${fmt.format(loc.highPriority)} high-priority complaints`;
    $('detailIncidents').textContent = fmt.format(state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0));
    $('detailComplaints').textContent = fmt.format(loc.complaintCount);
    $('detailSeverity').textContent = fmt.format(loc.highCritical);
    $('detailOpen').textContent = fmt.format(loc.openWork);
    const contributions = queueLabels.map((label, i) => ({label, value: loc.components[i], weight: weights[i], points: Math.round(loc.components[i] * weights[i] * 100)})).sort((a, b) => b.points - a.points);
    $('detailReasons').innerHTML = contributions.map((item) => `<div class="reason-row"><span>${item.label}</span><span class="reason-bar"><i style="width:${Math.round(item.value * 100)}%"></i></span><strong>${item.points} pts</strong></div>`).join('');
    const selectedIssue = state.issue === 'all' ? loc.topIssue : state.issue;
    $('detailIssue').textContent = selectedIssue;
    $('detailIssueSub').textContent = state.issue === 'all' ? 'most reported incident type' : 'selected incident type';
    $('detailIssueCount').textContent = `${fmt.format(loc.incidentTypes[selectedIssue] || 0)} reports`;
    const decision = reviewDecisions[loc.id];
    $('decisionAction').value = decision?.action || '';
    $('decisionNote').value = decision?.note || '';
    $('decisionSavedState').textContent = decision ? `Saved ${new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric'}).format(new Date(decision.savedAt))}` : 'No decision';
    $('decisionSavedState').className = `decision-state${decision ? ' is-saved' : ''}`;
    renderRecordHistory(loc);
    renderFieldReports(loc);
  }

  function render() {
    const rows = currentRows();
    const selected = rows.find(x => x.id === state.selected) || rows[0] || null;
    state.selected = selected?.id || null;
    renderMetrics(rows);
    renderMap(selected);
    const leaders = renderZones(rows);
    renderBriefing(rows, leaders);
    renderTrend(rows);
    renderQueue(rows);
    renderDetails(selected);
  }

  function selectLocation(id) {
    state.selected = id;
    render();
    document.querySelectorAll('#detailCard [data-open-on-select]').forEach(section => { section.open = true; });
    requestAnimationFrame(() => $('detailCard').scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    }));
  }

  function exportQueue() {
    const rows = currentRows();
    const headers = ['location_id', 'zone', 'priority_index', 'ml_q4_incident_forecast', 'incidents_in_scope', 'all_incidents', 'high_or_critical_incidents', 'complaints', 'open_work_items', 'road_condition', 'pedestrian_activity', 'near_school', 'near_hospital', 'top_incident_type', 'review_action', 'review_note', 'review_saved_at'];
    const lines = [headers.join(','), ...rows.map(loc => { const decision = reviewDecisions[loc.id] || {}; return [loc.id, loc.zone, loc.priority, loc.predictedQ4?.toFixed(2), state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0), loc.incidentCount, loc.highCritical, loc.complaintCount, loc.openWork, loc.condition, loc.pedestrian, loc.school, loc.hospital, loc.topIssue, decision.action, decision.note, decision.savedAt].map(quoteCsv).join(','); })];
    const blob = new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'mana-nagaram-review-queue.csv';
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
    showToast(`Exported ${fmt.format(rows.length)} locations.`);
  }

  function exportReviewLog() {
    const entries = Object.entries(reviewDecisions).filter(([id, item]) => locations.some(loc => loc.id === id) && item?.action);
    if (!entries.length) { showToast('Save a review decision before exporting the log.'); return; }
    const byId = new Map(locations.map(loc => [loc.id, loc]));
    const lines = [['location_id', 'zone', 'priority_index', 'recommended_action', 'review_note', 'saved_at'].join(','), ...entries.map(([id, item]) => {
      const loc = byId.get(id);
      return [id, loc.zone, loc.priority, item.action, item.note, item.savedAt].map(quoteCsv).join(',');
    })];
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
    link.download = 'mana-nagaram-review-decisions.csv';
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
    showToast(`Exported ${fmt.format(entries.length)} saved decisions.`);
  }

  let toastTimer;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }

  function saveDecision() {
    const loc = currentRows().find(item => item.id === state.selected);
    const action = $('decisionAction').value;
    if (!loc) { showToast('Select a location before saving a decision.'); return; }
    if (!action) { showToast('Choose a recommended action first.'); $('decisionAction').focus(); return; }
    const previous = reviewDecisions[loc.id];
    reviewDecisions[loc.id] = {action, note: $('decisionNote').value.trim(), savedAt: new Date().toISOString()};
    try { localStorage.setItem(reviewStorageKey, JSON.stringify(reviewDecisions)); }
    catch (_) {
      if (previous) reviewDecisions[loc.id] = previous;
      else delete reviewDecisions[loc.id];
      showToast('Browser storage is unavailable. This decision could not be saved.');
      return;
    }
    render();
    showToast(`Review decision saved for ${loc.id}.`);
  }

  function openMethod() {
    if (methodDialog.showModal) methodDialog.showModal();
    else methodDialog.setAttribute('open', '');
  }

  zoneFilter.addEventListener('change', () => { state.zone = zoneFilter.value; state.expanded = false; render(); });
  issueFilter.addEventListener('change', () => { state.issue = issueFilter.value; state.expanded = false; render(); });
  searchInput.addEventListener('input', () => { state.search = searchInput.value.trim().toLowerCase(); state.expanded = false; render(); });
  $('resetFilters').addEventListener('click', () => { zoneFilter.value = 'all'; issueFilter.value = 'all'; searchInput.value = ''; state.zone = 'all'; state.issue = 'all'; state.search = ''; state.expanded = false; render(); });
  $('showMore').addEventListener('click', () => { state.expanded = !state.expanded; render(); });
  $('sortBy').addEventListener('change', () => { state.sort = $('sortBy').value; state.expanded = false; render(); });
  $('exportTop').addEventListener('click', exportQueue);
  $('exportActions').addEventListener('click', exportReviewLog);
  $('saveDecision').addEventListener('click', saveDecision);
  $('recordsFilter').addEventListener('change', async () => {
    const loc = locations.find(item => item.id === state.selected);
    if (!loc) return;
    try { renderSourceRecordList((await loadRecords())[loc.id] || []); }
    catch (_) { /* The status panel already reports any load failure. */ }
  });
  $('reportPhotos').addEventListener('change', renderPhotoPreview);
  $('useCurrentLocation').addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('Location access is unavailable in this browser.'); return; }
    $('useCurrentLocation').disabled = true;
    navigator.geolocation.getCurrentPosition(position => {
      $('reportLat').value = position.coords.latitude.toFixed(6);
      $('reportLon').value = position.coords.longitude.toFixed(6);
      $('useCurrentLocation').disabled = false;
      showToast('GPS coordinates added.');
    }, error => {
      $('useCurrentLocation').disabled = false;
      showToast(error.code === error.PERMISSION_DENIED ? 'Allow location access to add GPS coordinates.' : 'Could not read your current location.');
    }, {enableHighAccuracy: true, timeout: 12000, maximumAge: 0});
  });
  $('fieldReportForm').addEventListener('submit', saveFieldReport);
  $('assistantForm').addEventListener('submit', (event) => {
    event.preventDefault();
    answerQuestion($('assistantInput').value);
  });
  document.querySelectorAll('.ask-suggestions button').forEach((button) => button.addEventListener('click', () => {
    $('assistantInput').value = button.dataset.question;
    answerQuestion(button.dataset.question);
  }));
  ['methodButton', 'methodInline', 'methodBottom'].forEach(id => $(id).addEventListener('click', openMethod));
  methodDialog.addEventListener('click', (event) => { if (event.target === methodDialog) methodDialog.close(); });
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    item.classList.add('active');
  }));
  render();
  loadForecastModel();
})();

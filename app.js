(() => {
  'use strict';
  const data = window.CITYFIX_DATA;
  if (!data || !Array.isArray(data.locations)) return;

  const svgNS = 'http://www.w3.org/2000/svg';
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
  const mapSvg = $('mapSvg');
  const mapTooltip = $('mapTooltip');
  const mapStage = document.querySelector('.map-stage');
  const reviewStorageKey = 'cityfix-review-decisions-v1';
  const reviewDecisions = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(reviewStorageKey) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch (_) { return {}; }
  })();
  const queueLabels = ['Incident volume', 'Average severity', 'Complaint volume', 'Open backlog', 'Street context'];
  const bounds = {
    minLat: Math.min(...locations.map(x => x.lat)), maxLat: Math.max(...locations.map(x => x.lat)),
    minLon: Math.min(...locations.map(x => x.lon)), maxLon: Math.max(...locations.map(x => x.lon)),
  };
  const state = {zone: 'all', issue: 'all', search: '', selected: null, expanded: false, sort: 'priority', mobileDetailOpen: false};
  const zones = [...new Set(locations.map(x => x.zone))].sort((a, b) => a.localeCompare(b));
  zones.forEach((zone) => zoneFilter.add(new Option(zone.replace('_', ' '), zone)));
  data.incidentTypes.forEach((type) => issueFilter.add(new Option(type, type)));

  const scoreClass = (score) => score >= 66 ? 'high' : score >= 40 ? 'mid' : 'low';
  const currentRows = () => locations
    .filter((loc) => state.zone === 'all' || loc.zone === state.zone)
    .filter((loc) => state.issue === 'all' || (loc.incidentTypes[state.issue] || 0) > 0)
    .filter((loc) => !state.search || `${loc.id} ${loc.zone} ${loc.road} ${loc.topIssue}`.toLowerCase().includes(state.search))
    .sort((a, b) => {
      const value = (loc) => state.sort === 'open' ? loc.openWork
        : state.sort === 'complaints' ? loc.complaintCount
        : state.sort === 'incidents' ? (state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0))
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

  function renderMap(rows) {
    mapSvg.replaceChildren();
    const grid = document.createElementNS(svgNS, 'g');
    for (let x = 90; x <= 700; x += 122) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('y1', 20); line.setAttribute('y2', 322); line.setAttribute('class', 'grid-line'); grid.append(line);
    }
    for (let y = 52; y <= 300; y += 82) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', 31); line.setAttribute('x2', 718); line.setAttribute('y1', y); line.setAttribute('y2', y); line.setAttribute('class', 'grid-line'); grid.append(line);
    }
    mapSvg.append(grid);
    const minX = 34, maxX = 712, minY = 22, maxY = 318;
    const dx = Math.max(0.0001, bounds.maxLon - bounds.minLon);
    const dy = Math.max(0.0001, bounds.maxLat - bounds.minLat);
    rows.forEach((loc) => {
      const x = minX + (loc.lon - bounds.minLon) / dx * (maxX - minX);
      const y = maxY - (loc.lat - bounds.minLat) / dy * (maxY - minY);
      const selected = loc.id === state.selected;
      if (selected) {
        const halo = document.createElementNS(svgNS, 'circle');
        halo.setAttribute('cx', x); halo.setAttribute('cy', y); halo.setAttribute('r', 8); halo.setAttribute('class', 'map-halo'); mapSvg.append(halo);
      }
      const point = document.createElementNS(svgNS, 'circle');
      point.setAttribute('cx', x); point.setAttribute('cy', y);
      point.setAttribute('r', (1.6 + loc.priority / 47).toFixed(2));
      point.setAttribute('fill', loc.priority >= 66 ? '#d77c69' : loc.priority >= 40 ? '#e2ad54' : '#76b49b');
      point.setAttribute('opacity', selected ? '1' : '0.78');
      point.setAttribute('class', `map-point${selected ? ' selected' : ''}`);
      point.setAttribute('role', 'button');
      point.setAttribute('tabindex', '0');
      point.setAttribute('aria-label', `Select ${loc.id}, ${loc.zone.replace('_', ' ')}, review index ${loc.priority} out of 100`);
      point.dataset.id = loc.id;
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${loc.id} · ${loc.zone.replace('_', ' ')} · ${loc.priority}/100`;
      point.append(title);
      point.addEventListener('click', () => selectLocation(loc.id));
      point.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectLocation(loc.id); }
      });
      point.addEventListener('pointerenter', (event) => showTooltip(event, loc));
      point.addEventListener('pointermove', (event) => moveTooltip(event));
      point.addEventListener('pointerleave', () => { mapTooltip.style.display = 'none'; });
      mapSvg.append(point);
    });
  }

  function showTooltip(event, loc) {
    mapTooltip.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `${loc.id} · ${loc.zone.replace('_', ' ')}`;
    const description = document.createElement('span');
    description.textContent = `${loc.priority}/100 review index · ${fmt.format(loc.incidentCount)} incidents`;
    mapTooltip.append(title, description);
    mapTooltip.style.display = 'block';
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const rect = mapStage.getBoundingClientRect();
    mapTooltip.style.left = `${event.clientX - rect.left}px`;
    mapTooltip.style.top = `${event.clientY - rect.top}px`;
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
    const leaders = [...grouped.values()].map(x => ({...x, average: Math.round(x.score / x.count)})).sort((a, b) => b.average - a.average || b.count - a.count).slice(0, 3);
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
        return `<button class="location-row${loc.id === state.selected ? ' selected' : ''}" data-id="${loc.id}" aria-label="View ${loc.id}, priority ${loc.priority}, ${reviewLabel}"><span class="row-location"><span class="row-rank">${String(i + 1).padStart(2, '0')}</span><span class="row-name"><strong>${loc.id} <span class="row-zone">· ${loc.zone.replace('_', ' ')}</span></strong><small>${loc.condition} road · ${displayIssue} · ${fmt.format(inc)} reports · ${fmt.format(loc.complaintCount)} complaints · ${fmt.format(loc.openWork)} open · <span class="row-review${saved ? ' saved' : ''}">${reviewLabel}</span></small></span></span><span class="row-number">${fmt.format(inc)}</span><span class="row-number muted">${fmt.format(loc.complaintCount)}</span><span class="row-number muted">${fmt.format(loc.openWork)}</span><span class="priority-cell"><span class="priority-meter"><i class="${cls}" style="width:${loc.priority}%"></i></span><strong class="priority-score">${loc.priority}</strong></span></button>`;
      }).join('');
      queueRows.querySelectorAll('.location-row').forEach((button) => button.addEventListener('click', () => selectLocation(button.dataset.id)));
    }
    $('tableShowing').textContent = rows.length ? `Showing ${fmt.format(displayRows.length)} of ${fmt.format(rows.length)} locations` : 'Showing 0 locations';
    $('showMore').style.display = rows.length > 8 ? 'inline-block' : 'none';
    $('showMore').innerHTML = state.expanded ? 'Show fewer <span>↑</span>' : 'Show more <span>↓</span>';
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
      return;
    }
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
  }

  function render() {
    const rows = currentRows();
    const selected = rows.find(x => x.id === state.selected) || rows[0] || null;
    state.selected = selected?.id || null;
    renderMetrics(rows);
    renderMap(rows);
    const leaders = renderZones(rows);
    renderBriefing(rows, leaders);
    renderTrend(rows);
    renderQueue(rows);
    renderDetails(selected);
    $('detailCard').classList.toggle('is-open', state.mobileDetailOpen);
    $('detailScrim').classList.toggle('is-open', state.mobileDetailOpen);
  }

  function selectLocation(id) {
    state.selected = id;
    state.mobileDetailOpen = true;
    render();
    if (window.matchMedia('(max-width: 680px)').matches) $('detailClose').focus({preventScroll: true});
  }

  function exportQueue() {
    const rows = currentRows();
    const headers = ['location_id', 'zone', 'priority_index', 'incidents_in_scope', 'all_incidents', 'high_or_critical_incidents', 'complaints', 'open_work_items', 'road_condition', 'pedestrian_activity', 'near_school', 'near_hospital', 'top_incident_type', 'review_action', 'review_note', 'review_saved_at'];
    const lines = [headers.join(','), ...rows.map(loc => { const decision = reviewDecisions[loc.id] || {}; return [loc.id, loc.zone, loc.priority, state.issue === 'all' ? loc.incidentCount : (loc.incidentTypes[state.issue] || 0), loc.incidentCount, loc.highCritical, loc.complaintCount, loc.openWork, loc.condition, loc.pedestrian, loc.school, loc.hospital, loc.topIssue, decision.action, decision.note, decision.savedAt].map(quoteCsv).join(','); })];
    const blob = new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'cityfix-review-queue.csv';
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
    link.download = 'cityfix-review-decisions.csv';
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
  const closeLocationDetails = () => { state.mobileDetailOpen = false; render(); };
  $('detailClose').addEventListener('click', closeLocationDetails);
  $('detailScrim').addEventListener('click', closeLocationDetails);
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
})();


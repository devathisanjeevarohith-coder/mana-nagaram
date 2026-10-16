"""Build the small browser-side aggregate from the supplied synthetic CSV files."""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw" / "03_smart_city_where_fix_first"
OUT = ROOT / "data.js"


def read_csv(name: str) -> list[dict[str, str]]:
    with (RAW / name).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def number(value: str | None, default: float = 0) -> float:
    if value is None or value.strip().lower() in {"", "na", "n/a", "null", "none"}:
        return default
    try:
        return float(value)
    except ValueError:
        return default


locations = read_csv("locations.csv")
incidents = read_csv("incidents.csv")
complaints = read_csv("public_complaints.csv")
by_location: dict[str, dict] = {}

for row in locations:
    by_location[row["location_id"]] = {
        "id": row["location_id"],
        "zone": row["zone"],
        "road": row["road_type"],
        "condition": row["road_condition"],
        "density": int(number(row["population_density_per_km2"])),
        "school": row["near_school"] == "1",
        "hospital": row["near_hospital"] == "1",
        "pedestrian": row["pedestrian_activity"],
        "lat": number(row["latitude"]),
        "lon": number(row["longitude"]),
        "incidentCount": 0,
        "severityTotal": 0,
        "severityCount": 0,
        "highCritical": 0,
        "injuries": 0,
        "unresolved": 0,
        "incidentTypes": {},
        "typeSeverity": {},
        "complaintCount": 0,
        "highPriority": 0,
        "openComplaints": 0,
        "complaintCategories": {},
        "monthIncidents": [0] * 12,
        "monthByType": {},
        "monthComplaints": [0] * 12,
    }

monthly_incidents = [0] * 12
monthly_complaints = [0] * 12
incident_type_totals: Counter[str] = Counter()
severity_value = {"Low": 1, "Medium": 2, "High": 3, "Critical": 4}
valid_incident_ids = set()
valid_complaint_ids = set()
unmatched_incident_locations = 0
unmatched_complaint_locations = 0

for row in incidents:
    iid = row["incident_id"]
    valid_incident_ids.add(iid)
    loc = by_location.get(row["location_id"])
    if loc is None:
        unmatched_incident_locations += 1
        continue
    kind = row["incident_type"]
    severity = severity_value.get(row["severity"], 2)
    loc["incidentCount"] += 1
    loc["severityTotal"] += severity
    loc["severityCount"] += 1
    loc["highCritical"] += severity >= 3
    loc["injuries"] += int(number(row["injuries"]))
    loc["unresolved"] += row["resolved"] != "1"
    loc["incidentTypes"][kind] = loc["incidentTypes"].get(kind, 0) + 1
    loc["typeSeverity"][kind] = loc["typeSeverity"].get(kind, 0) + severity
    incident_type_totals[kind] += 1
    month = datetime.strptime(row["timestamp"], "%Y-%m-%d %H:%M:%S").month - 1
    monthly_incidents[month] += 1
    loc["monthIncidents"][month] += 1
    loc["monthByType"].setdefault(kind, [0] * 12)[month] += 1

for row in complaints:
    cid = row["complaint_id"]
    valid_complaint_ids.add(cid)
    loc = by_location.get(row["location_id"])
    if loc is None:
        unmatched_complaint_locations += 1
        continue
    loc["complaintCount"] += 1
    loc["highPriority"] += row["priority_reported"] == "High"
    loc["openComplaints"] += row["status"] in {"Open", "In progress", "Assigned"}
    category = row["category"]
    loc["complaintCategories"][category] = loc["complaintCategories"].get(category, 0) + 1
    month = datetime.strptime(row["created_at"], "%Y-%m-%d %H:%M:%S").month - 1
    monthly_complaints[month] += 1
    loc["monthComplaints"][month] += 1

for loc in by_location.values():
    loc["avgSeverity"] = round(loc["severityTotal"] / loc["severityCount"], 2) if loc["severityCount"] else 0
    del loc["severityTotal"]
    del loc["severityCount"]
    loc["topIssue"] = max(loc["incidentTypes"], key=loc["incidentTypes"].get) if loc["incidentTypes"] else "No incidents"

bundle = {
    "locations": list(by_location.values()),
    "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    "monthlyIncidents": monthly_incidents,
    "monthlyComplaints": monthly_complaints,
    "incidentTypes": sorted(incident_type_totals),
    "summary": {
        "locations": len(locations),
        "incidents": len(incidents),
        "complaints": len(complaints),
        "unmatchedIncidentLocations": unmatched_incident_locations,
        "unmatchedComplaintLocations": unmatched_complaint_locations,
        "uniqueIncidentIds": len(valid_incident_ids),
        "uniqueComplaintIds": len(valid_complaint_ids),
        "period": "2025",
        "synthetic": True,
    },
}

OUT.write_text("window.CITYFIX_DATA = " + json.dumps(bundle, separators=(",", ":")) + ";\n", encoding="utf-8")
print(f"Wrote {OUT.name}: {len(locations):,} locations, {len(incidents):,} incidents, {len(complaints):,} complaints")
print(f"Unique IDs: {len(valid_incident_ids):,} incidents / {len(valid_complaint_ids):,} complaints")
print(f"Unmatched location IDs: {unmatched_incident_locations} incidents / {unmatched_complaint_locations} complaints")

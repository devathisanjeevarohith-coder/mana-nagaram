# CityFix AI

City operations intelligence for reviewing where limited inspection capacity may be needed first. CityFix combines incident history, public complaints, and street context in an auditable review queue.

## Deploy

This repository is configured to publish automatically to GitHub Pages after a push to `main`.

1. Create a new **public** GitHub repository named `cityfix-ai` and push the contents of this folder to its `main` branch.
2. In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. The included workflow publishes the site. The public URL will be `https://<github-owner>.github.io/cityfix-ai/`.

No secrets, API keys, package installation, or external AI service are needed. The public site reads its bundled, precomputed data and works as a static deployment.

## Product capabilities

- Search locations and filter the review queue by zone and incident type.
- Rank the queue by the review index, open workload, complaint count, or incident count.
- Compare an interactive synthetic-coordinate plot, reporting trends, and zone summaries.
- Inspect each location's underlying incident, complaint, severity, backlog, and context evidence.
- Ask the evidence assistant questions about a location, zone, issue, severity, complaints, or open work. It computes answers from the supplied records and does not invent facts.
- Record a human-selected next step and reviewer note for a location, then export either the filtered queue or saved decisions as CSV.

Review decisions are stored in the visitor's browser and do not sync between people or devices. This public demo has no account system or shared database; use synthetic records only and do not enter personal or confidential information.

## Review index

The 0–100 review index is a transparent heuristic. It weights incident volume at 30%, average severity at 25%, complaint volume at 20%, open backlog at 15%, and street context at 10%. Count-based factors are capped and normalized against the 95th percentile of the supplied locations. The index is a review aid, not a trained risk model, forecast, or instruction to dispatch crews.

## Data and limits

The DATATHON files are synthetic educational data for 2025: 1,000 locations, 10,000 incidents, and 8,000 complaints. All location IDs join across the files. Coordinates are simulated, so the plotted points do not represent real streets or civic reports. Incident and complaint counts may describe related events. Validate findings against local data and field conditions before any operational decision.

The idea deck proposes a future Random Forest forecast. This release does not train or claim to validate that model. It implements the ranking, location investigation, evidence summary, and export workflow.

## Rebuild `data.js`

Run `python prepare_data.py` from this folder. The script reads the original files under `data/raw/` and writes the compact browser data bundle.

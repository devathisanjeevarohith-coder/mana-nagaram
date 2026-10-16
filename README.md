# Mana Nagaram

Mana Nagaram helps city teams review where limited inspection capacity may be needed first. It combines incident history, public complaints, and street context in an auditable review queue.

## Deploy

This repository is configured to publish automatically to GitHub Pages after a push to `main`.

1. Create a new **public** GitHub repository named `cityfix-ai` and push the contents of this folder to its `main` branch.
2. In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. The included workflow publishes the site. The public URL will be `https://<github-owner>.github.io/cityfix-ai/`.

No secrets, API keys, package installation, or external AI service are needed. The public site reads its bundled, precomputed data and works as a static deployment.

## Product capabilities

- Search locations and filter the review queue by zone and incident type.
- Rank the queue by the review index, open workload, complaint count, or incident count.
- See a street basemap for the selected location, with direct Google Maps links. Dataset coordinates are labeled as simulated; reviewer GPS points are shown separately.
- Inspect per-location open, resolved, assigned, and in-progress records plus recent case history.
- Add up to three compressed field photos, an exact address, optional GPS, notes, severity, and a reviewable status.
- Ask the evidence assistant questions about a location, zone, issue, severity, complaints, or open work. It computes answers from the supplied records and does not invent facts.
- Record a human-selected next step and reviewer note for a location, then export either the filtered queue or saved decisions as CSV.
- Use the separate citizen portal to submit a report, keep a report code, review all reports submitted in this browser, and follow status milestones, staff updates, and target completion time.
- In the operations workspace, assign a department and staff owner, set or revise a target, post a public update, and keep an internal handover note. Resolve or close reports with a status update for the reporter.
- Use the quick command field to open or resolve a report, assign a named staff member, filter open or resolved reports, find a location, jump to a zone, view trends or scoring, ask the evidence assistant, or export a queue.

Review decisions, field reports, citizen complaints, and photos are stored in the visitor's browser. Complaint updates sync across open tabs on the same browser and device; they do not reach a city service or sync between people and devices. This public static demo has no account system or shared database; use synthetic records only and do not enter personal or confidential information.

## Review index

The 0–100 review index is a transparent heuristic. It weights incident volume at 30%, average severity at 25%, complaint volume at 20%, open backlog at 15%, and street context at 10%. Count-based factors are capped and normalized against the 95th percentile of the supplied locations.

The experimental ML path is a 36-tree Random Forest regressor that predicts Q4 incident counts from Q1–Q3 incident and complaint counts plus street context. `train_model.py` separates 200 locations for a holdout evaluation, compares against a mean baseline, and writes `forecast-model.json`. The included synthetic benchmark does not outperform that baseline; the forecast is intentionally marked experimental and should not guide operations.

The in-page map uses the OpenStreetMap embed as a no-key street-map fallback. `google-maps-config.js` is ready for a Google Maps Embed API key. A key must be enabled and restricted to the GitHub Pages website and the Maps Embed API; do not publish an unrestricted key. The direct Google Maps link works without a key.

## Data and limits

The DATATHON files are synthetic educational data for 2025: 1,000 locations, 10,000 incidents, and 8,000 complaints. All location IDs join across the files. Coordinates are simulated, so the plotted points do not represent real streets or civic reports. Incident and complaint counts may describe related events. Validate findings against local data and field conditions before any operational decision.

All data and model results are synthetic educational material, not operational evidence. Validate against real local records, inspect for reporting bias, and use human review.

## Rebuild `data.js`

Run `python prepare_data.py` from this folder to rebuild the aggregate data and compressed case history. Then run `python train_model.py` to rebuild the experimental Random Forest model artifact.


## Deferred account setup

Sign-in and role authorization are paused. Both portals open directly and do not load the Supabase client. The account page points back to the portals; the setup files are retained for later. Reconnecting the sign-in UI and route checks will be needed before these setup steps can activate accounts:
1. Create a Supabase project in the dashboard.
2. In Project Settings → API, copy the Project URL and **publishable** key into `supabase-config.js`.
3. Run `supabase-setup.sql` in the Supabase SQL Editor. Citizen sign-ups receive the citizen role; a project owner must grant staff role to staff accounts.
4. Add the GitHub Pages URL to Supabase Auth's allowed redirect URLs.

Never place a secret/service-role key in browser code. Reports currently stay in browser storage and do not sync between accounts/devices; connect a database with Row Level Security before enabling real account access.

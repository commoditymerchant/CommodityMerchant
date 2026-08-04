# The Commodity Merchant — commoditymerchant.net

Static source for [commoditymerchant.net](https://commoditymerchant.net).

## Structure

- `index.html` — homepage (hero, market snapshot, bio/stats, newsletter, guide)
- `about/index.html` — About page
- `letters/index.html` — The Merchant's Letter archive
- `letters/issue-001/`, `letters/002-the-fed-blinked/` — individual letters

All pages are self-contained (inline CSS/JS, Google Fonts only).

## Deployment

The live site is hosted on **Netlify** (this repository is not currently
connected to it — it was empty, and this source was reconstructed from the
live site on 2026-08-04 when the guide-launch update was made). To deploy:
either connect this repo as the Netlify site's source (publish directory:
repo root, no build command), or drag-and-drop the repo contents in the
Netlify UI.

## Daily prices

`api/prices` is a static JSON snapshot read by the homepage ticker
(served as JSON via `_headers`). It is refreshed each weekday by
`.github/workflows/update-prices.yml`, which runs `scripts/update-prices.mjs`
(Yahoo Finance chart API, falling back to gold-api.com and FRED public CSVs)
and commits the result. For the live site to pick up those updates
automatically, the Netlify project must be connected to this repository;
with manual (drag-and-drop) deploys the snapshot only updates when a new
deploy is uploaded. The ticker falls back to hardcoded values in
`index.html` if the endpoint is unavailable.

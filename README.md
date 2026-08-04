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

Note: the live site also serves `/api/prices` (daily commodity prices used
by the homepage ticker). That is a Netlify serverless function whose source
is not in this repository; the ticker falls back to the hardcoded values in
`index.html` if the endpoint is unavailable.

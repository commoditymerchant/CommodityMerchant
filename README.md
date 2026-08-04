# The Commodity Merchant — commoditymerchant.net

Static source for [commoditymerchant.net](https://commoditymerchant.net).

## Structure

- `index.html` — the redesigned single-page site (home, about, letter archive
  and guide sections all render client-side from this one bundled file)
- `prices.json` — daily price snapshot the homepage reads (featured copper +
  gold/silver/aluminium/brent quotes)
- `letters/` — full typeset letter pages, linked from the archive cards:
  `issue-001`, `002-the-fed-blinked`, `003-copper-breaks-14000`, plus the
  older static archive at `letters/index.html`
- `about/` — the pre-redesign About page, kept so old inbound links resolve

## Deployment

The live site is hosted on **Netlify** and has so far been deployed manually
(Netlify Drop / drag-and-drop of these files). Connecting the Netlify project
to this repository (no build command, publish directory `.` — see
`netlify.toml`) would make every push deploy automatically, including the
daily price updates below.

## Daily prices

`.github/workflows/update-prices.yml` runs `scripts/update-prices.mjs` each
weekday evening: it fetches prices from Yahoo Finance (falling back to
gold-api.com and FRED public CSVs), writes `prices.json`, and commits the
result. The live site only picks these updates up automatically if the
Netlify project is connected to this repo; with drag-and-drop deploys the
snapshot is only as fresh as the last upload.

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

## Prices

The homepage loads `prices.json` on every visit, and refreshes gold and
silver live in the browser on top of it (gold-api.com spot). Copper and
aluminium are LME official settlements — exchange data with no free
browser-side feed — so they come from the snapshot file.

`.github/workflows/update-prices.yml` runs `scripts/update-prices.mjs`
every 2 hours on weekdays: LME copper & aluminium 3-month from Westmetall's
settlement table, gold/silver/Brent from Yahoo Finance (fallbacks:
gold-api.com, FRED). It commits `prices.json` when values change and, if
`NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` repository secrets are configured,
deploys the site straight to Netlify. Without those secrets (or a linked
repo), the live site's snapshot is only as fresh as the last manual deploy.

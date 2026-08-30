# Asset Provenance

> Historical provenance record for the 2026-07-28 capture set. It proves the
> origin of these files, not current product parity.

*Prepared 2026-07-28.*

## Composition method

The exported PNG files are deterministic HTML and CSS compositions rendered at their exact target dimensions. Product-interface imagery comes from direct captures of the live first-party surface at `https://agents.suedeai.ai`.

No generated customer records, logos, testimonials, earnings, or private data appear in the assets.

## Live source captures

| Capture | Live route | Role in the asset suite |
|---|---|---|
| `homepage-hero-1440x900.png` | `/` | Agent-company org chart and connected-flow proof |
| `company-templates-1440x900.png` | `/company` | Company starter and specialist-role proof |
| `guided-builder-1440x900.png` | `/start` | Plain-language entry proof |
| `studio-contract-scan-1440x900.png` | `/build/new?template=contract-redflag-scan` | Visual workflow, Draft/Test/Live, version, and cost-control proof |
| `website-to-agent-1440x900.png` | `/from-website` | Bounded website-grounded drafting proof |
| `public-agent-sales-scorecard-1440x900.png` | `/a/sales-call-scorecard-pulfa` | Public service, price, Live state, dry-run, and endpoint proof |

## Deterministic overlays

Exact campaign text, inventory counts, qualifications, labels, and UI masks are owned by `render-assets.html`. The masks prevent unsupported live-page wording from being repeated as an approved campaign claim.

## Evidence boundaries

- `29 priced public services` is a point-in-time live catalog count.
- Public machine-call counters are not shown as paid or settled revenue.
- The public agent screenshot is used to prove a service boundary, not demand.
- The org chart is used to prove organizational structure, not shared company memory or autonomous delegation.
- The control asset is used to explain state separation. It does not claim external acceptance tests passed.
- No uptime percentage is presented.

## Reproduction

Serve the repository root locally and open:

`/docs/marketing/assets/render-assets.html?asset=<asset-id>`

Render at 1200 by 630 pixels for the five landscape assets and 1080 by 1080 pixels for the square asset. The canonical filenames and checksums are in `../agent-studio-asset-manifest.json`.

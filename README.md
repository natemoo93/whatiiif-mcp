# whatiiif MCP server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets
agents find, read, and cite digitized primary sources published via IIIF.

- Transport: Streamable HTTP, stateless. Endpoint: `/mcp`.
- Runs as a Cloudflare Worker (`whatiiif-mcp`).
- No login. Read-only: every tool fetches public material and changes nothing.
- Identifies itself honestly to every institution it contacts, honours robots.txt, and
  rate limits itself. See [How it stays a polite client](#how-it-stays-a-polite-client).

## Before you deploy

This server sends requests to libraries, archives and museums on your behalf. Running a
copy makes you responsible for that traffic, so three things are not optional:

1. **Set `CONTACT`** in `wrangler.jsonc` to an https URL or an email address you read. It
   goes in the User-Agent of every outbound request
   (`whatiiif-mcp/0.1.0 (+https://your.site/contact)`), so an institution that sees the
   traffic can reach you. The server answers 503 until it is set.
2. **Set `PUBLIC_ORIGIN`** to the address the Worker is served from.
3. **Leave `RESPECT_ROBOTS` on** and leave the rate limits low. Every deployment of this
   software draws on the same institutions' servers, each with its own budget.

Also worth knowing before you start:

- **Use a custom domain if other people will use it.** The Cache API does not persist on
  a `workers.dev` address, so nothing is cached there and every call reaches the
  institution. The server notices and applies a stricter per-institution limit (10 a
  minute) until it is given a custom domain.
- **API keys are yours to get.** Europeana and DPLA each issue free keys under their own
  terms. Set them with `npx wrangler secret put`, never in a file in the repository.
- **Links open on whatiiif.com.** The deep links and embed snippets `make_citation`
  returns point at the public viewer at whatiiif.com, and Internet Archive items that
  bundle several works use its `/ia-manifest` route. Your users' links therefore depend
  on that site.
- **What is logged.** Workers observability is on in `wrangler.jsonc`, so Cloudflare keeps
  request logs for your account. The code itself logs one thing: the message and stack of
  an unexpected exception. It does not log queries, URLs or results. Turn observability
  off in `wrangler.jsonc` if you do not want request logs.

## Tools

| Tool | What it does |
|---|---|
| `search(query, sources?, limit?)` | Free text → candidate items with manifest URLs, from a few institutions' search APIs |
| `resolve(url_or_query, allow_page_scan?)` | Item page URL, manifest URL, whatiiif link, or Content State token → IIIF manifest URL |
| `get_manifest(id, canvas_offset?, canvas_limit?)` | Label, metadata, rights, provider, text-layer status, page hints, paginated canvas list |
| `get_thumbnails(manifest, canvases?, start?, count?, size?)` | Up to 12 small page images in one call, each labelled with its canvas index and label, for surveying a volume |
| `get_image(manifest, canvas, region?, size?)` | A page or a region of it, as an image for a vision model |
| `make_citation(manifest, canvas, region?, style?, label?)` | whatiiif deep link, Content State token, formatted citation, rights, provenance |

`canvas` is a 0-based index or a canvas id. `region` is `"x,y,w,h"` in the canvas's own
pixel space, the same space whatiiif's `xywh` uses. `get_image` and `make_citation` take
`manifest` as well as `canvas` because a canvas id is generally not dereferenceable by
itself.

Every successful response carries:

- `rights`: the rights statement URI (or `null`), attribution, the institution's free-text
  rights note, provider, and source page, exactly as the manifest declares them. Nothing
  is inferred. A missing rights statement is reported as missing.
- `provenance`: the manifest URL, when it was fetched from the institution, and whether
  this response came from cache.

## Coverage resource

`whatiiif://coverage` is an MCP resource: a short Markdown page listing the sources
`search` queries, the institutions `resolve` has handlers for, and what the server cannot
reach. Resources are attached by the user (or the host), not called by the model, so this
is for a user who wants to tell the model up front what is and is not reachable.

It is generated in `src/coverage.js` from `PLATFORMS` in `src/lib/detect.js` and `SOURCES` in
`src/tools/search.js`, so a new handler or source appears without further work, and a
keyed source with no key stays hidden. The per-institution remarks are the hand-written
`NOTES` map in that file, keyed by handler name: renaming a handler drops its remark
silently. Nothing is fetched to build the page.

## Page hints

`get_manifest` includes `page_hints`, computed for the whole item from what the manifest
declares and nothing else:

- `pages_that_differ`: canvases whose shape or scan size departs from the item's typical
  page, with the reason (wider, narrower, larger, smaller, or declared non-paged).
- `notable_labels`: labels an institution wrote for particular pages ("[Front cover]",
  "69v and 70r"), as opposed to plain page or folio numbers.
- `sections`: the institution's table of contents (IIIF ranges), when there is one.
- `typical_page`, `orientation_counts`, `label_kinds`: the overall picture.

Each canvas in the list also carries `aspect`, `orientation` and `label_kind`.

No image is examined, so these say where to look, not what is there. A page that differs
from the rest is often a fold-out, plate, map or cover, and the response says to confirm
with `get_thumbnails` or `get_image`. When pages are uniform and labels are just numbers,
it says so plainly.

## Search

`search` queries institutions' own documented search APIs, one request per source per
call, in parallel, through the same cache and rate limits as everything else.

| Source id | API | Notes |
|---|---|---|
| `internet_archive` | `archive.org/advancedsearch.php` | Texts and images, lending-restricted items excluded |
| `wellcome` | `api.wellcomecollection.org/catalogue/v2/works` | Only works with a IIIF Presentation location; licence per item |
| `artic` | `api.artic.edu/api/v1/artworks/search` | Public-domain works only. Sends the `AIC-User-Agent` header their terms ask for, carrying your `CONTACT` |
| `digital_scriptorium` | `search.digital-scriptorium.org/catalog.json` | Manuscripts in US libraries. Results carry no manifest; pass `item_url` to `resolve` |
| `europeana` | `api.europeana.eu/record/v2/search.json` | Needs your own key: `npx wrangler secret put EUROPEANA_API_KEY`. Without one it is left out of the tool description, the `sources` list and the results entirely |
| `dpla` | `api.dp.la/v2/items` | Needs your own key: `npx wrangler secret put DPLA_API_KEY`, hidden without one like Europeana. Not filtered to IIIF records: results without a manifest carry `manifest_url: null` and the institution's page for `resolve` |
| `biblissima` | `iiif.biblissima.fr/collections/search` | **Off by default.** Biblissima has no API, so this reads its HTML results page, checked against robots.txt on each call. Enable with `ENABLE_BIBLISSIMA_SEARCH: "true"`, and ask Biblissima first if other people will use your server |

What it is careful about:

- **Coverage is those sources only.** The response says so, so an empty result is not
  read as "does not exist". Anything held elsewhere goes through `resolve` with a URL.
- **`manifest_url` is derived, not fetched** (`manifest_verified: false`). A result is
  confirmed when `get_manifest` succeeds on it. Europeana in particular lists records
  whose image servers no longer answer.
- **Partial failure is normal.** `per_source` reports each source's status and total
  matches. The call only errors (`search_failed`) when no source answered.
- **Rights** per result are what that source's API reports, or `null`.

To add a source, add an entry to `SOURCES` in `src/tools/search.js`: a URL builder and a
mapper to the common result shape. Use an official API, check its terms and robots.txt,
and run results through `get_manifest` and `get_image` before shipping. Do not add a
source that works by reading a site's HTML unless it is opt-in like Biblissima. Library of
Congress has a good API but blocks Cloudflare, so it is not included.

## Embedded viewer

`make_citation` returns an `embed` object alongside the link:

- `embed.html` is an `<iframe>` snippet for the whatiiif `/embed` viewer on that page or
  region, the same one the highlight page offers. It is plain text, so it works with any
  client, and is what to paste into a web page or LMS.
- In hosts that support [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)
  (claude.ai, Claude Desktop, VS Code Copilot and others), a panel is shown to the user in
  the conversation. The tool declares `_meta.ui.resourceUri`; the host renders that page
  (`src/viewer.js`) in a sandboxed iframe and passes it the tool result. The panel shows
  the region cropped tight, the whole page with the region outlined, the attribution and
  rights line, and links to the zoomable whatiiif view and the institution's page.
- Hosts without MCP Apps support ignore the metadata and show the text result.

**The panel is a tight crop on purpose, not the embed viewer.** Its job is to point at
something, usually a passage of text. The `/embed` viewer frames a region inside a
deep-zoom view shaped by the panel, so neighbouring lines show around an excerpt and it
stops saying "this, exactly". A copy of the embed viewer inside the panel was built and
then removed for that reason. Deep zoom is one click away on "Open in whatiiif".

Other things the panel deliberately does not do:

- **It does not frame `whatiiif.com/embed`.** claude.ai blocks nested frames inside a
  panel (it rendered as a black box), whatever the server declares.
- **It never loads from an institution's image host**, since those are unbounded and a UI
  resource must declare its origins up front. Images come from this server's own
  `GET /img` route, the one origin the resource declares (`csp.resourceDomains`), and if
  the host blocks that, from the `get_image` tool called through the host as a `data:`
  URI.

`GET /img?manifest=&canvas=&region=&size=` takes the same arguments as `get_image` and
runs the same code, so it only ever serves an image derived from a manifest, through the
same cache and rate limits. It is not a general image proxy.

Operational notes:

- The panel's address is `PUBLIC_ORIGIN` in `wrangler.jsonc`. Change it if the route
  changes. For local testing it comes from `.dev.vars` (see `.dev.vars.example`).
- Hosts cache a UI resource by its URI. After changing the panel, bump the version in
  `VIEWER_URI` (`src/viewer.js`) or clients may keep showing the old one.
- The panel can be tested in a real browser without an MCP host: serve a page that puts
  the resource HTML in a sandboxed iframe under the CSP a host would apply, answers
  `ui/initialize`, and sends `ui/notifications/tool-result`.

## Errors

Errors set `isError: true` and return `{ error: { code, message, ... } }`. They say what
happened, not something more comfortable:

| Code | Meaning |
|---|---|
| `search_not_supported` | Free text was passed to `resolve`. Use `search`, or pass a URL. |
| `search_failed` | No search source answered; `per_source` says what each reported |
| `no_manifest_found` | No handler matched and the URL is not a manifest, or a page scan found nothing |
| `not_iiif` | The URL returned something that is not a IIIF manifest |
| `collection_not_manifest` | A Collection was passed where a manifest is needed; members are listed |
| `blocked_by_institution` | The institution refused this server (403, bot challenge). Reported, never worked around |
| `robots_disallowed` | A handler lookup, a derived manifest URL or a page scan was skipped because the site's robots.txt disallows it |
| `not_configured` | The operator has not set `CONTACT`, so no requests are made |
| `rate_limited` | This server's per-institution limit, or the institution's own 429; includes `retry_after` |
| `upstream_timeout`, `upstream_unreachable`, `upstream_error`, `not_found`, `too_large` | Network and HTTP failures |
| `canvas_out_of_range`, `invalid_region`, `region_out_of_bounds` | Bad arguments, with the valid range |
| `level0_no_region` | The image service is IIIF level 0 and cannot crop |
| `no_image`, `image_unavailable`, `no_canvases` | Nothing to show |

There is no text-returning tool in this version. `get_manifest` reports
`text_layer.available: false` with the reason when a manifest declares no OCR or
transcription, so an agent knows the pages must be read visually.

## Untrusted content

Nearly every piece of text these tools return was written by someone else: a manifest's
label and metadata, a page label, a search hit's title. `resolve` accepts any URL, so that
someone can be anyone. Since the text lands in a model's context, it could be written to
steer the model.

Every result therefore:

- starts with an `untrusted_content` note saying the descriptive text is third-party data
  and must not be followed as instructions;
- has control characters and text-direction override marks removed, which have no place in
  a label and can hide or disguise text;
- carries a `possible_prompt_injection` block, quoting the text, when something in it is
  phrased like an instruction to an assistant.

The server instructions tell the model the same thing. This reduces the risk and makes
crude attempts visible. It is not a filter and cannot make a model immune; nothing is
removed or rewritten because of what it says.

Related safeguards: labels are length-capped; the panel's "View at institution" link
shows the site it leads to; only http(s) links are ever shown.

## How it stays a polite client

All network access goes through `src/polite.js`. Nothing else in the server calls `fetch`.

- **Honest identification.** Every request carries
  `User-Agent: whatiiif-mcp/<version> (<your CONTACT>)`. The server never presents itself
  as a browser and sends no forged `Referer` or browser-only headers. An institution that
  turns away identified automated clients has made a decision; the server reports
  `blocked_by_institution` and stops. Do not change this to get past a block. Ask the
  institution instead.
- **robots.txt.** Checked, under the product token `whatiiif-mcp` and then `*`, before
  every request the server works out for itself:
  - the lookups a `resolve` handler makes (a catalogue API, an item page);
  - the manifest URL a handler derives by rule from an item URL;
  - the page a page scan reads, and each link it then probes;
  - an HTML search results page (Biblissima).

  A robots.txt that answers with a server error is treated as disallowing everything, a
  missing one as allowing everything (RFC 9309). What is not gated: a manifest URL the
  caller passes by name, and the images that manifest points to. That is one
  user-directed fetch of a named document, which is what a browser does, not crawling.
  The documented JSON search APIs are not gated either; they are published to be called.
- **Cache.** Manifests and `info.json` for 24 hours, images for 7 days, misses for 5
  minutes. A repeated call costs the institution nothing. Needs a custom domain (see
  "Before you deploy").
- **Per-institution rate limit.** 30 requests per minute per upstream hostname, shared by
  everyone using your deployment, or 10 while it is on `workers.dev`. An institution's own
  429 or `Retry-After` sets a backoff that is honoured.
- **Per-client rate limit.** 60 requests per minute per caller IP. For `/mcp` the caller
  is the chat host's server, so all users of one host share this budget.
- **Page scan is opt-in** (`allow_page_scan: true`) and capped at 8 probes.
- **Thumbnails are capped** at 12 per call, and the tool tells the model to sample a long
  volume instead of paging through it.
- **Limits.** 15 second timeout, size ceilings, http(s) only. Private, local, link-local
  and carrier-NAT addresses are refused, including IPv4 written inside IPv6, and every
  redirect hop is checked before it is followed. When run locally, hostnames are also
  checked against public DNS so a public-looking name cannot point the server at your own
  network; if that check cannot be made, the request is refused. `get_image` only fetches
  from an image service found inside a manifest, so it is not a general image proxy.

### Institutions with no handler, on purpose

- **Yale Library** (`collections.library.yale.edu`): its robots.txt disallows the manifest
  path for all agents.
- **Princeton University Library** (DPUL and the main catalogue): finding a manifest needs
  a search against Figgy, whose robots.txt is `Disallow: /`.

Items at both can still be read by passing the IIIF manifest URL itself, copied from the
item page. Do not add a handler for either without the library's agreement.

Some institutions refuse automated or cloud-hosted clients outright (the Library of
Congress, Princeton DPUL's item pages). Their handlers are kept because they work in some
settings, and they return `blocked_by_institution` where they do not.

### Adding a handler

A handler is one entry in `PLATFORMS` in `src/lib/detect.js`. Before adding one:

- verify it against real item URLs from the institution, not a documentation example;
- read the institution's robots.txt and API terms;
- prefer a documented API or a URL rule over reading an HTML page;
- do not add request headers to get past a block.

## Code layout

| File | What it holds |
|---|---|
| `src/index.js` | The MCP server: tool definitions, instructions, the `/img` route |
| `src/polite.js` | All network access: identification, robots.txt, cache, rate limits, address guard |
| `src/trust.js` | Treating institution-supplied text as untrusted |
| `src/iiif.js` | Manifest loading and the rights and provenance blocks |
| `src/lib/detect.js` | Institution handlers, page-scan heuristics, canvas and image-service helpers |
| `src/lib/manifest.js` | Label, rights, provider and attribution readers |
| `src/tools/` | One file per tool |
| `src/viewer.js`, `src/coverage.js`, `src/pages.js`, `src/cite.js` | The panel, the coverage resource, page hints, citation formats |

## Run and test locally

```
npm install
cp .dev.vars.example .dev.vars     # then put your own contact in it
npx wrangler dev --port 8799
```

Then, in another terminal, the MCP Inspector:

```
npx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP" and URL `http://127.0.0.1:8799/mcp`. Or from the
command line:

```
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8799/mcp --transport http --method tools/list

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8799/mcp --transport http \
  --method tools/call --tool-name resolve \
  --tool-arg url_or_query=https://cudl.lib.cam.ac.uk/view/MS-ADD-03996
```

A local run sends requests from your own network, under your own contact. The same
politeness rules apply.

## Deploy

Set `CONTACT` and `PUBLIC_ORIGIN` in `wrangler.jsonc`, then:

```
npx wrangler deploy
```

This publishes to `whatiiif-mcp.<account>.workers.dev`. To serve from your own domain,
create a proxied DNS record in the Cloudflare dashboard first (wrangler cannot create DNS
records), then add the `routes` line shown at the bottom of `wrangler.jsonc` and set
`PUBLIC_ORIGIN` to match.

Open the deployment's front page (`/`) to check it: it shows the contact, the exact
User-Agent being sent, and whether robots.txt is honoured.

Two things differ between local and deployed:

- The Cache API does not persist on `workers.dev`; caching only takes effect on a custom
  domain.
- Deployed requests leave from Cloudflare's network. Institutions that block cloud
  hosting return `blocked_by_institution` once deployed even if they answered locally.

## If you run an institution's servers

Each deployment of this software is run by someone different. The operator's contact is
in the User-Agent of every request and on the deployment's front page. To address the
software itself in robots.txt, use the token `whatiiif-mcp`:

```
User-agent: whatiiif-mcp
Disallow: /
```

That is honoured by every deployment that has not deliberately switched robots.txt off.
If the software's default behaviour is the problem, please open an issue on this
repository.

## Security

See [SECURITY.md](SECURITY.md).

## License

Copyright (c) 2026 Nate Moore.

Licensed under the GNU Affero General Public License, version 3 or any later version
(AGPL-3.0-or-later). See [LICENSE](LICENSE). If you run a modified copy of this server for
other people to use, the license requires you to make your modified source available to
them.

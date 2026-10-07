/* resolve: institution page URL (or manifest URL, whatiiif link, Content State
   token) -> IIIF manifest URL.

   The matching is detect.js's PLATFORMS and page-scan heuristics. This file
   only sequences them: a known handler first, then the URL as a manifest in
   its own right, then (only if the caller opted in) reading the page and
   probing what it links to.

   robots.txt: the URL the caller passed is fetched as given. Everything the
   server derives from it (a handler's lookups, the manifest URL a handler
   builds, the page-scan probes) is checked first. */

import {
  detect, getLabel, loadManifest, docType, collectionMembers,
  rightsBlock, provenanceBlock, canvasId
} from '../iiif.js';
import { politeFetch, robotsAllows, collectRobotsRefusals, ToolError } from '../polite.js';

const PROBE_CAP = detect.SNIIIFFER_PROBE_CAP; // 8

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return url; }
}

function describe(m, extra) {
  const type = docType(m.doc);
  const out = Object.assign({
    manifest_url: m.url,
    type: type,
    label: getLabel(m.doc.label) || null
  }, extra);
  if (type === 'Collection') {
    const members = collectionMembers(m.doc);
    out.collection_members = members.slice(0, 50);
    out.collection_member_count = members.length;
    out.note = 'This is a Collection. Pass one of collection_members to get_manifest; nested collections are not followed.';
  } else {
    out.canvas_count = detect.getCanvases(m.doc).length;
  }
  out.rights = rightsBlock(m.doc);
  out.provenance = provenanceBlock(m);
  return out;
}

/* Which page was the pasted URL showing? Only a hint that can be placed
   against the real manifest is reported; otherwise null, never a guess. */
function canvasHint(inputUrl, m) {
  if (docType(m.doc) === 'Collection') return null;
  const hint = detect.extractPageHint(inputUrl);
  if (!hint) return null;
  const cvs = detect.getCanvases(m.doc);
  const idx = detect.resolveHintIndex(hint, cvs);
  if (idx === -1) return null;
  const out = { index: idx, canvas_id: canvasId(cvs[idx]) };
  const xy = inputUrl.match(/[?&]xywh=(\d+,\d+,\d+,\d+)/);
  if (xy) out.region = xy[1];
  return out;
}

async function pageScan(pageUrl) {
  if (!(await robotsAllows(pageUrl))) {
    throw new ToolError('robots_disallowed',
      'The site\'s robots.txt asks automated clients not to read ' + pageUrl + ', so the page scan was not run. ' +
      'If you can find the manifest link on the page yourself, pass that URL instead.', { url: pageUrl });
  }
  let candidates = [];
  let base = pageUrl;
  const r = await politeFetch(pageUrl, { kind: 'page' });
  if (r.status === 200) {
    base = r.url || pageUrl;
    candidates = detect.scanHtml(await r.text(), base);
  }
  candidates = detect.dedupeByUrl(candidates.concat(detect.suffixGuesses(pageUrl)));

  let probed = 0;
  const tried = [];
  for (let i = 0; i < candidates.length; i++) {
    if (probed >= PROBE_CAP) break;
    const c = candidates[i];
    // Guessed URLs are the crawler-shaped part, so each one is robots-checked.
    if (!(await robotsAllows(c.url))) { tried.push({ url: c.url, result: 'skipped (robots.txt)' }); continue; }
    probed++;
    try {
      const m = await loadManifest(c.url);
      return { m: m, source: c.source, probes: probed };
    } catch (e) {
      if (e instanceof ToolError && e.code === 'rate_limited') throw e;
      tried.push({ url: c.url, result: (e && e.code) || 'failed' });
    }
  }
  throw new ToolError('no_manifest_found',
    'Read the page and probed ' + probed + ' candidate URL(s); none was a IIIF manifest. ' +
    (r.status !== 200 ? 'The page itself returned HTTP ' + r.status + ', so only blind guesses were possible. ' : '') +
    'The item may not be published via IIIF, or its manifest may only be built in the browser.',
    { url: pageUrl, tried: tried });
}

export async function resolve(args) {
  const input = String(args.url_or_query || '').trim();
  if (!input) throw new ToolError('invalid_input', 'url_or_query is empty.');

  if (!/^https?:\/\//i.test(input)) {
    // A bare Content State token (base64url JSON) is the one non-URL form accepted.
    const cs = /^[A-Za-z0-9_-]{24,}$/.test(input) ? detect.parseContentState(input) : null;
    if (cs && cs.manifestId) {
      const m0 = await loadManifest(cs.manifestId);
      return describe(m0, { platform: 'IIIF Content State', method: 'content-state', canvas_hint: null });
    }
    throw new ToolError('search_not_supported',
      'resolve takes a URL, not a search query. Use the search tool for free text. If that does not find the item, ' +
      'use your own web search tool, if you have one, to find its page on the holding institution\'s website, and pass that URL here.',
      { query: input });
  }

  // ?iiif-content= on any viewer link
  const csParam = input.match(/[?&#]iiif-content=([^&#]+)/);
  if (csParam) {
    let tok = csParam[1];
    try { tok = decodeURIComponent(tok); } catch (e) {}
    const cs = detect.parseContentState(tok);
    if (cs && cs.manifestId) {
      const m1 = await loadManifest(cs.manifestId);
      return describe(m1, { platform: 'IIIF Content State', method: 'content-state', canvas_hint: null });
    }
  }

  const platform = detect.detectPlatform(input);
  if (platform && platform.name !== 'Direct manifest URL') {
    let manifestUrl = null, refused = [];
    try {
      const run = await collectRobotsRefusals(function () { return platform.resolve(input); });
      manifestUrl = run.value;
      refused = run.refused;
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
    if (!manifestUrl && refused.length) {
      throw new ToolError('robots_disallowed',
        'Recognised this as ' + platform.name + ', but finding its manifest needs a lookup at ' + hostOf(refused[0]) +
        ' that the site\'s robots.txt asks automated clients not to make, so it was not made. ' +
        'If the item page shows a IIIF manifest link, pass that URL instead.',
        { url: input, platform: platform.name });
    }
    // A manifest URL the handler built by rule is the server's own guess at
    // where to look, so it is checked too. One the handler merely read out of
    // the pasted URL (a viewer link's ?manifest=) is the caller's.
    if (manifestUrl && input.indexOf(manifestUrl) === -1 && input.indexOf(encodeURIComponent(manifestUrl)) === -1 &&
        !(await robotsAllows(manifestUrl))) {
      throw new ToolError('robots_disallowed',
        'Recognised this as ' + platform.name + ', but ' + hostOf(manifestUrl) + '\'s robots.txt asks automated clients ' +
        'not to request the address its manifest would be at, so it was not requested. ' +
        'If the item page shows a IIIF manifest link, pass that URL instead.',
        { url: input, platform: platform.name });
    }
    if (!manifestUrl) {
      throw new ToolError('no_manifest_found',
        'Recognised this as ' + platform.name + ', but could not find a manifest for it. ' +
        (/CURIOSity/.test(platform.name)
          ? 'Some CURIOSity records are missing from Harvard\'s LibraryCloud index and cannot be resolved automatically; copy the manifest link from the item page and pass that.'
          : 'The lookup this institution requires may have been blocked or returned nothing; the item may also not be published via IIIF.'),
        { url: input, platform: platform.name });
    }
    const m2 = await loadManifest(manifestUrl);
    return describe(m2, { platform: platform.name, method: 'handler', canvas_hint: canvasHint(input, m2) });
  }

  // No handler (or it already looks like a manifest URL): try it as a manifest.
  let directErr = null;
  try {
    const m3 = await loadManifest(input);
    return describe(m3, { platform: 'Direct manifest URL', method: 'direct', canvas_hint: canvasHint(input, m3) });
  } catch (e) {
    if (e instanceof ToolError && (e.code === 'rate_limited' || e.code === 'invalid_url')) throw e;
    directErr = e;
  }

  if (!args.allow_page_scan) {
    throw new ToolError('no_manifest_found',
      'No built-in handler matches this URL and it is not itself a IIIF manifest (' +
      ((directErr && directErr.code) || 'failed') + '). ' +
      'Call again with allow_page_scan: true to read the page and look for a manifest link. ' +
      'That makes up to ' + PROBE_CAP + ' extra requests to the institution, so it is opt-in.',
      { url: input });
  }

  const found = await pageScan(input);
  return describe(found.m, {
    platform: 'Resolved by page scan',
    method: 'page-scan',
    page_scan: { matched_by: found.source, probes: found.probes,
      caution: 'A page scan proves the result is a manifest, not that it is the manifest for this exact item. Check the label.' },
    canvas_hint: canvasHint(input, found.m)
  });
}

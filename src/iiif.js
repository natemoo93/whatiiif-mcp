/* iiif.js: manifest reading for the MCP tools.
 *
 * The parsing itself lives in two libraries:
 *
 *   lib/detect.js     PLATFORMS handlers, page-scan heuristics, getCanvases,
 *                     getServiceBase, iiifUrl, getCanvasDimensions,
 *                     Content State, links
 *   lib/manifest.js   getLabel and the rights / provider / attribution
 *                     helpers, level-0 handling
 *
 * This file adds fetching, validation, and the rights and provenance blocks
 * every tool response carries.
 */

import detect from './lib/detect.js';
import {
  getLabel, getSourcePageUrl, getProvider, getAttribution, getRights,
  iiifLevel0, infoSizes, snapSize
} from './lib/manifest.js';
import { politeFetch, ToolError } from './polite.js';

export { detect, getLabel, iiifLevel0, infoSizes, snapSize };

// Output-size ceilings an image service advertises in info.json. Cantaloupe
// enforces these strictly and 403s any request that exceeds them.
function infoCaps(info){
  if(!info) return null;
  var c={};
  if(typeof info.maxWidth==='number'&&info.maxWidth>0) c.maxWidth=info.maxWidth;
  if(typeof info.maxHeight==='number'&&info.maxHeight>0) c.maxHeight=info.maxHeight;
  if(typeof info.maxArea==='number'&&info.maxArea>0) c.maxArea=info.maxArea;
  return (c.maxWidth||c.maxHeight||c.maxArea)?c:null;
}
/* Largest width <= `w` that satisfies every advertised ceiling, preserving the
   w:h aspect ratio. Returns `w` unchanged when nothing is advertised. */
function capWidth(w,h,caps){
  if(!caps||!(w>0)) return w;
  var out=w;
  if(caps.maxWidth) out=Math.min(out,caps.maxWidth);
  if(h>0){
    var ar=w/h;
    if(caps.maxHeight) out=Math.min(out,Math.floor(caps.maxHeight*ar));
    // area = width * (width/ar)  =>  width = sqrt(area * ar)
    if(caps.maxArea) out=Math.min(out,Math.floor(Math.sqrt(caps.maxArea*ar)));
  }
  return Math.max(1,Math.floor(out));
}

export { infoCaps, capWidth };

/* Image API 2 puts maxWidth/maxHeight/maxArea inside the profile array's
   object member rather than at the top level (Yale does). Lift them so
   infoCaps, which reads the top level, sees them. Top-level values win. */
export function capsFromInfo(info) {
  if (!info) return null;
  const merged = {};
  const prof = Array.isArray(info.profile) ? info.profile : [];
  prof.forEach(function (p) {
    if (p && typeof p === 'object') {
      ['maxWidth', 'maxHeight', 'maxArea'].forEach(function (k) { if (typeof p[k] === 'number') merged[k] = p[k]; });
    }
  });
  ['maxWidth', 'maxHeight', 'maxArea'].forEach(function (k) { if (typeof info[k] === 'number') merged[k] = info[k]; });
  return infoCaps(merged);
}

export function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function statusError(url, status) {
  const host = hostOf(url);
  if (status === 403 || status === 401) {
    const loc = host.indexOf('loc.gov') !== -1;
    return new ToolError('blocked_by_institution',
      host + ' refused this server (HTTP ' + status + '). ' +
      (loc ? 'The Library of Congress turns away automated clients and requests from cloud hosting networks; the item is public and opens normally in a browser.'
           : 'The resource may be restricted, or the institution may turn away automated or cloud-hosted clients. It may still open in a browser.'),
      { institution: host, url: url, http_status: status });
  }
  if (status === 404 || status === 410) {
    return new ToolError('not_found', 'Nothing at ' + url + ' (HTTP ' + status + '). The institution may have moved or removed it.',
      { institution: host, url: url, http_status: status });
  }
  if (status === 202) {
    return new ToolError('blocked_by_institution',
      host + ' answered with a bot challenge instead of content (HTTP 202). It may still open in a browser.',
      { institution: host, url: url, http_status: status });
  }
  return new ToolError('upstream_error', host + ' returned HTTP ' + status + '.', { institution: host, url: url, http_status: status });
}

/* Fetch and validate a IIIF manifest or collection.
   Returns { doc, url, fetchedAt, fromCache }. */
export async function loadManifest(url) {
  const r = await politeFetch(url, { kind: 'json' });
  if (r.status !== 200) throw statusError(url, r.status);
  const text = await r.text();
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    throw new ToolError('not_iiif', 'The response from ' + url + ' is not JSON, so it is not a IIIF manifest' +
      (/^\s*</.test(text) ? ' (it looks like an HTML page).' : '.'), { url: url });
  }
  if (!detect.looksLikeManifest(doc)) {
    throw new ToolError('not_iiif', 'The JSON at ' + url + ' is not a IIIF Presentation manifest or collection.', { url: url });
  }
  return { doc: doc, url: url, fetchedAt: r.fetchedAt, fromCache: r.fromCache };
}

export function docType(doc) {
  const t = doc['@type'] || doc.type || '';
  return (t === 'sc:Collection' || t === 'Collection') ? 'Collection' : 'Manifest';
}

/* A manifest proper, with canvases. Collections are refused with their
   members listed, so the caller can pick one instead of guessing. */
export async function loadManifestOnly(url) {
  const m = await loadManifest(url);
  if (docType(m.doc) === 'Collection') {
    throw new ToolError('collection_not_manifest',
      'This is a IIIF Collection, which has member manifests rather than pages. Call again with one of its members.',
      { url: url, collection_members: collectionMembers(m.doc).slice(0, 50) });
  }
  m.canvases = detect.getCanvases(m.doc);
  if (!m.canvases.length) {
    throw new ToolError('no_canvases', 'This manifest declares no canvases, so there are no pages to show or cite.', { url: url });
  }
  return m;
}

export function collectionMembers(doc) {
  const raw = [].concat(doc.manifests || [], doc.items || [], doc.members || []);
  return raw.filter(function (x) {
    const t = x && (x.type || x['@type']);
    return t === 'Manifest' || t === 'sc:Manifest';
  }).map(function (x) {
    return { manifest_url: x.id || x['@id'], label: getLabel(x.label) };
  }).filter(function (x) { return x.manifest_url; });
}

/* metadata as flat { label, value } pairs, HTML stripped. */
export function metadataPairs(doc) {
  const md = Array.isArray(doc.metadata) ? doc.metadata : [];
  return md.map(function (e) {
    const v = e && e.value;
    // A language map's values are arrays; keep every value, not just the first.
    let vals = [];
    if (v && typeof v === 'object' && !Array.isArray(v) && !v['@value']) {
      const first = v.en || v.none || Object.values(v)[0];
      vals = [].concat(first || []);
    } else if (Array.isArray(v)) {
      vals = v.map(function (x) { return getLabel(x); });
    } else {
      vals = [getLabel(v)];
    }
    return { label: stripHtml(getLabel(e && e.label)), value: vals.map(stripHtml).filter(Boolean).join('; ') };
  }).filter(function (p) { return p.label && p.value; });
}

export function findMeta(pairs, re) {
  for (let i = 0; i < pairs.length; i++) if (re.test(pairs[i].label)) return pairs[i].value;
  return null;
}

/* Like findMeta, but returns the whole pair and skips values that are only a
   URL: a link is never a creator, date or shelfmark. (IRHT manifests carry a
   "Source images" link that would otherwise be read as the holding
   institution.) */
export function findMetaPair(pairs, re) {
  for (let i = 0; i < pairs.length; i++) {
    if (!re.test(pairs[i].label)) continue;
    if (/^(https?:\/\/|www\.)\S*$/i.test(pairs[i].value)) continue;
    return pairs[i];
  }
  return null;
}

const RIGHTS_NOTICE = 'Rights and attribution are reported exactly as the holding institution declares them in its IIIF manifest. ' +
  'Nothing here is inferred. Where no rights statement is declared, do not assume the material is free to reuse; ' +
  'check the source page. Credit the institution whenever this material is shown or quoted.';

/* The rights block carried by every successful tool response. */
export function rightsBlock(doc) {
  const pairs = metadataPairs(doc);
  const provider = getProvider(doc);
  const uri = getRights(doc);
  return {
    statement_uri: uri || null,
    statement_declared: !!uri,
    attribution: getAttribution(doc) || null,
    rights_text: findMeta(pairs, /^(rights|licen[cs]e|copyright|usage|use and reproduction|access rights|terms of use)/i),
    provider: (provider.name || provider.url) ? { name: provider.name || null, url: provider.url || null } : null,
    source_page: getSourcePageUrl(doc) || null,
    notice: RIGHTS_NOTICE
  };
}

export function provenanceBlock(m) {
  return {
    manifest_url: m.url,
    fetched_at: m.fetchedAt,
    from_cache: !!m.fromCache,
    retrieved_via: 'whatiiif MCP server'
  };
}

export function canvasId(c) { return detect.canvasIdOf(c); }

/* A page or item label as plain text, capped. Labels are names, a few words
   long; one that runs to paragraphs is either a cataloguing accident or an
   attempt to smuggle text into a model's context, and neither is worth
   passing on whole. Returns null when there is no label. */
export function shortLabel(raw, max) {
  const s = stripHtml(getLabel(raw) || '');
  const cap = max || 200;
  return s ? (s.length > cap ? s.slice(0, cap) + ' [truncated]' : s) : null;
}

/* Canvas reference: a 0-based index, or a canvas id. */
export function resolveCanvas(m, ref) {
  const cvs = m.canvases;
  let idx = -1;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    idx = parseInt(ref, 10);
  } else {
    idx = detect.resolveHintIndex({ canvasId: String(ref) }, cvs);
    if (idx === -1) {
      throw new ToolError('canvas_out_of_range', 'No canvas with id ' + ref + ' in this manifest. Use get_manifest to list canvas ids, or pass a 0-based index.',
        { canvas_count: cvs.length });
    }
  }
  if (!(idx >= 0 && idx < cvs.length)) {
    throw new ToolError('canvas_out_of_range', 'Canvas index ' + ref + ' is out of range. This manifest has ' + cvs.length +
      ' canvases, indexed 0 to ' + (cvs.length - 1) + '.', { canvas_count: cvs.length });
  }
  const c = cvs[idx];
  const d = detect.getCanvasDimensions(c);
  return { index: idx, canvas: c, id: canvasId(c), label: shortLabel(c.label), width: d.cW, height: d.cH };
}

/* "x,y,w,h" in the canvas's own pixel space (the space whatiiif's xywh uses).
   Returns null for no region. Whole numbers only, fully inside the canvas. */
export function parseRegion(region, cv) {
  if (region == null || region === '' || region === 'full') return null;
  const parts = String(region).split(',').map(function (s) { return s.trim(); });
  if (parts.length !== 4 || !parts.every(function (p) { return /^\d+$/.test(p); })) {
    throw new ToolError('invalid_region', 'region must be "x,y,w,h" as whole pixel numbers in the canvas\'s coordinate space, for example "120,340,800,600".');
  }
  const n = parts.map(Number);
  if (n[2] < 1 || n[3] < 1 || n[0] + n[2] > cv.width || n[1] + n[3] > cv.height) {
    throw new ToolError('region_out_of_bounds', 'Region ' + n.join(',') + ' does not fit inside this canvas, which is ' +
      cv.width + ' x ' + cv.height + ' pixels.', { canvas_width: cv.width, canvas_height: cv.height });
  }
  return { x: n[0], y: n[1], w: n[2], h: n[3], xywh: n.join(',') };
}

/* info.json for a canvas's image service, or null. Best effort: a missing or
   unreadable info.json means "assume a level 1/2 service with no caps". */
export async function loadInfo(svcBase) {
  try {
    const r = await politeFetch(svcBase.replace(/\/+$/, '') + '/info.json', { kind: 'json' });
    if (r.status !== 200) return null;
    return JSON.parse(await r.text());
  } catch (e) {
    if (e instanceof ToolError && e.code === 'rate_limited') throw e;
    return null;
  }
}

/* Is there machine-readable text for this object? Reports only what the
   manifest DECLARES; nothing is fetched to confirm it. */
export function textLayer(doc, canvases) {
  const kinds = [];
  const svcs = [].concat(doc.service || [], doc.services || []);
  if (svcs.some(function (s) {
    const blob = JSON.stringify([s && (s.type || s['@type']), s && s.profile, s && s['@context']]);
    return /SearchService|api\/search/i.test(blob);
  })) kinds.push('IIIF Content Search service');

  const textFormat = /text\/plain|alto|hocr|text\/vtt|application\/tei/i;
  const linksOf = function (o) { return [].concat(o.seeAlso || [], o.rendering || []); };
  const isText = function (l) {
    return l && typeof l === 'object' && textFormat.test(String(l.format || '') + ' ' + JSON.stringify(l.profile || ''));
  };
  if (linksOf(doc).some(isText)) kinds.push('text file linked from the manifest');
  let annoCanvases = 0, ocrCanvases = 0;
  canvases.forEach(function (c) {
    if ((c.annotations && c.annotations.length) || (c.otherContent && c.otherContent.length)) annoCanvases++;
    if (linksOf(c).some(isText)) ocrCanvases++;
  });
  if (annoCanvases) kinds.push('annotation pages on ' + annoCanvases + ' of ' + canvases.length + ' canvases (may be transcription, commentary, or tags)');
  if (ocrCanvases) kinds.push('OCR or text files on ' + ocrCanvases + ' of ' + canvases.length + ' canvases');

  if (!kinds.length) {
    return {
      available: false,
      reason: 'No text layer: the manifest declares no transcription or OCR annotations, no text files, and no search service. ' +
        'The pages are images only. Use get_image to read them visually.'
    };
  }
  return {
    available: true,
    kinds: kinds,
    note: 'Declared by the manifest, not verified. This server does not return text content in this version; use get_image to read pages visually.'
  };
}

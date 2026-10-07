/* get_thumbnails: several canvases at once, small, each one labelled, so a
   model can survey a volume (find the illustrated pages, the title page, where
   a section starts) without a get_image call per page.

   Returned as a sequence of [text label, image] pairs rather than one
   composited grid: a Worker has no image compositor or text renderer, and a
   label in text next to each image cannot be misread the way a small number
   burned into pixels can.

   Politeness shapes the limits. Every thumbnail is a request to the
   institution, and the per-institution budget is 30 a minute shared by all
   users, so a call is
   capped at MAX_PER_CALL and fetched a few at a time. Paging through a long
   book will run into the rate limit; when it does the call returns what it
   has and says so, instead of failing whole. */

import { Buffer } from 'node:buffer';
import { detect, getLabel, loadManifestOnly, resolveCanvas, rightsBlock, provenanceBlock } from '../iiif.js';
import { politeFetch, ToolError } from '../polite.js';
import { getImage } from './get_image.js';

const MAX_PER_CALL = 12;
const DEFAULT_EDGE = 200;
const MAX_EDGE = 400;
const CONCURRENCY = 4;

/* One thumbnail. The plain sizeByW request first: one request, no info.json,
   and every level 1+ service supports it. If that fails (level 0 services
   only serve their published sizes), fall back to get_image's full logic,
   which reads info.json and snaps to a size the service has. */
async function fetchThumb(m, cv, edge) {
  const svc = detect.getServiceBase(cv.canvas);
  if (!svc) throw new ToolError('no_image', 'No image attached to this canvas.');
  const long = Math.max(cv.width, cv.height);
  const w = Math.max(1, Math.round(Math.min(edge, long) * cv.width / long));
  try {
    const r = await politeFetch(detect.iiifUrl(svc, 'full', w + ','), { kind: 'image' });
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (r.status === 200 && /^image\//.test(mime)) {
      return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: mime,
        width: w, height: Math.max(1, Math.round(w * cv.height / cv.width)) };
    }
  } catch (e) {
    if (e instanceof ToolError && e.code === 'rate_limited') throw e;
  }
  const res = await getImage({ manifest: m.url, canvas: cv.index, size: edge });
  return { data: res.image.data, mimeType: res.image.mimeType,
    width: res.structured.delivered.width, height: res.structured.delivered.height };
}

export async function getThumbnails(args) {
  const m = await loadManifestOnly(String(args.manifest).trim());
  const total = m.canvases.length;
  const edge = Math.min(MAX_EDGE, Math.max(64, args.size || DEFAULT_EDGE));

  // Either an explicit list, or a range (start, count). The list wins.
  let wanted, mode;
  if (Array.isArray(args.canvases) && args.canvases.length) {
    mode = 'list';
    wanted = args.canvases.map(function (ref) { return resolveCanvas(m, ref); });
  } else {
    mode = 'range';
    const start = Math.max(0, args.start || 0);
    if (start >= total) {
      throw new ToolError('canvas_out_of_range', 'start ' + start + ' is past the end. This manifest has ' + total +
        ' canvases, indexed 0 to ' + (total - 1) + '.', { canvas_count: total });
    }
    const count = Math.min(MAX_PER_CALL, Math.max(1, args.count || MAX_PER_CALL));
    wanted = [];
    for (let i = start; i < Math.min(total, start + count); i++) wanted.push(resolveCanvas(m, i));
  }
  // Same canvas twice is one request, not two.
  const seen = {};
  wanted = wanted.filter(function (cv) { if (seen[cv.index]) return false; seen[cv.index] = true; return true; });
  const dropped = Math.max(0, wanted.length - MAX_PER_CALL);
  wanted = wanted.slice(0, MAX_PER_CALL);

  const out = new Array(wanted.length);
  let next = 0, limited = null;
  async function worker() {
    while (next < wanted.length && !limited) {
      const i = next++, cv = wanted[i];
      const entry = { index: cv.index, id: cv.id, label: cv.label, width: cv.width, height: cv.height };
      try {
        const t = await fetchThumb(m, cv, edge);
        entry.status = 'ok';
        entry.delivered = { width: t.width, height: t.height };
        out[i] = { entry: entry, image: { type: 'image', data: t.data, mimeType: t.mimeType } };
      } catch (e) {
        if (e instanceof ToolError && e.code === 'rate_limited') { limited = e; entry.status = 'rate_limited'; }
        else { entry.status = 'failed'; entry.reason = (e instanceof ToolError) ? e.message : 'Unexpected error.'; }
        out[i] = { entry: entry, image: null };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
  // Canvases never reached because the rate limit stopped the run.
  for (let i = 0; i < wanted.length; i++) {
    if (!out[i]) {
      const cv = wanted[i];
      out[i] = { entry: { index: cv.index, id: cv.id, label: cv.label, width: cv.width, height: cv.height, status: 'rate_limited' }, image: null };
    }
  }

  const loaded = out.filter(function (o) { return o.image; });
  if (!loaded.length) {
    if (limited) throw limited;
    throw new ToolError('image_unavailable', 'None of the requested thumbnails could be loaded.',
      { thumbnails: out.map(function (o) { return o.entry; }) });
  }

  const content = [];
  out.forEach(function (o) {
    const e = o.entry;
    const name = 'Canvas index ' + e.index + (e.label ? ', labelled "' + e.label + '"' : ', no label');
    if (o.image) { content.push({ type: 'text', text: name + ':' }); content.push(o.image); }
    else content.push({ type: 'text', text: name + ': not loaded (' + (e.status === 'rate_limited' ? 'rate limit reached' : e.reason) + ').' });
  });

  const structured = {
    manifest_url: m.url,
    title: getLabel(m.doc.label) || null,
    canvas_count: total,
    thumbnails: out.map(function (o) { return o.entry; }),
    returned: loaded.length,
    order_note: 'Images above appear in the same order as this list; each is preceded by its canvas index and label.'
  };
  if (mode === 'range') {
    const last = wanted[wanted.length - 1].index;
    structured.range = { start: wanted[0].index, end: last, more: last + 1 < total };
    if (structured.range.more) structured.range.next_start = last + 1;
  }
  if (dropped) structured.truncated = 'Only the first ' + MAX_PER_CALL + ' canvases were fetched; ' + dropped + ' more were requested. Call again for the rest.';
  if (limited) {
    structured.rate_limited = {
      message: 'Stopped early: this server limits how often it contacts ' + (limited.extra.institution || 'the institution') +
        '. The thumbnails marked rate_limited were not fetched.',
      retry_after: limited.extra.retry_after || 60
    };
  }
  structured.pacing_note = 'Each thumbnail is a request to the institution and the budget is about 30 a minute shared by everyone using this server, so survey a long volume ' +
    'by sampling (every 10th or 20th canvas) and then narrowing in, not by paging through every canvas.';
  structured.show_user = 'The user cannot see these thumbnails. Use get_image for a closer look at a page, and make_citation to show the user the page or region you settle on.';
  structured.rights = rightsBlock(m.doc);
  structured.provenance = provenanceBlock(m);
  return { structured: structured, content: content };
}

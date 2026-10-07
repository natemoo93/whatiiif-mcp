/* pages.js: page-type HINTS for get_manifest.
 *
 * Everything here is computed from what the manifest declares about a canvas:
 * its pixel dimensions, its label, its behavior, and the ranges (table of
 * contents) it sits in. Nothing looks at an image, and nothing claims to know
 * what a page shows. A landscape canvas in a portrait volume is very often a
 * fold-out, a plate or a two-page spread, and a label of "Plate 3" very often
 * marks an illustration, but those are leads for the model to check with
 * get_thumbnails or get_image, and the output says so.
 *
 * The whole manifest is analysed even though get_manifest pages its canvas
 * list, so the summary (outliers, notable labels, structure) points at pages
 * outside the slice currently being listed. That is the point: it tells the
 * model where to look without paging through everything.
 */

import { detect, getLabel, stripHtml, shortLabel } from './iiif.js';

const LIST_CAP = 60;

function median(nums) {
  const s = nums.slice().sort(function (a, b) { return a - b; });
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}

function orientation(aspect) {
  return aspect > 1.1 ? 'landscape' : (aspect < 0.9 ? 'portrait' : 'square');
}

/* What FORM a label takes, not what it means. "named" and "bracketed" labels
   are the ones an institution wrote by hand for a particular page, which is
   why they are worth surfacing. */
function labelKind(label, index) {
  const l = String(label || '').trim();
  if (!l || /^[-–—_.\s]+$/.test(l)) return 'none';
  if (/^[\[\(]?\s*(seq\.?|n|img|image|canvas)\s*\d+\s*[\]\)]?$/i.test(l)) return 'sequence';
  if (/^\d+$/.test(l)) {
    const n = parseInt(l, 10);
    return (n === index || n === index + 1) ? 'sequence' : 'page_number';
  }
  if (/^\[?\s*(f(ol)?\.?\s*)?\d+\s*[rv]\s*\]?$/i.test(l) || /^\[?\s*(folio|fol\.?|f\.)\s*\d+/i.test(l)) return 'folio';
  if (/^\[?\s*(p\.?|pp\.?|page|pag\.?|s\.|seite)\s*\d+\s*\]?$/i.test(l) || /^[ivxlcdm]+$/i.test(l)) return 'page_number';
  if (/^\[.*\]$/.test(l)) return 'bracketed';
  return 'named';
}

/* Ranges (the manifest's table of contents), flattened.
   v3: structures[].items mixes Canvas refs and nested Ranges.
   v2: structures[] is flat, each with canvases[] ids and a `within` parent. */
function collectRanges(doc, indexOfId) {
  const out = [];
  const structures = Array.isArray(doc.structures) ? doc.structures : [];
  const idxOf = function (ref) {
    const id = typeof ref === 'string' ? ref : (ref && (ref.id || ref['@id'] || (ref.source && (ref.source.id || ref.source))));
    if (typeof id !== 'string') return -1;
    const bare = id.split('#')[0];
    return Object.prototype.hasOwnProperty.call(indexOfId, bare) ? indexOfId[bare] : -1;
  };
  const walk = function (r, depth) {
    if (!r || typeof r !== 'object' || depth > 6) return [];
    let mine = [];
    [].concat(r.canvases || []).forEach(function (c) { const i = idxOf(c); if (i > -1) mine.push(i); });
    [].concat(r.items || [], r.members || []).forEach(function (it) {
      const t = it && (it.type || it['@type']);
      if (t === 'Range' || t === 'sc:Range') mine = mine.concat(walk(it, depth + 1));
      else { const i = idxOf(it); if (i > -1) mine.push(i); }
    });
    const label = shortLabel(r.label) || '';
    if (label && mine.length) {
      out.push({ label: label, depth: depth, first_index: Math.min.apply(null, mine), last_index: Math.max.apply(null, mine),
        canvas_count: mine.filter(function (v, k) { return mine.indexOf(v) === k; }).length, _set: mine });
    }
    return mine;
  };
  structures.forEach(function (r) { walk(r, 0); });
  out.sort(function (a, b) { return a.first_index - b.first_index || b.canvas_count - a.canvas_count; });
  return out;
}

/* Returns { perCanvas: [hints by index], summary: {...} }. */
export function analysePages(doc, canvases) {
  const n = canvases.length;
  const dims = canvases.map(function (c) { return detect.getCanvasDimensions(c); });
  const aspects = dims.map(function (d) { return d.cW / d.cH; });
  const areas = dims.map(function (d) { return d.cW * d.cH; });
  const medAspect = median(aspects), medArea = median(areas);

  const indexOfId = {};
  canvases.forEach(function (c, i) { const id = detect.canvasIdOf(c); if (id) indexOfId[id] = i; });
  const ranges = collectRanges(doc, indexOfId);
  const total = ranges.length;
  // A range spanning every canvas is the wrapper ("Table of Contents"), not a
  // statement about any page.
  const useful = ranges.filter(function (r) { return r.canvas_count < n || n === 1; });

  const perCanvas = [];
  const outliers = [], notable = [];
  const kinds = {};
  let landscape = 0, portrait = 0, square = 0;

  for (let i = 0; i < n; i++) {
    const a = aspects[i], o = orientation(a);
    if (o === 'landscape') landscape++; else if (o === 'portrait') portrait++; else square++;
    const label = shortLabel(canvases[i].label) || '';
    const kind = labelKind(label, i);
    kinds[kind] = (kinds[kind] || 0) + 1;

    const why = [];
    // Only meaningful against a typical page, i.e. with a few pages to compare.
    if (n >= 4) {
      const ra = a / medAspect, rs = areas[i] / medArea;
      if (ra > 1.2) why.push('wider than the typical page');
      else if (ra < 1 / 1.2) why.push('narrower than the typical page');
      if (rs > 1.35) why.push('larger scan than the typical page');
      else if (rs < 1 / 1.35) why.push('smaller scan than the typical page');
    }
    const h = { aspect: Math.round(a * 100) / 100, orientation: o, label_kind: kind };
    if (detect.isNonPagedCanvas ? detect.isNonPagedCanvas(canvases[i])
        : [].concat(canvases[i].behavior || canvases[i].viewingHint || []).some(function (b) { return b === 'non-paged' || b === 'facing-pages'; })) {
      h.declared = 'non-paged';
      why.push('declared non-paged by the institution (stands alone, e.g. a fold-out or spread)');
    }
    if (why.length) { h.differs = why; outliers.push({ index: i, label: label || null, width: dims[i].cW, height: dims[i].cH, why: why }); }
    const inRanges = useful.filter(function (r) { return r._set.indexOf(i) !== -1; }).map(function (r) { return r.label; });
    if (inRanges.length) h.sections = inRanges.slice(0, 4);
    if (kind === 'named' || kind === 'bracketed') notable.push({ index: i, label: label });
    perCanvas.push(h);
  }

  const summary = {
    basis: 'Computed only from each canvas\'s declared pixel size, label, behavior and sections. No image was examined, so these are ' +
      'leads, not descriptions: a page that differs in shape or size from the rest is often a fold-out, plate, map, cover or ' +
      'two-page spread, and a hand-written label often marks something particular, but confirm with get_thumbnails or get_image.',
    typical_page: n ? { aspect: Math.round(medAspect * 100) / 100, orientation: orientation(medAspect) } : null,
    orientation_counts: { portrait: portrait, landscape: landscape, square: square },
    label_kinds: kinds
  };
  summary.label_note = (kinds.named || kinds.bracketed)
    ? 'Some labels were written for particular pages (kinds "named" and "bracketed"); they are listed in notable_labels.'
    : 'Labels here only number the pages, so they say nothing about which pages are special. Use shape (pages_that_differ) and thumbnails.';
  summary.pages_that_differ = outliers.slice(0, LIST_CAP);
  if (outliers.length > LIST_CAP) summary.pages_that_differ_total = outliers.length;
  if (n >= 4 && !outliers.length) summary.pages_that_differ_note = 'Every canvas has about the same shape and size, so geometry does not single any page out.';
  // If nearly every label is hand-written, listing them all is just the canvas list again.
  if (notable.length && notable.length <= Math.max(LIST_CAP, n * 0.5)) {
    summary.notable_labels = notable.slice(0, LIST_CAP);
    if (notable.length > LIST_CAP) summary.notable_labels_total = notable.length;
  }
  if (useful.length) {
    summary.sections = useful.slice(0, LIST_CAP).map(function (r) {
      return { label: r.label, first_index: r.first_index, last_index: r.last_index, canvas_count: r.canvas_count, depth: r.depth };
    });
    if (useful.length > LIST_CAP) summary.sections_total = useful.length;
    summary.sections_note = 'Sections are the institution\'s own table of contents (IIIF ranges) and are the most reliable guide to what is where.';
  } else {
    summary.sections_note = total ? 'The manifest\'s only range covers the whole item, so it gives no breakdown.'
      : 'The manifest declares no table of contents (no ranges).';
  }
  return { perCanvas: perCanvas, summary: summary };
}

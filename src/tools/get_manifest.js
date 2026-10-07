/* get_manifest: compact, model-sized view of a manifest. A raw manifest is
   routinely hundreds of kilobytes (the Voynich manuscript's is 400 KB), almost
   all of it repeated image plumbing, so this returns the descriptive metadata
   in full and the canvas list a page at a time. */

import {
  detect, getLabel, loadManifestOnly, metadataPairs, stripHtml,
  rightsBlock, provenanceBlock, canvasId, textLayer, shortLabel
} from '../iiif.js';
import { analysePages } from '../pages.js';

const VALUE_MAX = 1200;

function clip(s) {
  return s.length > VALUE_MAX ? s.slice(0, VALUE_MAX) + ' [truncated, ' + s.length + ' characters in the manifest]' : s;
}

export async function getManifest(args) {
  const m = await loadManifestOnly(String(args.id).trim());
  const doc = m.doc, cvs = m.canvases;
  const offset = Math.max(0, args.canvas_offset || 0);
  const limit = Math.min(200, Math.max(1, args.canvas_limit || 50));

  // Hints cover the WHOLE manifest, not just the slice listed below, so the
  // summary can point at pages the caller has not paged to yet.
  const pages = analysePages(doc, cvs);
  const page = cvs.slice(offset, offset + limit).map(function (c, i) {
    const d = detect.getCanvasDimensions(c);
    return Object.assign({ index: offset + i, id: canvasId(c), label: shortLabel(c.label), width: d.cW, height: d.cH },
      pages.perCanvas[offset + i]);
  });

  const summary = stripHtml(getLabel(doc.summary) || getLabel(doc.description) || '');
  const out = {
    manifest_url: m.url,
    label: shortLabel(doc.label, 500),
    summary: summary ? clip(summary) : null,
    presentation_version: (doc.sequences ? 2 : 3),
    metadata: metadataPairs(doc).map(function (p) { return { label: p.label, value: clip(p.value) }; }),
    paged: [].concat(doc.behavior || doc.viewingHint || []).indexOf('paged') !== -1,
    viewing_direction: doc.viewingDirection || null,
    canvas_count: cvs.length,
    page_hints: pages.summary,
    canvases: page,
    canvases_returned: { offset: offset, count: page.length, more: offset + page.length < cvs.length },
    coordinate_note: 'Canvas width and height are the pixel space for region arguments ("x,y,w,h") in get_image and make_citation.',
    text_layer: textLayer(doc, cvs),
    show_user: 'Nothing has been shown to the user yet. When you present this item or one of its pages, call make_citation ' +
      'for that canvas (and region, if you mean a specific part) so it is displayed to them.',
    rights: rightsBlock(doc),
    provenance: provenanceBlock(m)
  };
  if (out.canvases_returned.more) {
    out.canvases_returned.next_offset = offset + page.length;
  }
  return out;
}

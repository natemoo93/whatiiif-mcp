/* get_image: one IIIF Image API request, returned as image content a vision
   model can read.

   The image URL is always built from a service base found inside a manifest
   this server fetched. The caller never supplies an image URL, so this cannot
   be used as a general-purpose image proxy. */

import { Buffer } from 'node:buffer';
import {
  detect, loadManifestOnly, resolveCanvas, parseRegion, loadInfo, capsFromInfo, capWidth,
  iiifLevel0, infoSizes, snapSize, rightsBlock, provenanceBlock
} from '../iiif.js';
import { politeFetch, ToolError } from '../polite.js';

const DEFAULT_EDGE = 1024;
const MAX_EDGE = 1568;

export async function getImage(args) {
  const m = await loadManifestOnly(String(args.manifest).trim());
  const cv = resolveCanvas(m, args.canvas);
  const region = parseRegion(args.region, cv);

  const svc = detect.getServiceBase(cv.canvas);
  if (!svc) {
    throw new ToolError('no_image', 'Canvas ' + cv.index + ' has no image attached in this manifest.');
  }

  const info = await loadInfo(svc);
  const wantEdge = Math.min(MAX_EDGE, Math.max(64, args.size || DEFAULT_EDGE));
  let regionParam = 'full', sizeParam, outW, outH, clamped = false;
  const notes = [];

  if (iiifLevel0(info)) {
    // A level-0 service serves only pre-made full-page derivatives.
    if (region) {
      throw new ToolError('level0_no_region',
        'This institution\'s image service is IIIF level 0: it serves whole pages at fixed sizes and cannot crop a region. ' +
        'Request the full canvas (omit region) instead.', { image_service: svc });
    }
    const sizes = infoSizes(info);
    sizeParam = snapSize(sizes, wantEdge) || detect.fullSizeParam(svc);
    const dims = String(sizeParam).split(',');
    outW = parseInt(dims[0], 10) || null;
    outH = parseInt(dims[1], 10) || null;
    notes.push('Level 0 image service: size snapped to the nearest size it publishes.');
  } else {
    // The canvas pixel space and the image service's pixel space usually match
    // but need not (LoC reports reduced canvases); scale the region across.
    const sx = (info && info.width) ? info.width / cv.width : 1;
    const sy = (info && info.height) ? info.height / cv.height : 1;
    const src = region
      ? { x: Math.round(region.x * sx), y: Math.round(region.y * sy), w: Math.max(1, Math.round(region.w * sx)), h: Math.max(1, Math.round(region.h * sy)) }
      : { w: Math.round(cv.width * sx), h: Math.round(cv.height * sy) };
    if (region) regionParam = src.x + ',' + src.y + ',' + src.w + ',' + src.h;

    // Long edge = wantEdge, but never upscale past the source pixels: some
    // servers resample from a low pyramid level and return blur.
    const longEdge = Math.max(src.w, src.h);
    const edge = Math.min(wantEdge, longEdge);
    let w = Math.max(1, Math.round(src.w * edge / longEdge));
    const capped = capWidth(w, Math.round(w * src.h / src.w), capsFromInfo(info));
    if (capped < w) { w = capped; notes.push('Reduced to fit the size limit this image service advertises.'); }
    if ((args.size || 0) > MAX_EDGE) notes.push('Requested size exceeds this server\'s maximum of ' + MAX_EDGE + ' px.');
    if (edge < wantEdge && !(args.size > MAX_EDGE)) notes.push('The source region is only ' + longEdge + ' px on its long edge; not upscaled.');
    outW = w;
    outH = Math.max(1, Math.round(w * src.h / src.w));
    sizeParam = w + ',';
    clamped = notes.length > 0;
  }

  const imageUrl = detect.iiifUrl(svc, regionParam, sizeParam);
  const r = await politeFetch(imageUrl, { kind: 'image' });
  const host = new URL(imageUrl).hostname;
  if (r.status !== 200) {
    throw new ToolError(r.status === 403 || r.status === 401 ? 'blocked_by_institution' : 'image_unavailable',
      host + ' did not return the image (HTTP ' + r.status + '). ' +
      (r.status === 403 ? 'The image may be restricted, or the request exceeded a limit the service does not advertise.' : ''),
      { institution: host, image_url: imageUrl, http_status: r.status });
  }
  const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(mime)) {
    throw new ToolError('image_unavailable', host + ' returned ' + (mime || 'an unknown type') + ' instead of an image.',
      { institution: host, image_url: imageUrl });
  }
  const bytes = await r.arrayBuffer();
  const data = Buffer.from(bytes).toString('base64');

  const rights = rightsBlock(m.doc);
  const structured = {
    image_url: imageUrl,
    mime_type: mime,
    canvas: { index: cv.index, id: cv.id, label: cv.label, width: cv.width, height: cv.height },
    region: region ? region.xywh : 'full',
    delivered: { width: outW, height: outH },
    clamped: clamped,
    notes: notes,
    // Arrives at the moment the model decides what to do next, which is where
    // it was skipping make_citation and leaving the user with nothing to see.
    show_user: 'The user cannot see this image. If your answer is about this ' + (region ? 'region' : 'page') +
      ', call make_citation with manifest, canvas ' + cv.index + (region ? ' and region "' + region.xywh + '"' : '') +
      ' so it is displayed to them.',
    rights: rights,
    provenance: Object.assign(provenanceBlock(m), { image_fetched_at: r.fetchedAt, image_from_cache: !!r.fromCache })
  };
  // `bytes` is for the /img route, which serves the same image undecoded.
  return { structured: structured, image: { type: 'image', data: data, mimeType: mime }, bytes: bytes };
}

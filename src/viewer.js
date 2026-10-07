/* viewer.js: the embedded viewer returned alongside make_citation.
 *
 * Two forms, for two kinds of destination:
 *
 * 1. embed.html / embed.url in the tool result: the same <iframe> snippet the
 *    whatiiif highlight page offers under "Embed iframe", for pasting into a
 *    web page or LMS. Works with any MCP client, because it is just text.
 *
 * 2. An MCP App (the io.modelcontextprotocol/ui extension). make_citation
 *    declares the ui:// resource below; a host that supports MCP Apps renders
 *    it in a sandboxed iframe in the conversation and pushes the tool result
 *    into it. The page shows the region cropped tight, the whole page with
 *    the region outlined, and the credit line. Hosts without MCP Apps support
 *    ignore the metadata and show the text result as before.
 *
 * WHY THE PANEL IS A TIGHT CROP AND NOT THE EMBED VIEWER. Both were built
 * and compared. The panel's job is to POINT at
 * something, usually a passage of text. whatiiif's /embed viewer frames the
 * region inside a deep-zoom view whose box follows the panel's shape, so
 * neighbouring lines show around the excerpt and it no longer says "this,
 * exactly". An exact crop does, and the outlined thumbnail supplies the
 * context the crop removes. A rebuilt copy of the embed (OpenSeadragon in the
 * panel, tiles proxied through this Worker) was built, worked, and was
 * removed for this reason; do not bring it back to make the panel "match the
 * embed". Deep zoom is one click away on "Open in whatiiif".
 *
 * The panel also cannot frame whatiiif.com/embed in claude.ai: that host
 * blocks nested frames outright (frameDomains is "restricted pending security
 * review"), which rendered the very first version as a black box.
 *
 * Images load from this server's own /img route (the single origin the
 * resource declares), falling back to the get_image tool as a data: URI.
 *
 * The view speaks the MCP Apps postMessage protocol directly (spec version
 * 2026-01-26) instead of bundling the ext-apps SDK, so this Worker keeps no
 * UI build step: ui/initialize, a listener for ui/notifications/tool-result,
 * and tools/call for the fallback images.
 */

import { detect } from './iiif.js';

// The version suffix is a cache-buster: hosts cache a UI resource by URI, so a
// changed page under the same URI can keep showing the old one. Bump it
// whenever VIEWER_HTML changes in a way users must see.
export const VIEWER_URI = 'ui://whatiiif/viewer-v6.html';
export const VIEWER_MIME = 'text/html;profile=mcp-app';

/* The view loads images from exactly one place: this server's own /img route
   (see index.js), which serves the same manifest-derived, cached, rate-limited
   image get_image does. So one origin is declared, whatever institution holds
   the item; institution image hosts are unbounded and could never be listed. */
export function viewerMeta(origin) {
  return { ui: { csp: { resourceDomains: [origin] }, prefersBorder: true } };
}
export function viewerHtml(origin) {
  return VIEWER_HTML.replace('__IMG_BASE__', origin);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EMBED_WIDTH = 640;

/* The same snippet whatiiif.com's highlight page offers: same params, same
   sizing rule (viewer area in the crop's proportions plus the embed's fixed
   chrome: 46px attribution bar, +44px caption when labelled). If the embed's
   chrome heights change on the site, change them here. */
export function buildEmbed(manifestUrl, cv, region, label, svc, title) {
  const p = new URLSearchParams();
  p.set('manifest', manifestUrl);
  p.set('canvas', String(cv.index));
  if (region) p.set('xywh', region.xywh);
  if (label) p.set('label', label);
  if (svc) p.set('svc', svc);
  const url = detect.WHATIIIF_BASE + '/embed?' + p.toString();

  const w = region ? region.w : cv.width;
  const h = region ? region.h : cv.height;
  const height = Math.round(EMBED_WIDTH * h / w) + 46 + (label ? 44 : 0);
  const t = 'Interactive IIIF viewer: ' + (label || cv.label || 'Highlighted region') + (title ? ', ' + title : '');
  return {
    url: url,
    html: '<iframe src="' + esc(url) + '" title="' + esc(t) + '" width="' + EMBED_WIDTH + '" height="' + height +
      '" loading="lazy" allow="clipboard-write" style="border:0"></iframe>',
    width: EMBED_WIDTH,
    height: height
  };
}

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whatiiif viewer</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1c1c; background: transparent; }
  #stage { display: none; gap: 10px; padding: 10px 12px 0; align-items: flex-start; }
  #stage.on { display: flex; }
  figure { margin: 0; min-width: 0; }
  figcaption { font-size: 12px; opacity: .7; margin-top: 4px; }
  #cropFig { flex: 1 1 auto; }
  #ctxFig { flex: 0 0 26%; max-width: 200px; }
  #stage.single #ctxFig { display: none; }
  /* Wide, short regions (a line of text): the crop is a thin strip, so a tall
     thumbnail beside it leaves a hole underneath. Put the thumbnail below. */
  #stage.stack { flex-direction: column; }
  #stage.stack #cropFig { width: 100%; }
  #stage.stack #ctxFig { flex: 0 0 auto; width: 150px; max-width: 45%; }
  img { display: block; width: 100%; height: auto; border-radius: 3px; background: rgba(127,127,127,.15); }
  #crop { max-height: 520px; width: auto; max-width: 100%; }
  #ctxWrap { position: relative; }
  #box { position: absolute; border: 2px solid #1faa59; background: rgba(31,170,89,.18); box-sizing: border-box; pointer-events: none; }
  #meta { padding: 10px 12px 12px; }
  #credit { margin: 0 0 6px; }
  #rights { margin: 0 0 8px; font-size: 12px; opacity: .75; }
  #links a { margin-right: 14px; color: #0b57d0; }
  #msg { padding: 14px 12px; margin: 0; }
  @media (max-width: 420px) { #stage.on { flex-direction: column; } #ctxFig { flex-basis: auto; max-width: 140px; } }
  @media (prefers-color-scheme: dark) { body { color: #ececec; } #links a { color: #8ab4f8; } }
</style>
</head>
<body>
<p id="msg">Loading viewer...</p>
<div id="stage">
  <figure id="cropFig"><img id="crop" alt=""><figcaption id="cropCap"></figcaption></figure>
  <figure id="ctxFig"><div id="ctxWrap"><img id="ctx" alt=""><div id="box"></div></div><figcaption>Where it sits on the page</figcaption></figure>
</div>
<div id="meta" hidden>
  <p id="credit"></p>
  <p id="rights"></p>
  <div id="links"></div>
</div>
<script>
(function () {
  var nextId = 1, pending = {}, shown = 0;
  var $ = function (id) { return document.getElementById(id); };

  function post(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }

  function reportSize() {
    notify('ui/notifications/size-changed', { height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return 'unknown site'; }
  }

  function link(text, url) {
    var a = document.createElement('a');
    a.textContent = text; a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.addEventListener('click', function (e) {
      // Sandboxed views usually cannot navigate; ask the host to open it.
      e.preventDefault();
      request('ui/open-link', { url: url }).catch(function () { window.open(url, '_blank', 'noopener'); });
    });
    return a;
  }

  /* Two ways to get an image, tried in order, because hosts differ in what
     they permit and a failure in either is otherwise invisible:
       1. a plain <img> from this server's /img route (the one origin declared
          in the resource's csp.resourceDomains);
       2. this server's get_image tool, called through the host, shown as a
          data: URI. Needs no declared origin, but needs the host to let a
          view call tools and to allow data: images.
     Never the institution's image host directly: those are unbounded and
     cannot be declared. */
  var IMG_BASE = '__IMG_BASE__';
  function viaTool(img, args) {
    return request('tools/call', { name: 'get_image', arguments: args }).then(function (res) {
      var c = ((res && res.content) || []).filter(function (x) { return x.type === 'image'; })[0];
      if (!c || res.isError) throw new Error('no image');
      return new Promise(function (resolve, reject) {
        img.onload = function () { reportSize(); resolve(); };
        img.onerror = function () { reject(new Error('data image blocked')); };
        img.src = 'data:' + c.mimeType + ';base64,' + c.data;
      });
    });
  }
  function loadImage(img, args) {
    var q = 'manifest=' + encodeURIComponent(args.manifest) + '&canvas=' + encodeURIComponent(args.canvas) +
      (args.region ? '&region=' + encodeURIComponent(args.region) : '') + '&size=' + args.size;
    return new Promise(function (resolve, reject) {
      img.onload = function () { reportSize(); resolve(); };
      img.onerror = function () { viaTool(img, args).then(resolve, reject); };
      img.src = IMG_BASE + '/img?' + q;
    });
  }

  /* Stack when, side by side, the crop would come out much shorter than the
     thumbnail next to it. Compared by their heights at the panel's current
     width (crop takes about 72% of it, thumbnail 26% capped at 200px). */
  function shouldStack(region, cv) {
    var n = region.split(',').map(Number);
    if (!(n[2] > 0 && n[3] > 0 && cv.width > 0 && cv.height > 0)) return false;
    var w = document.documentElement.clientWidth || 640;
    var cropH = Math.min(0.72 * w, n[2]) * n[3] / n[2];
    var thumbH = Math.min(0.26 * w, 200) * cv.height / cv.width;
    return cropH < 0.6 * thumbH;
  }

  function fail(text) {
    $('msg').textContent = text; $('msg').hidden = false;
    $('stage').className = '';
    reportSize();
  }

  function show(result) {
    var d = (result && result.structuredContent) || null;
    var c = d && d.cited, cv = c && c.canvas, prov = d && d.provenance;
    if (!d || d.error || !cv || !prov || !prov.manifest_url) {
      $('meta').hidden = true;
      fail((d && d.error && d.error.message) || 'Nothing to display for this result.');
      return;
    }
    var run = ++shown;
    var r = d.rights || {};
    var who = (r.provider && r.provider.name) || r.attribution || '';
    var what = (c.title || 'Untitled') + (cv.label ? ', ' + cv.label : '');
    $('credit').textContent = what + (who ? '. ' + who + '.' : '');
    $('rights').textContent = r.statement_uri ? 'Rights: ' + r.statement_uri
      : (r.rights_text || 'No rights statement declared by the institution.');
    var links = $('links');
    links.textContent = '';
    if (d.whatiiif_url) links.appendChild(link('Open in whatiiif (zoomable)', d.whatiiif_url));
    // The address comes from the manifest, which anyone can publish, so the
    // link says where it goes instead of asking the user to trust its name.
    if (r.source_page) links.appendChild(link('View at institution (' + hostOf(r.source_page) + ')', r.source_page));
    $('meta').hidden = false;

    $('msg').textContent = 'Loading image...'; $('msg').hidden = false;
    $('stage').className = '';
    $('ctxFig').style.display = '';
    $('crop').removeAttribute('src'); $('ctx').removeAttribute('src');
    $('crop').alt = (c.region ? 'Region of ' : '') + what;
    $('cropCap').textContent = d.label || (c.region ? 'Selected region' : (cv.label || ''));
    reportSize();

    var m = prov.manifest_url, jobs = [];
    if (c.region) {
      jobs.push(loadImage($('crop'), { manifest: m, canvas: cv.index, region: c.region, size: 1024 }));
      jobs.push(loadImage($('ctx'), { manifest: m, canvas: cv.index, size: 400 }).then(function () {
        var n = c.region.split(',').map(Number), b = $('box').style;
        if (cv.width > 0 && cv.height > 0) {
          b.left = (100 * n[0] / cv.width) + '%'; b.top = (100 * n[1] / cv.height) + '%';
          b.width = (100 * n[2] / cv.width) + '%'; b.height = (100 * n[3] / cv.height) + '%';
        }
        $('ctx').alt = 'Whole page with the selected region outlined';
      }));
    } else {
      jobs.push(loadImage($('crop'), { manifest: m, canvas: cv.index, size: 1024 }));
    }
    // The main image decides success; a failed context thumbnail just hides.
    jobs[0].then(function () {
      if (run !== shown) return;
      $('msg').hidden = true;
      $('stage').className = !c.region ? 'on single' : (shouldStack(c.region, cv) ? 'on stack' : 'on');
      reportSize();
    }, function () {
      if (run !== shown) return;
      fail('The image could not be loaded here. Use the links below to view it.');
    });
    if (jobs[1]) jobs[1].catch(function () {
      if (run === shown) { $('ctxFig').style.display = 'none'; reportSize(); }
    });
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && pending[m.id] && !m.method) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') show(m.params);
    else if (m.method === 'ui/notifications/tool-cancelled') fail('Cancelled.');
    else if (m.method === 'ping' && m.id != null) post({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.method === 'ui/resource-teardown' && m.id != null) post({ jsonrpc: '2.0', id: m.id, result: {} });
  });
  window.addEventListener('resize', reportSize);

  request('ui/initialize', {
    appInfo: { name: 'whatiiif viewer', version: '0.6.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26'
  }).then(function () {
    notify('ui/notifications/initialized');
    reportSize();
  }).catch(function () {
    $('msg').textContent = 'This host did not complete the viewer handshake.';
  });
})();
</script>
</body>
</html>`;

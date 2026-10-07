/* manifest.js: reading the descriptive parts of a IIIF manifest.
   Labels, the source page, the holding institution, attribution and rights,
   and what a level 0 image service can serve. Presentation API 2 and 3 are
   both handled, field by field, with no normalised model in between. */

export function getLabel(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return getLabel(raw[0]);
  if (typeof raw === 'object') {
    const v = raw.en || raw.none || (raw['@value'] ? [raw['@value']] : null) || Object.values(raw)[0];
    return v ? getLabel(v) : '';
  }
  return String(raw);
}

// A level-0 IIIF Image service only serves pre-generated derivatives: it can't
// crop an arbitrary region or scale on demand, so region-crop and full/600,
// requests 404 against it (static-tile sources). Detect it from info.json and
// read the discrete sizes it DOES publish so one can be requested exactly.
export function iiifLevel0(info) {
  if (!info) return false;
  if (typeof info.profile === 'string' && /level0/i.test(info.profile)) return true;
  const arr = Array.isArray(info.profile) ? info.profile : [info.profile];
  return arr.some(v => typeof v === 'string' && /\/level0\.json$|#level0$|:level0$/i.test(v));
}
// Return the published {width,height} entries, ascending by width. A level-0
// service serves the FULL region only at these exact sizes, and the size must
// be given as the full "w,h" pair (width-only "w," is a different derivative it
// hasn't generated, so it 404s).
export function infoSizes(info) {
  if (!info || !Array.isArray(info.sizes)) return [];
  return info.sizes
    .filter(s => s && typeof s.width === 'number' && s.width > 0)
    .map(s => ({ w: s.width, h: s.height }))
    .sort((a, b) => a.w - b.w);
}
// Smallest published size whose width >= want; else the largest available.
// Returns the exact size string ("w,h" when height is known, else "w,").
export function snapSize(sizes, want) {
  if (!sizes || !sizes.length) return null;
  let pick = sizes[sizes.length - 1];
  for (const s of sizes) { if (s.w >= want) { pick = s; break; } }
  return (typeof pick.h === 'number' && pick.h > 0) ? `${pick.w},${pick.h}` : `${pick.w},`;
}

// A URI value that may be a bare string, {id}/{@id}, or an array of those.
export function firstId(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const id = firstId(x); if (id) return id; } return ''; }
  if (typeof v === 'object') return firstId(v['@id'] || v.id || '');
  return '';
}

// Human-facing source page for the item (NOT the manifest JSON): prefer
// homepage (v3) / related (v2), then a rendering with format text/html.
export function getSourcePageUrl(manifest) {
  const home = firstId(manifest.homepage) || firstId(manifest.related);
  if (/^https?:\/\//.test(home)) return home;
  const rend = manifest.rendering
    ? (Array.isArray(manifest.rendering) ? manifest.rendering : [manifest.rendering])
    : [];
  for (const rd of rend) {
    if (rd && rd.format === 'text/html') {
      const u = firstId(rd);
      if (/^https?:\/\//.test(u)) return u;
    }
  }
  return '';
}

// Holding institution as { name, url, logo }, best-effort.
//  - v3: structured `provider` (an Agent with label/homepage/logo).
//  - v2: no `provider`, so derive a name from the free-text attribution
//    ("Provided by X under...", "Courtesy of X") and use `logo` as the image.
export function getProvider(manifest) {
  const prov = Array.isArray(manifest.provider) ? manifest.provider[0] : manifest.provider;
  if (prov && typeof prov === 'object') {
    const name = getLabel(prov.label);
    const url = firstId(prov.homepage) || firstId(prov.id) || firstId(prov['@id']);
    const logo = firstId(prov.logo);
    if (name || url) return { name, url, logo };
  }
  // v2 fallback: mine the attribution string for the holder's name. Capture the
  // words after "provided/courtesy/... by", stopping at the first punctuation
  // (.,;:) OR a trailing clause ("under ...", "through ...", "with ...", "for
  // ...") that continues the sentence past the name. Cap length as a backstop.
  let name = '';
  const attr = getAttribution(manifest);
  const m = attr.match(/(?:provided|courtesy|held|digiti[sz]ed|owned)\s+(?:by|of)\s+(.+)/i);
  if (m) {
    name = m[1]
      .split(/[.,;:]|\s+(?:under|through|with|for|as part of|via)\s+/i)[0]
      .trim()
      .slice(0, 80);
  }
  const logo = firstId(manifest.logo);
  return { name, url: '', logo: /^https?:\/\//.test(logo) ? logo : '' };
}

// Attribution / rights statement text, plain (tags stripped). v3 uses
// requiredStatement.value; v2 uses attribution.
export function getAttribution(manifest) {
  let txt = '';
  if (manifest.requiredStatement && manifest.requiredStatement.value) {
    txt = getLabel(manifest.requiredStatement.value);
  } else if (manifest.attribution) {
    txt = getLabel(manifest.attribution);
  }
  return String(txt || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// A rights/license URI if the manifest declares one (v3 `rights`, v2 `license`).
export function getRights(manifest) {
  const r = firstId(manifest.rights) || firstId(manifest.license);
  return /^https?:\/\//.test(r) ? r : '';
}

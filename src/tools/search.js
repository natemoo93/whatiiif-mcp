/* search: free-text search across institutions' own public search APIs,
   returning items that can be handed to get_manifest.

   Each source is an official, documented API, queried once per call, through
   polite.js like everything else. The one exception is Biblissima, which has
   no API; its public results page is read instead (html: true, see there),
   and for that reason it is off unless the operator turns it on.
   A source is one entry in SOURCES: build a URL, map the response to the
   common result shape.
   Adding an institution means adding an entry, after checking its API terms
   and verifying the manifest rule against live records.

   Three things this tool is careful not to overstate:
   - It searches only the sources listed. No results is not "does not exist".
   - manifest_url is derived by each source's rule and NOT fetched here; a
     result is only confirmed when get_manifest succeeds on it.
   - Rights are whatever the source's API reports for that item, or null. */

import { politeFetch, robotsAllows, contactOf, ToolError } from '../polite.js';
import { stripHtml } from '../iiif.js';

function first(v) { return Array.isArray(v) ? v[0] : v; }
// Clipped: these are short descriptive fields, and on some sources (Internet
// Archive) anyone can write them, so there is no reason to pass on an essay.
function str(v) {
  const s = first(v);
  if (s == null || s === '') return null;
  const t = stripHtml(String(s));
  return t.length > 300 ? t.slice(0, 300) + ' [truncated]' : t;
}
function httpUrl(v) { const s = first(v); return (typeof s === 'string' && /^https?:\/\//.test(s)) ? s : null; }

const SOURCES = {
  internet_archive: {
    name: 'Internet Archive',
    api: 'https://archive.org/advancedsearch.php',
    url: function (q, n) {
      // Lucene operators are stripped so a query cannot address other fields.
      const clean = q.replace(/[()\[\]{}:^~*?\\\/!+|&]/g, ' ').replace(/\s+/g, ' ').trim();
      const p = new URLSearchParams();
      p.set('q', '(' + clean + ') AND mediatype:(texts OR image) AND NOT access-restricted-item:true');
      ['identifier', 'title', 'creator', 'date', 'licenseurl', 'rights', 'contributor'].forEach(function (f) { p.append('fl[]', f); });
      p.set('rows', String(n));
      p.set('output', 'json');
      return this.api + '?' + p.toString();
    },
    parse: function (j) {
      const r = j.response || {};
      return {
        total: r.numFound,
        items: (r.docs || []).map(function (d) {
          const date = str(d.date);
          return {
            title: str(d.title),
            creator: str(d.creator),
            // IA pads bare years to a full timestamp; only the year is reliable.
            date: date ? date.slice(0, 4) : null,
            institution: str(d.contributor) || 'Internet Archive',
            item_url: 'https://archive.org/details/' + encodeURIComponent(d.identifier),
            manifest_url: 'https://iiif.archive.org/iiif/' + encodeURIComponent(d.identifier) + '/manifest.json',
            thumbnail_url: 'https://archive.org/services/img/' + encodeURIComponent(d.identifier),
            rights: { statement_uri: httpUrl(d.licenseurl), text: str(d.rights) }
          };
        })
      };
    }
  },

  wellcome: {
    name: 'Wellcome Collection',
    api: 'https://api.wellcomecollection.org/catalogue/v2/works',
    url: function (q, n) {
      const p = new URLSearchParams({
        query: q,
        'items.locations.locationType': 'iiif-presentation',
        include: 'items,contributors,production',
        pageSize: String(n)
      });
      return this.api + '?' + p.toString();
    },
    parse: function (j) {
      const items = [];
      (j.results || []).forEach(function (w) {
        let loc = null;
        (w.items || []).forEach(function (it) {
          (it.locations || []).forEach(function (l) {
            if (!loc && l.locationType && l.locationType.id === 'iiif-presentation' && l.url) loc = l;
          });
        });
        if (!loc) return;
        const prod = (w.production || [])[0] || {};
        const access = ((loc.accessConditions || [])[0] || {}).status;
        items.push({
          title: str(w.title),
          creator: (w.contributors || []).map(function (c) { return c.agent && c.agent.label; }).filter(Boolean).slice(0, 3).join('; ') || null,
          date: str(prod.dates && prod.dates[0] && prod.dates[0].label) || str(prod.label),
          institution: 'Wellcome Collection',
          item_url: 'https://wellcomecollection.org/works/' + w.id,
          manifest_url: loc.url,
          thumbnail_url: (w.thumbnail && w.thumbnail.url) || null,
          rights: { statement_uri: (loc.license && loc.license.url) || null, text: (loc.license && loc.license.label) || null },
          access: access ? access.label : null
        });
      });
      return { total: j.totalResults, items: items };
    }
  },

  artic: {
    name: 'Art Institute of Chicago',
    api: 'https://api.artic.edu/api/v1/artworks/search',
    // The API's terms ask clients to identify themselves in this header, with
    // a project name and a contact: the operator's, from the CONTACT setting.
    headers: function (env) { return { 'AIC-User-Agent': 'whatiiif-mcp (' + contactOf(env) + ')' }; },
    url: function (q, n) {
      /* An explicit must-match query, not the API's plain `q`.
         `q` only RANKS, it does not filter, so every search
         "matches" the whole collection (a nonsense query returned 133,118
         hits, led by unrelated works with near-zero scores), and adding a
         `query[term]` filter beside `q` drops the text match altogether.
         simple_query_string never throws on odd punctuation. */
      const params = {
        query: { bool: { must: [
          { simple_query_string: { query: q, default_operator: 'and' } },
          // Only public-domain works have openly served images and a manifest.
          { term: { is_public_domain: true } }
        ] } },
        limit: n,
        fields: ['id', 'title', 'artist_display', 'date_display', 'is_public_domain', 'image_id', 'credit_line']
      };
      return this.api + '?params=' + encodeURIComponent(JSON.stringify(params));
    },
    parse: function (j) {
      return {
        total: j.pagination && j.pagination.total,
        scope_note: 'Public-domain works only; the museum does not serve open images for works in copyright.',
        items: (j.data || []).filter(function (d) { return d.image_id; }).map(function (d) {
          return {
            title: str(d.title),
            creator: str(d.artist_display),
            date: str(d.date_display),
            institution: 'Art Institute of Chicago',
            item_url: 'https://www.artic.edu/artworks/' + d.id,
            manifest_url: 'https://api.artic.edu/api/v1/artworks/' + d.id + '/manifest.json',
            thumbnail_url: 'https://www.artic.edu/iiif/2/' + d.image_id + '/full/200,/0/default.jpg',
            rights: { statement_uri: null, text: 'Marked public domain by the Art Institute of Chicago.' + (d.credit_line ? ' Credit: ' + d.credit_line : '') }
          };
        })
      };
    }
  },

  europeana: {
    name: 'Europeana',
    api: 'https://api.europeana.eu/record/v2/search.json',
    needsKey: 'EUROPEANA_API_KEY',
    url: function (q, n, env) {
      const p = new URLSearchParams({
        wskey: env.EUROPEANA_API_KEY,
        query: q,
        // The EDM properties that mark a record as IIIF-bearing.
        qf: 'wr_svcs_hasservice:* AND wr_dcterms_isReferencedBy:*',
        media: 'true',
        profile: 'standard',
        rows: String(n)
      });
      return this.api + '?' + p.toString();
    },
    parse: function (j) {
      return {
        total: j.totalResults,
        // A large share of Europeana's IIIF-flagged records point at image
        // servers that do not answer.
        scope_note: 'Europeana aggregates many institutions; a noticeable share of its IIIF records have image servers that no longer respond, so expect some of these to fail in get_manifest or get_image.',
        items: (j.items || []).filter(function (it) { return it && it.id; }).map(function (it) {
          return {
            title: str(it.title),
            // dcCreator mixes names with authority-file URIs; a URI is an
            // identifier, not something to present as a creator's name.
            creator: str([].concat(it.dcCreator || []).filter(function (c) { return !/^https?:\/\//.test(c); })),
            date: str(it.year),
            institution: str(it.dataProvider) || 'Europeana',
            item_url: 'https://www.europeana.eu/item' + it.id,
            // Ids arrive with a leading slash, e.g. "/1028/E00075067".
            manifest_url: 'https://iiif.europeana.eu/presentation' + it.id + '/manifest',
            thumbnail_url: httpUrl(it.edmPreview),
            rights: { statement_uri: httpUrl(it.rights), text: null }
          };
        })
      };
    }
  },

  /* Digital Scriptorium: union catalog of manuscripts in US collections
     (Penn, Huntington, Free Library of Philadelphia, Indiana...). Official
     Blacklight JSON search. Its results do NOT include the manifest (only the
     record page has it), so results carry manifest_url null and item_url for
     resolve, whose Digital Scriptorium handler reads that one page. That keeps
     a search to a single request instead of one per result. Filtered to
     records with images. Verified live 2026-10-02. */
  digital_scriptorium: {
    name: 'Digital Scriptorium',
    api: 'https://search.digital-scriptorium.org/catalog.json',
    manifestViaResolve: true,
    url: function (q, n) {
      const p = new URLSearchParams({ q: q, per_page: String(n) });
      p.append('f[images_facet][]', 'Yes');
      return this.api + '?' + p.toString();
    },
    parse: function (j) {
      const val = function (a, k) { return a && a[k] && a[k].attributes ? a[k].attributes.value : null; };
      return {
        total: j.meta && j.meta.pages ? j.meta.pages.total_count : null,
        scope_note: 'Digital Scriptorium is a union catalog of manuscripts held by US libraries. Its search results do not include ' +
          'the manifest: pass a result\'s item_url to resolve to get it, then use get_manifest as usual.',
        items: (j.data || []).filter(function (d) { return d && /^DS\d+$/i.test(d.id); }).map(function (d) {
          const a = d.attributes || {};
          // The record title is "{holding institution}, {shelfmark}"; institution
          // names can contain commas, so split at the LAST one.
          const full = str(a.title) || '';
          const cut = full.lastIndexOf(', ');
          const work = str(val(a, 'title_facet'));
          return {
            title: work ? work + ' (' + full + ')' : full,
            creator: null,
            date: str(val(a, 'date_meta')),
            institution: cut > 0 ? full.slice(0, cut) : null,
            item_url: 'https://search.digital-scriptorium.org/catalog/' + d.id,
            manifest_url: null,
            thumbnail_url: null,
            rights: { statement_uri: null, text: null }
          };
        })
      };
    }
  },

  /* DPLA: aggregator of US libraries, archives and museums. Official JSON API,
     free key (needsKey, hidden without it like Europeana).
     Deliberately NOT filtered to IIIF records: only some records carry an
     iiifManifest. The rest keep manifest_url null and item_url set to the
     holding institution's page (isShownAt), which resolve may or may not be
     able to turn into a manifest. per_source reports with_manifest so the
     share is visible. */
  dpla: {
    name: 'Digital Public Library of America',
    api: 'https://api.dp.la/v2/items',
    needsKey: 'DPLA_API_KEY',
    manifestViaResolve: true,
    url: function (q, n, env) {
      const p = new URLSearchParams({ api_key: env.DPLA_API_KEY, q: q, page_size: String(n) });
      return this.api + '?' + p.toString();
    },
    parse: function (j) {
      // Provider fields are a plain string on older records and {name} on newer ones.
      const name = function (v) { v = first(v); return v && typeof v === 'object' ? str(v.name) : str(v); };
      return {
        total: j.count,
        scope_note: 'DPLA aggregates US libraries, archives and museums; institution is the holding one. Many of its records are not ' +
          'published via IIIF. A result with manifest_url null has only the institution\'s page as item_url: pass it to resolve, ' +
          'which will fail for institutions this server cannot read.',
        items: (j.docs || []).filter(function (d) { return d && d.id; }).map(function (d) {
          const sr = d.sourceResource || {};
          const date = first(sr.date) || {};
          const manifest = httpUrl(d.iiifManifest);
          const dplaUrl = 'https://dp.la/item/' + encodeURIComponent(d.id);
          return {
            title: str(sr.title),
            creator: str(sr.creator),
            date: str(date.displayDate),
            institution: name(d.dataProvider) || name(d.provider),
            // resolve needs the institution's own page, not DPLA's record page.
            item_url: httpUrl(d.isShownAt) || (manifest ? dplaUrl : null),
            manifest_url: manifest,
            thumbnail_url: httpUrl(d.object),
            aggregated_from: name(d.provider),
            dpla_url: dplaUrl,
            rights: { statement_uri: httpUrl(d.rights), text: str(sr.rights) }
          };
        })
      };
    }
  },

  /* Biblissima IIIF Collections: an aggregator of manuscripts and rare books
     harvested from many IIIF libraries (Gallica, IRHT, BVH, municipal
     libraries...). It has NO JSON API (every /collections/api route 404s),
     so this is the one source that reads a results PAGE.
     Each result <li> carries the manifest URL, shelfmark and thumbnail as
     data- attributes, which is what this relies on; if the markup changes the
     source reports zero results rather than garbage. Metadata is mostly
     French or Latin, so non-English queries often match better.

     Reading a results page is scraping, however lightly, and nobody at
     Biblissima has been asked. So the source is opt-in (optIn names the var
     that enables it) and, unlike the API sources, each request is checked
     against robots.txt. Ask them before enabling it on a public server. */
  biblissima: {
    name: 'Biblissima IIIF Collections',
    api: 'https://iiif.biblissima.fr/collections/search',
    html: true,
    optIn: 'ENABLE_BIBLISSIMA_SEARCH',
    url: function (q) {
      return this.api + '?' + new URLSearchParams({ q: q }).toString();
    },
    parse: function (html) {
      const ent = function (s) {
        return s == null ? null : String(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      };
      const attr = function (block, name) {
        const m = block.match(new RegExp('\\s' + name + '="([^"]*)"'));
        return m ? ent(m[1]) : null;
      };
      const items = [], seen = {};
      html.split(/<li class="result media/).slice(1).forEach(function (block) {
        block = block.split(/<\/li>\s*<li class="result media|<nav|<footer/)[0];
        const fields = {};
        const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
        let m;
        while ((m = re.exec(block))) fields[stripHtml(m[1]).toLowerCase()] = ent(stripHtml(m[2]));
        const id = attr(block, 'data-id');
        // One manuscript harvested via two collections (e.g. Gallica and
        // Europeana Regia) appears twice with the same manifest; keep the first.
        const manifest = httpUrl(attr(block, 'data-manifest'));
        if (manifest && seen[manifest]) return;
        if (manifest) seen[manifest] = true;
        items.push({
          title: str(attr(block, 'data-shelfmark')),
          creator: null,
          date: str(fields.date),
          institution: str(fields.library) || str(fields.collection),
          item_url: id && /^[0-9a-f]+$/.test(id) ? 'https://iiif.biblissima.fr/collections/manifest/' + id : null,
          manifest_url: manifest,
          thumbnail_url: httpUrl(attr(block, 'data-thumbnail')),
          aggregated_from: str(fields.collection),
          language: str(fields.language),
          rights: { statement_uri: null, text: null }
        });
      });
      const total = (html.match(/<title>\s*([\d,]+) results? found/) || [])[1];
      return {
        total: total ? parseInt(total.replace(/,/g, ''), 10) : null,
        scope_note: 'Biblissima aggregates manuscripts and rare books from many (mostly French) libraries; institution is the holding library. ' +
          'Its catalogue data is largely in French or Latin, so try French or Latin terms (e.g. "herbier", "livre d\'heures") if English finds little. ' +
          'Rights are not given in its search results; get_manifest reports them from the source manifest.',
        items: items
      };
    }
  }
};

export const SOURCE_IDS = Object.keys(SOURCES);

/* Sources usable with this deployment's settings. A keyed source with no key,
   or an opt-in source that is not switched on, is left out of the tool
   description, the sources enum and the per-source report, so the model is
   never told about a source it cannot use (told of one, it mentions the
   absence to users). */
export function availableSources(env) {
  return SOURCE_IDS.filter(function (id) {
    const s = SOURCES[id];
    if (s.needsKey && !(env && env[s.needsKey])) return false;
    if (s.optIn && String(env && env[s.optIn]).toLowerCase() !== 'true') return false;
    return true;
  });
}

// The usable sources by name, for the coverage resource.
export function sourceList(env) {
  return availableSources(env).map(function (id) {
    return { id: id, name: SOURCES[id].name, manifest_via_resolve: !!SOURCES[id].manifestViaResolve };
  });
}

async function searchOne(id, query, limit, env) {
  const src = SOURCES[id];
  const report = { source: id, name: src.name, api: src.api };
  if (src.needsKey && !(env && env[src.needsKey])) {
    return { report: Object.assign(report, { status: 'unavailable', returned: 0,
      note: 'Not configured on this server (no API key set).' }), items: [] };
  }
  try {
    // Over-ask slightly: some sources drop rows that have no usable manifest.
    const reqUrl = src.url(query, Math.min(20, limit + 3), env);
    // An API is published to be called; a results page is not, so ask first.
    if (src.html && !(await robotsAllows(reqUrl))) {
      return { report: Object.assign(report, { status: 'error', returned: 0,
        note: src.name + '\'s robots.txt asks automated clients not to read its search results, so it was not searched.' }), items: [] };
    }
    const extraHeaders = typeof src.headers === 'function' ? src.headers(env) : (src.headers || {});
    const r = await politeFetch(reqUrl, {
      kind: 'page', headers: Object.assign({ Accept: src.html ? 'text/html' : 'application/json' }, extraHeaders)
    });
    if (r.status !== 200) {
      return { report: Object.assign(report, { status: 'error', returned: 0,
        note: src.name + ' search returned HTTP ' + r.status + '.' }), items: [] };
    }
    const body = await r.text();
    const parsed = src.parse(src.html ? body : JSON.parse(body));
    const items = parsed.items.filter(function (x) { return (x.manifest_url || (src.manifestViaResolve && x.item_url)) && x.title; }).slice(0, limit)
      .map(function (x) {
        const extra = x.manifest_url ? { manifest_verified: false }
          : { manifest_verified: false, next_step: 'No manifest_url from this source: pass item_url to resolve.' };
        return Object.assign({ source: id }, x, extra);
      });
    Object.assign(report, { status: 'ok', returned: items.length,
      with_manifest: items.filter(function (x) { return x.manifest_url; }).length,
      total_matches: parsed.total == null ? null : parsed.total,
      searched_at: r.fetchedAt, from_cache: !!r.fromCache });
    if (parsed.scope_note) report.note = parsed.scope_note;
    return { report: report, items: items };
  } catch (e) {
    // Never echo the request URL here: for keyed sources it contains the key.
    const msg = (e instanceof ToolError) ? e.message.replace(/https?:\/\/\S+/g, src.name) : 'Unexpected response from ' + src.name + '.';
    return { report: Object.assign(report, { status: e instanceof ToolError && e.code === 'rate_limited' ? 'rate_limited' : 'error',
      returned: 0, note: msg }), items: [] };
  }
}

export async function search(args, env) {
  const query = String(args.query || '').replace(/\s+/g, ' ').trim();
  if (query.length < 2) throw new ToolError('invalid_input', 'query must be at least 2 characters.');
  if (/^https?:\/\//i.test(query)) {
    throw new ToolError('invalid_input', 'That is a URL, not a search query. Pass URLs to resolve instead.');
  }
  const limit = Math.min(10, Math.max(1, args.limit || 5));
  const usable = availableSources(env);
  let ids = (args.sources && args.sources.length) ? args.sources.filter(function (s) { return usable.indexOf(s) !== -1; }) : usable;
  if (!ids.length) ids = usable;
  ids = ids.filter(function (s, i) { return ids.indexOf(s) === i; });

  // One request per source, in parallel: they are different institutions, so
  // this is not a burst against any one of them.
  const out = await Promise.all(ids.map(function (id) { return searchOne(id, query, limit, env); }));

  const answered = out.filter(function (o) { return o.report.status === 'ok'; });
  if (!answered.length) {
    throw new ToolError('search_failed', 'None of the search sources answered. See per_source for what each one reported. ' +
      'You can still find the item with your own web search tool, if you have one, and pass its page URL to resolve.',
      { query: query, per_source: out.map(function (o) { return o.report; }) });
  }

  // Interleave so no single source crowds out the others.
  const results = [];
  for (let i = 0; i < limit; i++) {
    out.forEach(function (o) { if (o.items[i]) results.push(o.items[i]); });
  }

  return {
    query: query,
    result_count: results.length,
    results: results,
    per_source: out.map(function (o) { return o.report; }),
    coverage_note: 'Only the sources in per_source were searched, each returning its top ' + limit +
      '. Most libraries, archives and museums are not covered, so no result here does not mean an item does not exist or is not digitized. ' +
      'If what the user wants is not among these results, do not stop here: use your own web search tool, if you have one, ' +
      'to find the item\'s page on the holding institution\'s website, then pass that URL to resolve. ' +
      'If you have no web search, ask the user for the item\'s page URL.',
    next_step: 'manifest_url values are derived from each source\'s rule and have not been fetched (manifest_verified: false). ' +
      'Call get_manifest on a result to confirm it and get its full metadata and rights. ' +
      'A result with manifest_url null (all of Digital Scriptorium, some of DPLA) needs its item_url passed to resolve first.',
    rights_note: 'Each result\'s rights are as reported by that source\'s search API, and null where it reports none. ' +
      'get_manifest returns the authoritative rights statement for an item.',
    provenance: { searched_at: new Date().toISOString(), retrieved_via: 'whatiiif MCP server' }
  };
}

/* make_citation: a whatiiif deep link to a page or region, plus a formatted
   citation, rights, and provenance.

   The links are built by detect.js (buildWhatiiifHighlightUrl,
   buildCanvasContentState), so a link minted here is byte-identical to one
   minted by dragging the same box on whatiiif.com. */

import {
  detect, getLabel, loadManifestOnly, resolveCanvas, parseRegion,
  metadataPairs, findMeta, findMetaPair, rightsBlock, provenanceBlock
} from '../iiif.js';
import { formatCitation, STYLES } from '../cite.js';
import { buildEmbed } from '../viewer.js';

/* Metadata label patterns, matched from the start of the label. English
   first, then French, German, Italian, Spanish and Latin, because European
   sources (IRHT, Gallica, Biblissima's members) label metadata in their own
   language. Words that collide with English labels are left out: Italian
   "data" alone, and "signatur" only as a whole word so "Signatures" (the
   collation field) does not match. */
const CREATOR_RE = new RegExp('^(creator|author|artist|maker|photographer|cartographer|composer|scribe' +
  '|auteur|créateur|createur|artiste|copiste' +          // French
  '|verfasser|urheber|künstler|kuenstler|schreiber' +    // German
  '|autore|creatore|artista|copista' +                   // Italian, Spanish
  '|autor|creador' +                                     // Spanish, German
  '|auctor|scriptor)s?\\b', 'i');                        // Latin
const DATE_RE = new RegExp('^(date|published\\/created date|created|date created|publication date|issued|published' +
  '|datation' +                                          // French ("date de ..." matched by "date")
  '|datierung|entstehung|datum|jahr' +                   // German
  '|datazione|data di' +                                 // Italian
  '|fecha)\\b', 'i');                                    // Spanish
const CALLNUMBER_RE = new RegExp('^(call number|shelfmark|shelf mark|classmark|accession number|identifier' +
  '|cote' +                                              // French
  '|signatur' +                                          // German
  '|segnatura|collocazione' +                            // Italian
  '|signatura)\\b', 'i');                                // Spanish
// A label naming both creator and title, e.g. IRHT "Auteur, titre, oeuvre".
const TITLE_WORD_RE = /\b(title|titre|titel|titolo|título|titulo|titulus)\b/i;
// A metadata field naming the holding institution (Yale Center for British
// Art declares "Institution"), in the same languages as above.
const INSTITUTION_RE = new RegExp('^(institution|holding institution|owning institution|repository|physical location' +
  '|lieu de conservation|dépositaire|depositaire' +
  '|aufbewahrungsort|standort|besitzende institution' +
  '|istituzione|ente conservatore' +
  '|institución|institucion|repositorio|biblioteca|bibliothek)\\b', 'i');
// An attribution that is a rights or licence notice, not a name. Yale Center
// for British Art's reads "Metadata describing Yale Center for British Art
// collections is public domain under CC0. Copyright or other restrictions...".
const NOTICE_RE = /\b(public domain|copyright|licen[cs]e|CC0|CC BY|creative commons|rights reserved|restrictions)\b/i;

// Trailing life dates, "William Blake, 1757-1827" or "Smith, John, 1820-",
// written with any dash: Yale uses U+2013 (en dash).
function stripLifeDates(s) {
  return String(s).replace(/,?\s*\d{4}\s*[-\u2010-\u2015\u2212]\s*\d{0,4}\.?$/, '').trim();
}

function creatorFrom(pairs) {
  const p = findMetaPair(pairs, CREATOR_RE);
  if (!p) return null;
  if (!TITLE_WORD_RE.test(p.label)) return stripLifeDates(p.value) || null;
  // Combined field: "JEAN FROISSART, Chroniques". The name is before the first
  // comma; with no comma the two cannot be told apart, so report nothing.
  const i = p.value.indexOf(',');
  return i > 0 ? p.value.slice(0, i).trim() : null;
}

// Declared provider first, then a metadata institution field, then the
// attribution, unless the attribution is a rights notice.
function repositoryFrom(pairs, rights) {
  if (rights.provider && rights.provider.name) return rights.provider.name;
  const inst = metaValue(pairs, INSTITUTION_RE);
  if (inst) return inst;
  if (rights.attribution && !NOTICE_RE.test(rights.attribution)) return rights.attribution;
  return null;
}
function metaValue(pairs, re) { const p = findMetaPair(pairs, re); return p ? p.value : null; }

export async function makeCitation(args) {
  const m = await loadManifestOnly(String(args.manifest).trim());
  const cv = resolveCanvas(m, args.canvas);
  const region = parseRegion(args.region, cv);
  const style = STYLES[args.style] ? args.style : 'chicago';
  const label = args.label ? String(args.label).slice(0, 200) : '';

  const svc = detect.getServiceBase(cv.canvas);
  const contentState = detect.buildCanvasContentState(m.url, cv.id, region ? region.xywh : null, label || null);
  // With a region: whatiiif's own highlight link. Without: the Content State
  // form, which opens the viewer on that canvas (?canvas= alone is only read
  // alongside xywh).
  const whatiiifUrl = region
    ? detect.buildWhatiiifHighlightUrl(m.url, cv.index, region.xywh, label || null, svc)
    : detect.WHATIIIF_BASE + '/?iiif-content=' + contentState;

  const pairs = metadataPairs(m.doc);
  const rights = rightsBlock(m.doc);
  const fields = {
    title: getLabel(m.doc.label) || null,
    creator: creatorFrom(pairs),
    date: metaValue(pairs, DATE_RE),
    callNumber: metaValue(pairs, CALLNUMBER_RE),
    repository: repositoryFrom(pairs, rights),
    page: cv.label ? cv.label : 'image ' + (cv.index + 1) + ' of ' + m.canvases.length,
    region: region ? region.xywh : null,
    sourceUrl: rights.source_page || m.url,
    // A region is cited by its deep link. A whole page is cited by the
    // institution's own item page, with the deep link returned alongside.
    linkUrl: region ? whatiiifUrl : (rights.source_page || whatiiifUrl),
    accessed: new Date()
  };

  const missing = [];
  if (!fields.title) missing.push('title');
  if (!fields.creator) missing.push('creator');
  if (!fields.date) missing.push('date');
  if (!fields.repository) missing.push('repository');
  if (!rights.source_page) missing.push('source_page');
  if (!rights.statement_declared) missing.push('rights_statement');

  return {
    whatiiif_url: whatiiifUrl,
    // embed.html is a ready-to-paste <iframe> of the interactive whatiiif
    // viewer, for web pages. Hosts that support MCP Apps show the region in
    // the conversation themselves (see ../viewer.js, which reads `cited`).
    embed: buildEmbed(m.url, cv, region, label || null, svc, fields.title),
    label: label || null,
    content_state: contentState,
    style: style,
    citation: formatCitation(style, fields),
    institution_citation: findMeta(pairs, /^(preferred citation|citation|cite as|credit line)\b/i),
    institution_citation_note: 'When the institution supplies its own preferred citation, use it for the item and add the page or region and the link from this response.',
    missing_fields: missing,
    missing_fields_note: missing.length
      ? 'These were not declared in the manifest and were left out of the citation rather than guessed. Check the source page before publishing.'
      : null,
    cited: {
      title: fields.title, creator: fields.creator, date: fields.date,
      call_number: fields.callNumber, repository: fields.repository,
      canvas: { index: cv.index, id: cv.id, label: cv.label, width: cv.width, height: cv.height },
      region: region ? region.xywh : null,
      region_image_url: (region && svc) ? detect.iiifUrl(svc, region.xywh, Math.min(1024, region.w) + ',') : null
    },
    accessed: fields.accessed.toISOString().slice(0, 10),
    rights: rights,
    provenance: provenanceBlock(m)
  };
}

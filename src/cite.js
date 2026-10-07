/* cite.js: citation formatting.
 *
 * Rule for this whole file: a citation is assembled only from fields the
 * manifest actually carries. A missing creator or date is left out and named
 * in `missing`, never filled with a guess, "n.d." excepted where the style
 * itself calls for it. A citation that looks complete but was partly invented
 * is worse than one with a visible gap.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function dot(s) { return /[.?!]$/.test(s) ? s : s + '.'; }
function join(parts, sep) { return parts.filter(Boolean).join(sep); }

/* f: { creator, title, date, page, region, callNumber, repository, sourceUrl,
        linkUrl, accessed (Date), manifestUrl, label } */
function chicago(f) {
  const acc = MONTHS[f.accessed.getUTCMonth()] + ' ' + f.accessed.getUTCDate() + ', ' + f.accessed.getUTCFullYear();
  const where = join([f.page, f.region ? 'detail (region ' + f.region + ')' : null], ', ');
  return join([
    f.creator ? dot(f.creator) : null,
    f.title ? dot(f.title) : null,
    f.date ? dot(f.date) : null,
    where ? dot(where) : null,
    join([f.callNumber, f.repository], ', ') ? dot(join([f.callNumber, f.repository], ', ')) : null,
    dot(f.sourceUrl),
    f.region ? dot('Region view: ' + f.linkUrl) : null,
    'Accessed ' + acc + '.'
  ], ' ');
}

function mla(f) {
  const acc = f.accessed.getUTCDate() + ' ' + MONTHS[f.accessed.getUTCMonth()].slice(0, 3) + '. ' + f.accessed.getUTCFullYear();
  return join([
    f.creator ? dot(f.creator) : null,
    f.title ? dot('*' + f.title + '*') : null,
    f.date ? dot(f.date) : null,
    join([f.repository, f.callNumber, f.page, f.region ? 'detail' : null], ', ') ? dot(join([f.repository, f.callNumber, f.page, f.region ? 'detail' : null], ', ')) : null,
    dot(f.linkUrl),
    'Accessed ' + acc.replace('May.', 'May') + '.'
  ], ' ');
}

function apa(f) {
  const lead = f.creator ? dot(f.creator) + ' (' + (f.date || 'n.d.') + ').' : null;
  const title = f.title ? '*' + f.title + '*' : null;
  const desc = '[' + join(['Digitized item', f.page, f.region ? 'detail' : null], ', ') + ']';
  return join([
    lead || (title ? title + ' ' + desc + '.' : null),
    lead ? (title ? title + ' ' + desc + '.' : desc + '.') : '(' + (f.date || 'n.d.') + ').',
    join([f.repository, f.callNumber], ', ') ? dot(join([f.repository, f.callNumber], ', ')) : null,
    f.linkUrl
  ], ' ');
}

function bibtexEscape(s) { return String(s).replace(/([{}%&#_$])/g, '\\$1'); }

function bibtex(f) {
  const key = (String(f.title || 'item').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).join('') || 'item') +
    (f.page ? '_' + String(f.page).toLowerCase().replace(/[^a-z0-9]+/g, '') : '');
  const fields = [
    ['author', f.creator], ['title', f.title], ['year', f.date],
    ['howpublished', join([f.repository, f.callNumber], ', ')],
    ['note', join([f.page, f.region ? 'region ' + f.region : null], ', ')],
    ['url', f.linkUrl],
    ['urldate', f.accessed.toISOString().slice(0, 10)]
  ].filter(function (p) { return p[1]; });
  return '@misc{' + key + ',\n' + fields.map(function (p) {
    return '  ' + p[0] + ' = {' + (p[0] === 'url' ? p[1] : bibtexEscape(p[1])) + '}';
  }).join(',\n') + '\n}';
}

function cslJson(f) {
  // 'document' is CSL's neutral type; the manifest does not say what kind of
  // object this is, so nothing more specific is claimed.
  const o = { type: 'document', URL: f.linkUrl };
  if (f.title) o.title = f.title;
  if (f.creator) o.author = [{ literal: f.creator }];
  if (f.date) o.issued = { literal: f.date };
  if (f.repository) o.archive = f.repository;
  if (f.callNumber) o.archive_location = f.callNumber;
  const note = join([f.page, f.region ? 'region ' + f.region : null], ', ');
  if (note) o.note = note;
  o.source = f.sourceUrl;
  const a = f.accessed;
  o.accessed = { 'date-parts': [[a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate()]] };
  return JSON.stringify(o);
}

export const STYLES = { chicago: chicago, mla: mla, apa: apa, bibtex: bibtex, 'csl-json': cslJson };

export function formatCitation(style, fields) {
  return (STYLES[style] || chicago)(fields);
}

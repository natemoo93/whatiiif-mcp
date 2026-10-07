/* The coverage resource: what this server can and cannot reach, as a page a
   user can attach to a conversation.

   The lists are built from what the tools themselves use (detect.js's
   PLATFORMS, search.js's SOURCES), so the page cannot name a handler or a
   source that is not there, and a keyed source with no key stays hidden just
   as it does in the search tool. Only NOTES and the fixed paragraphs are
   written by hand.

   Every word here is this server's own: nothing is fetched and no institution
   text is quoted, so it does not go through withTrust. */

import { detect } from './iiif.js';
import { sourceList } from './tools/search.js';
import { robotsEnabled } from './polite.js';

export const COVERAGE_URI = 'whatiiif://coverage';
export const COVERAGE_MIME = 'text/markdown';

// PLATFORMS entries that are input forms, not institutions; described in prose below.
const INPUT_FORMS = ['IIIF viewer link', 'Direct manifest URL'];

// Known limits, keyed by PLATFORMS name. A key matching no handler is ignored.
const NOTES = {
  'CONTENTdm': 'any site running CONTENTdm, on any domain',
  'Internet Archive': 'including one work inside a multi-file item',
  'Library of Congress': 'turns away automated clients and cloud hosting, so expect blocked_by_institution',
  'Harvard CURIOSity': 'the manifest address it leads to (nrs.harvard.edu) is disallowed by that host\'s robots.txt, so expect robots_disallowed; pass the manifest link from the item page instead',
  'Yale Center for British Art': 'art collection records (tms: ids) only; by URL only, its search cannot be queried by this server',
  'Wellcome Collection': 'multi-volume works resolve to volume 1'
};

function handlerNames() {
  const seen = [];
  detect.PLATFORMS.forEach(function (p) {
    if (INPUT_FORMS.indexOf(p.name) === -1 && seen.indexOf(p.name) === -1) seen.push(p.name);
  });
  return seen.sort(function (a, b) { return a.localeCompare(b); });
}

export function coverageText(env) {
  const sources = sourceList(env).map(function (s) {
    return '- ' + s.name + ' (`' + s.id + '`)' +
      (s.manifest_via_resolve ? ': some or all results carry no manifest_url; pass their item_url to `resolve`' : '');
  });
  const handlers = handlerNames().map(function (n) {
    return '- ' + n + (NOTES[n] ? ': ' + NOTES[n] : '');
  });

  return [
    '# whatiiif MCP server: coverage',
    '',
    'What this server can reach, generated from its own source and handler lists.',
    '',
    '## Search (free text)',
    '',
    'The `search` tool queries only these sources:',
    '',
    sources.join('\n'),
    '',
    'Most libraries, archives and museums are not among them, so an empty result does not mean an item ' +
    'does not exist or is not digitized. This server does no web search. For anything held elsewhere, ' +
    'find the item\'s page on the holding institution\'s website and pass that URL to `resolve`.',
    '',
    'Links that `make_citation` creates open in the viewer at ' + detect.WHATIIIF_BASE + '.',
    '',
    '## Resolve (by URL)',
    '',
    'The `resolve` tool has a built-in handler for item pages at:',
    '',
    handlers.join('\n'),
    '',
    'A handler does not make an institution searchable. Unless it also appears under Search, its items ' +
    'are reachable only by URL.',
    '',
    '`resolve` also accepts, from any institution:',
    '',
    '- a IIIF manifest URL',
    '- a viewer link carrying `?manifest=` or `?iiif-content=`',
    '- a whatiiif.com link',
    '- a IIIF Content State token',
    '',
    'For a page on any other site, `allow_page_scan: true` reads the page and probes up to ' +
    detect.SNIIIFFER_PROBE_CAP + ' links that look like manifests. It is opt-in, and it works only where ' +
    'a scripted client can read the page and the page links its manifest.',
    '',
    '## Limits',
    '',
    '- Items not published via IIIF cannot be read at all.',
    '- This server identifies itself honestly to every site. Sites that challenge or block automated clients return `blocked_by_institution`. That is reported, not worked around.',
    (robotsEnabled(env)
      ? '- robots.txt is honoured for everything the server looks up by its own rules. Where a site disallows that, `resolve` returns `robots_disallowed`.'
      : '- robots.txt is NOT honoured on this deployment (the operator has turned it off).'),
    '- Yale Library and Princeton University Library have no handler, because their robots.txt files disallow the lookups one would need. Their items can be read only by passing the IIIF manifest URL itself.',
    '- There is no text-returning tool. `get_manifest` says whether a text layer is declared; pages are otherwise read as images.',
    '- Rights are reported as the manifest declares them. A missing rights statement is reported as missing, never inferred.',
    ''
  ].join('\n');
}

/* polite.js: the only module in this Worker that talks to the network.
 *
 * Every outbound request goes through politeFetch(): tool code calls it
 * directly, and installGlobalFetch() routes the bare fetch() calls inside the
 * detect.js handlers through it too, so a handler that reads an intermediate
 * page or lookup API (LibraryCloud, BHL, Digital Scriptorium) is identified,
 * cached, rate limited and robots-checked without detect.js having to know
 * this server exists.
 *
 * What it enforces, per request:
 *   - an honest User-Agent naming this software and the operator's contact
 *   - http(s) only, and never a private, loopback or link-local host
 *   - a per-institution rate limit (keyed by upstream hostname)
 *   - a backoff window after an upstream 429 / 503 with Retry-After
 *   - a response cache, so repeat calls cost the institution nothing
 *   - a timeout and a size ceiling
 * and, for every URL the server works out for itself, robots.txt.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export class ToolError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || {};
  }
}

const SOFTWARE = 'whatiiif-mcp/0.1.0';
// The product token robots.txt rules are matched against.
const ROBOTS_TOKEN = 'whatiiif-mcp';

/* Who runs this deployment, from the CONTACT var: an https URL or an email
   address where an institution can reach the operator. Returns null when it
   is unset or still the placeholder, and the server then refuses to make
   requests at all: an institution that sees traffic from this software must
   be able to find the person responsible for it. */
export function contactOf(env) {
  const c = String((env && env.CONTACT) || '').trim().replace(/^mailto:/i, '');
  if (!c || /[\s()<>]/.test(c) || /example\.(org|com|net)\b/i.test(c)) return null;
  if (/^https:\/\/[^\/]+\.[^\/]+/i.test(c)) return c;
  if (/^[^@\/]+@[^@\/]+\.[^@\/]+$/.test(c)) return c;
  return null;
}

/* The User-Agent every request carries, e.g.
     whatiiif-mcp/0.1.0 (+https://example.edu/iiif-tools)
   This server never presents itself as a browser. An institution that turns
   away identified automated clients has made a decision, and the right
   response is the blocked_by_institution error, not a disguise. */
export function userAgent(env) {
  const c = contactOf(env);
  if (!c) return null;
  return SOFTWARE + ' (' + (/^https:/i.test(c) ? '+' : '') + c + ')';
}

export const TTL = {
  manifest: 86400,      // manifests and info.json change rarely
  image: 604800,        // a given Image API URL is immutable in practice
  page: 3600,           // institution HTML pages and lookup APIs
  robots: 86400,
  miss: 300             // 404 / 410, so a repeated bad guess is not re-sent
};

const TIMEOUT_MS = 15000;
const MAX_BYTES = { json: 10 * 1024 * 1024, image: 6 * 1024 * 1024, page: 4 * 1024 * 1024 };
const CACHE_NS = 'https://cache.whatiiif-mcp.internal/';

let ENV = null;
let nativeFetch = null;

export function setEnv(env) { ENV = env; }

/* Route bare fetch() calls (the detect.js handlers) through politeFetch.
   Idempotent; called once per isolate.

   These are lookups the server decided to make (a catalogue API, an item
   page, a redirect that reveals an identifier), not URLs the caller named, so
   each one is checked against robots.txt first. A refusal is thrown, and also
   recorded for collectRobotsRefusals, because the handlers catch every error
   and would otherwise report it as "no manifest". */
export function installGlobalFetch() {
  if (nativeFetch) return;
  nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    if (method !== 'GET') return nativeFetch(input, init);
    if (!(await robotsAllows(url))) {
      const log = robotsLog.getStore();
      if (log) log.push(url);
      throw new ToolError('robots_disallowed', 'robots.txt asks automated clients not to request ' + url + '.', { url: url });
    }
    return politeFetch(url, { kind: 'page', headers: init && init.headers });
  };
}

const robotsLog = new AsyncLocalStorage();

/* Run fn and report which of its bare fetch() calls robots.txt refused.
   Resolves to { value, refused }, where refused is a list of URLs. */
export async function collectRobotsRefusals(fn) {
  const refused = [];
  const value = await robotsLog.run(refused, async function () { return fn(); });
  return { value: value, refused: refused };
}

/* Is this IPv4 address (four numbers) one this server must never fetch?
   Loopback, private ranges, link-local (which includes cloud metadata at
   169.254.169.254), carrier-grade NAT, benchmarking, and "this network". */
function isPrivateV4(a, b) {
  return a === 127 || a === 10 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

/* True for a hostname or IP literal that points at the local machine or a
   private network. The URL parser has already normalised odd IPv4 spellings
   (decimal, hex, short forms) to dotted quads by the time this runs.
   Exported for the DNS check below and for tests. */
export function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateV4(+v4[1], +v4[2]);
  if (h.indexOf(':') !== -1) {
    if (h === '::' || h === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;   // unique-local, link-local
    // IPv4 carried inside IPv6: ::ffff:a.b.c.d, which the URL parser rewrites
    // as ::ffff:hhhh:hhhh, and the NAT64 prefix 64:ff9b::/96.
    const mapped = h.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) { const hi = parseInt(mapped[1], 16); return isPrivateV4(hi >> 8, hi & 255); }
    const dotted = h.match(/^(?:::ffff:|64:ff9b::)(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (dotted) return isPrivateV4(+dotted[1], +dotted[2]);
  }
  return false;
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') !== -1;
}

/* Deployed on Cloudflare a Worker cannot reach a private network at all, so
   the checks above are belt and braces there. Run on someone's own machine
   (wrangler dev) the fetches leave from inside their network, and then they
   are the only thing between a hostile manifest and the user's LAN. */
function isLocalRun() {
  return !!(ENV && ENV.PUBLIC_ORIGIN && !/^https:\/\//.test(ENV.PUBLIC_ORIGIN));
}

/* A public-looking name can resolve to a private address (localtest.me is
   127.0.0.1). Local runs only: ask a public resolver where the name points and
   refuse if any answer is private. This narrows the hole; it cannot close it,
   because the name could resolve differently a moment later when the real
   request is made. If the resolver cannot be reached the request is refused:
   on a local run this check is the only thing standing between a hostile
   manifest and the user's own network, so it fails closed. */
async function assertPublicDns(host) {
  if (!isLocalRun() || isIpLiteral(host)) return;
  const cache = caches.default;
  const key = new Request(CACHE_NS + 'dns/' + host);
  const hit = await cache.match(key);
  let verdict = hit ? await hit.text() : null;
  if (!verdict) {
    verdict = 'public';
    try {
      const answers = await Promise.all(['A', 'AAAA'].map(async function (type) {
        const r = await nativeFetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=' + type,
          { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
        const j = r.ok ? await r.json() : {};
        return (j.Answer || []).filter(function (a) { return a.type === 1 || a.type === 28; }).map(function (a) { return a.data; });
      }));
      if ([].concat(answers[0], answers[1]).some(isPrivateHost)) verdict = 'private';
    } catch (e) {
      throw new ToolError('upstream_unreachable',
        'Could not confirm that ' + host + ' is a public address (the DNS check did not answer), so the request was not made.',
        { institution: host });
    }
    await cache.put(key, new Response(verdict, { headers: { 'Cache-Control': 'public, max-age=600' } }));
  }
  if (verdict === 'private') {
    throw new ToolError('invalid_url', 'Refusing to fetch ' + host + ': it resolves to a private or local address.');
  }
}

export function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new ToolError('invalid_url', 'Not a valid URL: ' + raw); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ToolError('invalid_url', 'Only http and https URLs are fetched.');
  }
  if (isPrivateHost(u.hostname)) {
    throw new ToolError('invalid_url', 'Refusing to fetch a private or local address: ' + u.hostname);
  }
  return u;
}

function cacheKey(url) {
  return new Request(CACHE_NS + encodeURIComponent(url));
}

function backoffKey(host) {
  return new Request(CACHE_NS + 'backoff/' + host);
}

/* A Response whose .url is the upstream's final URL. Responses built from a
   buffer have an empty url, and the BHL handler reads r.url after a redirect. */
function buildResponse(body, status, headers, finalUrl) {
  const r = new Response(body, { status: status, headers: headers });
  Object.defineProperty(r, 'url', { value: finalUrl });
  return r;
}

/* The Cache API does not persist on a workers.dev address, so there every
   call reaches the institution and a 429 backoff is forgotten at once. A
   deployment in that state gets the stricter limiter to make up for it. */
function hostLimiter() {
  if (!ENV) return null;
  let host = '';
  try { host = new URL(ENV.PUBLIC_ORIGIN).hostname; } catch (e) {}
  if (/\.workers\.dev$/i.test(host) && ENV.HOST_LIMITER_UNCACHED) return ENV.HOST_LIMITER_UNCACHED;
  return ENV.HOST_LIMITER || null;
}

async function enforceHostLimit(host) {
  const cache = caches.default;
  const b = await cache.match(backoffKey(host));
  if (b) {
    const until = parseInt(await b.text(), 10) || 0;
    const wait = Math.ceil((until - Date.now()) / 1000);
    if (wait > 0) {
      throw new ToolError('rate_limited',
        host + ' asked clients to slow down. Try again in about ' + wait + ' seconds.',
        { institution: host, retry_after: wait });
    }
  }
  const limiter = hostLimiter();
  if (limiter) {
    const res = await limiter.limit({ key: host });
    if (!res.success) {
      throw new ToolError('rate_limited',
        'This server limits how often it contacts ' + host + ' so it stays a polite client. Try again in a minute.',
        { institution: host, retry_after: 60 });
    }
  }
}

/* GET a URL politely. Resolves to a Response with three extra properties:
     fromCache  boolean
     fetchedAt  ISO time the bytes left the institution (not "now" on a hit)
   Non-2xx statuses resolve normally (callers decide); network failures and
   policy refusals throw ToolError. */
export async function politeFetch(rawUrl, opts) {
  opts = opts || {};
  const kind = opts.kind || 'json';
  const u = checkUrl(rawUrl);
  const url = u.href;
  const host = u.hostname;
  const cache = caches.default;

  const hit = await cache.match(cacheKey(url));
  if (hit) {
    const r = buildResponse(hit.body, parseInt(hit.headers.get('x-upstream-status') || '200', 10),
      hit.headers, hit.headers.get('x-final-url') || url);
    r.fromCache = true;
    r.fetchedAt = hit.headers.get('x-fetched-at') || null;
    return r;
  }

  const ua = userAgent(ENV);
  if (!ua) {
    throw new ToolError('not_configured',
      'This server has no operator contact configured (the CONTACT setting), so it does not make requests to institutions.');
  }

  await enforceHostLimit(host);

  const headers = {
    'User-Agent': ua,
    'Accept': kind === 'image' ? 'image/jpeg, image/*'
      : 'application/ld+json, application/json, text/html, */*'
  };
  // Caller headers (an Accept override, or an identification header a
  // particular API asks for) are added on top; they never replace the UA.
  if (opts.headers) {
    Object.keys(opts.headers).forEach(function (k) {
      if (!/^user-agent$/i.test(k)) headers[k] = opts.headers[k];
    });
  }

  /* Redirects are followed by hand so that every hop is checked BEFORE it is
     requested. With redirect:'follow' the request to a private address has
     already been made by the time the final URL can be inspected. */
  await assertPublicDns(host);
  let up, finalUrl = url;
  try {
    for (let hops = 0; ; hops++) {
      up = await (nativeFetch || fetch)(finalUrl, { headers: headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const loc = (up.status >= 300 && up.status < 400) ? up.headers.get('location') : null;
      if (!loc) break;
      if (hops >= 5) throw new ToolError('upstream_error', host + ' redirected too many times.', { institution: host });
      const next = checkUrl(new URL(loc, finalUrl).href);
      await assertPublicDns(next.hostname);
      finalUrl = next.href;
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ToolError('upstream_timeout',
        host + ' did not respond within ' + (TIMEOUT_MS / 1000) + ' seconds.', { institution: host });
    }
    throw new ToolError('upstream_unreachable', 'Could not reach ' + host + ': ' + (e && e.message), { institution: host });
  }

  if (up.status === 429 || (up.status === 503 && up.headers.get('retry-after'))) {
    const ra = Math.min(3600, Math.max(30, parseInt(up.headers.get('retry-after'), 10) || 60));
    await cache.put(backoffKey(host), new Response(String(Date.now() + ra * 1000), {
      headers: { 'Cache-Control': 'public, max-age=' + ra }
    }));
    throw new ToolError('rate_limited',
      host + ' is rate limiting requests (HTTP ' + up.status + '). Try again in about ' + ra + ' seconds.',
      { institution: host, retry_after: ra });
  }

  const max = MAX_BYTES[kind] || MAX_BYTES.json;
  const declared = parseInt(up.headers.get('content-length') || '0', 10);
  if (declared > max) {
    throw new ToolError('too_large', 'Response from ' + host + ' is larger than this server accepts (' + declared + ' bytes).', { institution: host });
  }
  const buf = await up.arrayBuffer();
  if (buf.byteLength > max) {
    throw new ToolError('too_large', 'Response from ' + host + ' is larger than this server accepts (' + buf.byteLength + ' bytes).', { institution: host });
  }

  const fetchedAt = new Date().toISOString();
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
  outHeaders.set('x-fetched-at', fetchedAt);
  outHeaders.set('x-final-url', finalUrl);
  outHeaders.set('x-upstream-status', String(up.status));

  let ttl = 0;
  if (up.status >= 200 && up.status < 300) ttl = opts.ttl || TTL[kind === 'json' ? 'manifest' : kind] || TTL.page;
  else if (up.status === 404 || up.status === 410) ttl = TTL.miss;
  if (ttl) {
    const ch = new Headers(outHeaders);
    ch.set('Cache-Control', 'public, max-age=' + ttl);
    // Cache API only stores 200s, so the real status rides in a header.
    await cache.put(cacheKey(url), new Response(buf.slice(0), { status: 200, headers: ch }));
  }

  const r = buildResponse(buf, up.status, outHeaders, finalUrl);
  r.fromCache = false;
  r.fetchedAt = fetchedAt;
  return r;
}

/* ── robots.txt ──
   Consulted for every URL this server works out for itself: the lookups a
   handler makes, the manifest URL a handler derives, the page a page scan
   reads and the links it then probes. A manifest the caller passes by its own
   URL, and the images that manifest points to, are a single user-directed
   fetch of a named document, the same thing a browser does, and are not
   gated. */
export function robotsEnabled(env) {
  return String(env && env.RESPECT_ROBOTS).toLowerCase() !== 'false';
}

function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  text.split(/\r?\n/).forEach(function (line) {
    const l = line.replace(/#.*$/, '').trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (!cur) return;
    if (key === 'disallow' || key === 'allow') cur.rules.push({ allow: key === 'allow', path: val });
  });
  return groups;
}

function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const re = new RegExp('^' + rulePath.split('*').map(function (s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('.*').replace(/\\\$$/, '$'));
  return re.test(path);
}

export async function robotsAllows(rawUrl) {
  const u = checkUrl(rawUrl);
  // On unless RESPECT_ROBOTS is exactly "false" (wrangler.jsonc vars).
  if (!robotsEnabled(ENV)) return true;
  let text = '';
  try {
    const r = await politeFetch(u.origin + '/robots.txt', { kind: 'page', ttl: TTL.robots });
    // RFC 9309: a server error means the rules are unknown, so assume
    // everything is disallowed; a missing file (4xx) means there are none.
    if (r.status >= 500) return false;
    if (r.ok && /text\/plain/i.test(r.headers.get('content-type') || '')) text = await r.text();
  } catch (e) {
    if (e instanceof ToolError && (e.code === 'rate_limited' || e.code === 'not_configured')) throw e;
    return false;
  }
  if (!text) return true;
  const groups = parseRobots(text);
  const mine = groups.filter(function (g) { return g.agents.indexOf(ROBOTS_TOKEN) !== -1; });
  const use = mine.length ? mine : groups.filter(function (g) { return g.agents.indexOf('*') !== -1; });
  const path = u.pathname + u.search;
  let best = null;
  use.forEach(function (g) {
    g.rules.forEach(function (rule) {
      if (!ruleMatches(rule.path, path)) return;
      // Longest match wins; Allow wins a tie.
      if (!best || rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.allow)) best = rule;
    });
  });
  return best ? best.allow : true;
}

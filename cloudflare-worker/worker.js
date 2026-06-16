/**
 * Kings of the North — Cloudflare Worker
 *
 * Acts as a caching proxy between the dashboard and api-football.com.
 * - Your API key lives here as an environment secret, never in the HTML.
 * - Responses are cached at the Cloudflare edge for 15 minutes.
 * - No matter how many league members load the dashboard, only ONE real
 *   request goes to api-football per 15-minute window per endpoint.
 * - CORS headers are set so the dashboard (on any domain) can call this Worker.
 *
 * Environment variables (set in Cloudflare dashboard, NOT here):
 *   API_FOOTBALL_KEY  — your api-football.com API key
 *
 * Deployed URL example:  https://kotn-proxy.YOUR-SUBDOMAIN.workers.dev
 *
 * Supported routes:
 *   GET /fixtures   → proxies /fixtures?league=1&season=2026
 *   GET /standings  → proxies /standings?league=1&season=2026
 *   GET /health     → returns {"ok":true} (useful for testing)
 */

const API_BASE   = 'https://v3.football.api-sports.io';
const LEAGUE     = 1;
const SEASON     = 2026;
const CACHE_TTL  = 60 * 30; // 30 minutes in seconds

// Allowed origins — add your GitHub Pages URL once you have it
// e.g. 'https://yourusername.github.io'
// Use '*' during development, then tighten to your actual domain.
const ALLOWED_ORIGIN = 'https://freddyreza53.github.io/';

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, ''); // strip trailing slash

    // ── CORS preflight ─────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ── Health check ───────────────────────────────────────────────────────
    if (pathname === '/health') {
      return corsResponse(JSON.stringify({ ok: true, ts: Date.now() }), 200);
    }

    // ── Route → API Football endpoint ──────────────────────────────────────
    let apiPath;
    if (pathname === '/fixtures') {
      apiPath = `/fixtures?league=${LEAGUE}&season=${SEASON}`;
    } else if (pathname === '/standings') {
      apiPath = `/standings?league=${LEAGUE}&season=${SEASON}`;
    } else {
      return corsResponse(JSON.stringify({ error: 'Unknown route. Use /fixtures or /standings.' }), 404);
    }

    // ── Check Cloudflare edge cache ────────────────────────────────────────
    const cache      = caches.default;
    // Use a stable cache key (Worker URL + path, ignoring any query params from caller)
    const cacheKey   = new Request(`https://kotn-cache.internal${pathname}`, { method: 'GET' });
    const cachedResp = await cache.match(cacheKey);

    if (cachedResp) {
      // Cache hit — clone and add a header so you can see it's cached
      const headers = new Headers(cachedResp.headers);
      headers.set('X-Cache', 'HIT');
      headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      return new Response(cachedResp.body, { status: cachedResp.status, headers });
    }

    // ── Cache miss — fetch from api-football ───────────────────────────────
    if (!env.API_FOOTBALL_KEY) {
      return corsResponse(JSON.stringify({ error: 'API_FOOTBALL_KEY secret not configured in Worker environment.' }), 500);
    }

    let apiResp;
    try {
      apiResp = await fetch(`${API_BASE}${apiPath}`, {
        headers: { 'x-apisports-key': env.API_FOOTBALL_KEY },
        cf: { cacheTtl: 0 }, // don't let Cloudflare's default CDN cache the outbound request
      });
    } catch (err) {
      return corsResponse(JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }), 502);
    }

    const body        = await apiResp.text();
    const status      = apiResp.ok ? 200 : apiResp.status;
    const respHeaders = new Headers({
      'Content-Type':                'application/json',
      'Cache-Control':               `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'X-Cache':                     'MISS',
    });

    const responseToCache = new Response(body, { status, headers: respHeaders });

    // Store in edge cache — ctx.waitUntil lets the cache write happen
    // after we've already returned the response to the user
    ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

    return new Response(body, { status, headers: respHeaders });
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
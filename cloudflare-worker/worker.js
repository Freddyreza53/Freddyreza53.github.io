/**
 * Kings of the North — Cloudflare Worker
 *
 * Caching proxy for worldcup26.ir — a free, open-source, no-auth-required
 * FIFA World Cup 2026 API (https://github.com/rezarahiminia/worldcup2026).
 *
 * No API key or secrets needed. The Worker's only job is to:
 *   1. Cache responses at the Cloudflare edge for 30 minutes
 *   2. Add CORS headers so the dashboard (GitHub Pages) can call it
 *   3. Act as a single fetch point so all 14 league members share one cache
 *
 * Supported routes:
 *   GET /games    → worldcup26.ir/get/games    (all 104 matches + scores)
 *   GET /health   → returns {"ok":true}
 *
 * Deploy:  wrangler deploy
 * No secrets needed — nothing to configure beyond deploying.
 */

const UPSTREAM   = 'https://worldcup26.ir';
const CACHE_TTL  = 60 * 30; // 30 minutes in seconds

// Lock down to your GitHub Pages URL once deployed, e.g.:
// 'https://yourusername.github.io'
// Use '*' during development.
const ALLOWED_ORIGIN = 'https://freddyreza53.github.io';

const ROUTES = {
  '/games':  '/get/games',
};

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // Health check — no upstream call needed
    if (pathname === '/health') {
      return corsResponse(JSON.stringify({ ok: true, ts: Date.now() }), 200);
    }

    // Validate route
    const upstreamPath = ROUTES[pathname];
    if (!upstreamPath) {
      return corsResponse(
        JSON.stringify({ error: `Unknown route "${pathname}". Valid routes: /games, /groups, /teams` }),
        404
      );
    }

    // Check Cloudflare edge cache
    const cache    = caches.default;
    const cacheKey = new Request(`https://kotn-cache.internal${pathname}`, { method: 'GET' });
    const cached   = await cache.match(cacheKey);

    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Cache', 'HIT');
      headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      return new Response(cached.body, { status: cached.status, headers });
    }

    // Cache miss — fetch from worldcup26.ir
    let upstream;
    try {
      upstream = await fetch(`${UPSTREAM}${upstreamPath}`, {
        headers: { 'Accept': 'application/json' },
        cf: { cacheTtl: 0 },
      });
    } catch (err) {
      return corsResponse(
        JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }),
        502
      );
    }

    const body   = await upstream.text();
    const status = upstream.ok ? 200 : upstream.status;

    const respHeaders = new Headers({
      'Content-Type':                  'application/json',
      'Cache-Control':                 `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods':  'GET, OPTIONS',
      'Access-Control-Allow-Headers':  'Content-Type',
      'X-Cache':                       'MISS',
    });

    const toCache = new Response(body, { status, headers: respHeaders });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

    return new Response(body, { status, headers: respHeaders });
  },
};

function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type':                  'application/json',
      'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods':  'GET, OPTIONS',
      'Access-Control-Allow-Headers':  'Content-Type',
    },
  });
}
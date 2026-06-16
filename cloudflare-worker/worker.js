/**
 * Kings of the North — Cloudflare Worker
 *
 * Caching proxy for worldcup26.ir — a free FIFA World Cup 2026 API
 * (https://github.com/rezarahiminia/worldcup2026).
 *
 * worldcup26.ir requires a Bearer token on requests. The token is stored
 * as a Worker secret (WORLDCUP26_TOKEN) — never exposed to the dashboard
 * or committed to the repo.
 *
 * The Worker's job is to:
 *   1. Attach the Authorization header server-side
 *   2. Cache responses at the Cloudflare edge for 30 minutes
 *   3. Add CORS headers so the dashboard (GitHub Pages) can call it
 *   4. Act as a single fetch point so all 14 league members share one cache
 *
 * Supported routes:
 *   GET /games    → worldcup26.ir/get/games    (all 104 matches + scores)
 *   GET /health   → returns {"ok":true}
 *
 * Deploy:
 *   wrangler deploy
 *   wrangler secret put WORLDCUP26_TOKEN
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
    const cacheKey = new Request(`https://kotn-cache-v2.internal${pathname}`, { method: 'GET' });
    const cached   = await cache.match(cacheKey);

    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Cache', 'HIT');
      headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      return new Response(cached.body, { status: cached.status, headers });
    }

    // Cache miss — fetch from worldcup26.ir
    if (!env.WORLDCUP26_TOKEN) {
      return corsResponse(JSON.stringify({ error: 'WORLDCUP26_TOKEN secret not configured in Worker environment.' }), 500);
    }

    let upstream;
    try {
      upstream = await fetch(`${UPSTREAM}${upstreamPath}`, {
        headers: {
          'Accept':        'application/json',
          'Authorization': `Bearer ${env.WORLDCUP26_TOKEN}`,
        },
        cf: { cacheTtl: 0 },
      });
    } catch (err) {
      // Network error — serve stale cache if available, otherwise error
      const stale = await cache.match(cacheKey);
      if (stale) {
        const headers = new Headers(stale.headers);
        headers.set('X-Cache', 'STALE');
        headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        return new Response(stale.body, { status: 200, headers });
      }
      return corsResponse(
        JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }),
        502
      );
    }

    // If upstream returned an error, serve stale cache rather than propagating the error
    if (!upstream.ok) {
      const stale = await cache.match(cacheKey);
      if (stale) {
        const headers = new Headers(stale.headers);
        headers.set('X-Cache', 'STALE');
        headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        return new Response(stale.body, { status: 200, headers });
      }
      // No stale cache available — return the upstream error as-is
      return corsResponse(
        JSON.stringify({ error: `Upstream error ${upstream.status}`, detail: upstreamPath }),
        502
      );
    }

    const body   = await upstream.text();
    const status = 200;
    const fetchedAt = Date.now();

    const respHeaders = new Headers({
      'Content-Type':                  'application/json',
      'Cache-Control':                 `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods':  'GET, OPTIONS',
      'Access-Control-Allow-Headers':  'Content-Type',
      'X-Cache':                       'MISS',
      'X-Fetched-At':                  String(fetchedAt),
    });

    // Store the cache entry with the SAME TTL we actually want (30 min).
    // Cloudflare's Cache API treats Cache-Control max-age as the freshness
    // window — storing 86400 here was the bug: it told Cloudflare to treat
    // this response as fresh for 24 hours, so cache.match() kept returning
    // it long after newer match data existed upstream.
    const toCache = new Response(body, {
      status,
      headers: new Headers({
        ...Object.fromEntries(respHeaders),
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      }),
    });
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
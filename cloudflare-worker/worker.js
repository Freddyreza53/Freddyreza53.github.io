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
 * worldcup26.ir is occasionally flaky and returns intermittent 500s. To
 * absorb that, the Worker keeps TWO cache entries per route:
 *   - Primary cache  (1 min)  — normal freshness window
 *   - Fallback cache (6 hrs)  — refreshed on every successful fetch,
 *                               only ever READ when upstream fails
 * This means a single bad upstream response never surfaces as an error
 * to the dashboard as long as we've had at least one successful fetch
 * in the last 6 hours.
 *
 * The Worker's job is to:
 *   1. Attach the Authorization header server-side
 *   2. Cache responses at the Cloudflare edge for 1 minute (+ 6hr fallback)
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

const UPSTREAM      = 'https://worldcup26.ir';
const CACHE_TTL     = 60;          // 1 minute — primary cache freshness
const FALLBACK_TTL  = 60 * 60 * 6; // 6 hours — durable insurance copy, only used when upstream fails

// Lock down to your GitHub Pages URL once deployed, e.g.:
// 'https://yourusername.github.io'
// Use '*' during development.
const ALLOWED_ORIGIN = 'https://freddyreza53.github.io';

const ROUTES = {
  '/games':  '/get/games',
};

// Structured logging helper — every log line is tagged "[KOTN]" so you can
// filter for it easily in the Cloudflare dashboard's Logs/Tail view.
// The "result" field is the thing you'll want to search/filter on:
//   CACHE_HIT | CACHE_MISS_FETCH_OK | STALE_FALLBACK_ERROR |
//   STALE_FALLBACK_NETWORK_ERROR | NO_FALLBACK_AVAILABLE | MISSING_TOKEN
function logEvent(result, pathname, extra = {}) {
  console.log(JSON.stringify({
    tag: '[KOTN]',
    result,
    route: pathname,
    ts: new Date().toISOString(),
    ...extra,
  }));
}

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

    // Check Cloudflare edge cache (primary, 1-minute freshness)
    const cache       = caches.default;
    const cacheKey    = new Request(`https://kotn-cache.internal${pathname}`, { method: 'GET' });
    // Fallback cache key — same data, but stored with a long TTL purely as an
    // insurance copy for when upstream is having a bad moment. Only read on
    // failure, only written on success.
    const fallbackKey = new Request(`https://kotn-cache-fallback.internal${pathname}`, { method: 'GET' });

    const cached = await cache.match(cacheKey);

    if (cached) {
      logEvent('CACHE_HIT', pathname);
      const headers = new Headers(cached.headers);
      headers.set('X-Cache', 'HIT');
      headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
      return new Response(cached.body, { status: cached.status, headers });
    }

    // Cache miss — fetch from worldcup26.ir
    if (!env.WORLDCUP26_TOKEN) {
      logEvent('MISSING_TOKEN', pathname);
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
      // Network error — serve the durable fallback copy if we have one
      const fallback = await cache.match(fallbackKey);
      if (fallback) {
        logEvent('STALE_FALLBACK_NETWORK_ERROR', pathname, { error: err.message });
        const headers = new Headers(fallback.headers);
        headers.set('X-Cache', 'STALE-FALLBACK');
        headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        return new Response(fallback.body, { status: 200, headers });
      }
      logEvent('NO_FALLBACK_AVAILABLE', pathname, { error: err.message, cause: 'network' });
      return corsResponse(
        JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }),
        502
      );
    }

    // If upstream returned an error, serve the durable fallback copy instead
    if (!upstream.ok) {
      const fallback = await cache.match(fallbackKey);
      if (fallback) {
        logEvent('STALE_FALLBACK_ERROR', pathname, { upstreamStatus: upstream.status });
        const headers = new Headers(fallback.headers);
        headers.set('X-Cache', 'STALE-FALLBACK');
        headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        return new Response(fallback.body, { status: 200, headers });
      }
      // No fallback available either (e.g. very first request ever) — return the error
      logEvent('NO_FALLBACK_AVAILABLE', pathname, { upstreamStatus: upstream.status, cause: 'upstream_error' });
      return corsResponse(
        JSON.stringify({ error: `Upstream error ${upstream.status}`, detail: upstreamPath }),
        502
      );
    }

    const body   = await upstream.text();
    const status = 200;
    const fetchedAt = Date.now();

    logEvent('CACHE_MISS_FETCH_OK', pathname, { upstreamStatus: upstream.status, bodyBytes: body.length });

    const respHeaders = new Headers({
      'Content-Type':                  'application/json',
      'Cache-Control':                 `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods':  'GET, OPTIONS',
      'Access-Control-Allow-Headers':  'Content-Type',
      'X-Cache':                       'MISS',
      'X-Fetched-At':                  String(fetchedAt),
    });

    // Store the primary cache entry with the real 1-minute freshness window
    const toCache = new Response(body, {
      status,
      headers: new Headers({
        ...Object.fromEntries(respHeaders),
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      }),
    });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

    // Also refresh the durable fallback copy (long TTL, only used on failure)
    const toFallback = new Response(body, {
      status,
      headers: new Headers({
        ...Object.fromEntries(respHeaders),
        'Cache-Control': `public, max-age=${FALLBACK_TTL}`,
      }),
    });
    ctx.waitUntil(cache.put(fallbackKey, toFallback.clone()));

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
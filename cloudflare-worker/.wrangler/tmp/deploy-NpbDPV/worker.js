var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var UPSTREAM = "https://worldcup26.ir";
var CACHE_TTL = 60;
var ALLOWED_ORIGIN = "https://freddyreza53.github.io";
var ROUTES = {
  "/games": "/get/games"
};
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "");
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }
    if (pathname === "/health") {
      return corsResponse(JSON.stringify({ ok: true, ts: Date.now() }), 200);
    }
    const upstreamPath = ROUTES[pathname];
    if (!upstreamPath) {
      return corsResponse(
        JSON.stringify({ error: `Unknown route "${pathname}". Valid routes: /games, /groups, /teams` }),
        404
      );
    }
    const cache = caches.default;
    const cacheKey = new Request(`https://kotn-cache-v2.internal${pathname}`, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-Cache", "HIT");
      headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      return new Response(cached.body, { status: cached.status, headers });
    }
    if (!env.WORLDCUP26_TOKEN) {
      return corsResponse(JSON.stringify({ error: "WORLDCUP26_TOKEN secret not configured in Worker environment." }), 500);
    }
    let upstream;
    try {
      upstream = await fetch(`${UPSTREAM}${upstreamPath}`, {
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${env.WORLDCUP26_TOKEN}`
        },
        cf: { cacheTtl: 0 }
      });
    } catch (err) {
      const stale = await cache.match(cacheKey);
      if (stale) {
        const headers = new Headers(stale.headers);
        headers.set("X-Cache", "STALE");
        headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
        return new Response(stale.body, { status: 200, headers });
      }
      return corsResponse(
        JSON.stringify({ error: "Upstream fetch failed", detail: err.message }),
        502
      );
    }
    if (!upstream.ok) {
      const stale = await cache.match(cacheKey);
      if (stale) {
        const headers = new Headers(stale.headers);
        headers.set("X-Cache", "STALE");
        headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
        return new Response(stale.body, { status: 200, headers });
      }
      return corsResponse(
        JSON.stringify({ error: `Upstream error ${upstream.status}`, detail: upstreamPath }),
        502
      );
    }
    const body = await upstream.text();
    const status = 200;
    const fetchedAt = Date.now();
    const respHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "X-Cache": "MISS",
      "X-Fetched-At": String(fetchedAt)
    });
    const toCache = new Response(body, {
      status,
      headers: new Headers({
        ...Object.fromEntries(respHeaders),
        "Cache-Control": `public, max-age=${CACHE_TTL}`
      })
    });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    return new Response(body, { status, headers: respHeaders });
  }
};
function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(corsResponse, "corsResponse");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map

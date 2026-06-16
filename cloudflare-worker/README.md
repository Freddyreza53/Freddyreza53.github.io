# Kings of the North — Cloudflare Worker Setup

This Worker is a **caching proxy** between your dashboard and worldcup26.ir,
a free open-source FIFA World Cup 2026 API with no authentication required.

**No API keys. No secrets. Nothing to configure except deploying.**

The Worker's only jobs are:
1. Cache API responses at the Cloudflare edge for 30 minutes
2. Add CORS headers so the GitHub Pages dashboard can call it
3. Be the single fetch point so all 14 league members share one cache

---

## What you need

- A free Cloudflare account → https://dash.cloudflare.com/sign-up
- Node.js installed (to run Wrangler, Cloudflare's CLI)

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
```

---

## Step 2 — Log in to Cloudflare

```bash
wrangler login
```

This opens a browser window. Authorize Wrangler with your Cloudflare account.

---

## Step 3 — Deploy the Worker

From inside this `cloudflare-worker/` folder:

```bash
wrangler deploy
```

After a few seconds you'll see a URL like:

```
https://kotn-proxy.YOUR-SUBDOMAIN.workers.dev
```

That's it. No secrets to add. The Worker is live.

---

## Step 4 — Update index.html

Open `index.html` and find this line near the top of the `<script>` block:

```js
const WORKER_URL = 'REPLACE_WITH_YOUR_WORKER_URL';
```

Replace it with your Worker URL from Step 3:

```js
const WORKER_URL = 'https://kotn-proxy.YOUR-SUBDOMAIN.workers.dev';
```

Save and push to GitHub. Done.

---

## Step 5 (Optional but recommended) — Lock down CORS

Once your GitHub Pages site is live, open `worker.js` and change:

```js
const ALLOWED_ORIGIN = '*';
```

to your actual Pages URL:

```js
const ALLOWED_ORIGIN = 'https://yourusername.github.io';
```

Then redeploy:

```bash
wrangler deploy
```

This ensures only your dashboard can use the Worker.

---

## Testing the Worker

```bash
# Health check
curl https://kotn-proxy.kingsofthenorth.workers.dev/health

# All 104 matches + scores
curl https://kotn-proxy.kingsofthenorth.workers.dev/games

# Group standings
curl https://kotn-proxy.kingsofthenorth.workers.dev/groups
```

Check the `X-Cache` response header:
- `X-Cache: MISS`  → fresh fetch from worldcup26.ir (first request in 30-min window)
- `X-Cache: HIT`   → served from Cloudflare edge cache (everyone else hits this)

---

## How caching works

1. First person opens the dashboard → Worker fetches from worldcup26.ir, caches for 30 min
2. All 13 other league members → served instantly from Cloudflare cache, zero upstream calls
3. After 30 minutes → next visitor triggers a fresh fetch, cycle repeats
4. Total upstream requests: 2 per 30-min window (games + groups) = ~96/day max

worldcup26.ir is free with no rate limits, so there's no quota to worry about.
The caching is just good practice to keep the dashboard fast and the upstream happy.

---

## Folder structure

```
cloudflare-worker/
  worker.js       ← The Worker code (deploy this)
  wrangler.toml   ← Wrangler config
  README.md       ← This file

index.html        ← Dashboard (point WORKER_URL to your deployed Worker)
.github/
  workflows/
    deploy.yml    ← Auto-deploys index.html to GitHub Pages on push
```
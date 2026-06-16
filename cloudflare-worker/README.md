# Kings of the North — Cloudflare Worker Setup

This Worker acts as a secure caching proxy between your dashboard and api-football.com.
Your API key lives here as an encrypted secret — it is never exposed in the HTML.
All 14 league members share one cached response, so only 2 real API requests
go out every 15 minutes regardless of how many people have the dashboard open.

---

## What you need

- A free Cloudflare account → https://dash.cloudflare.com/sign-up
- Node.js installed (to run Wrangler, Cloudflare's CLI)
- Your api-football.com API key

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

Wrangler reads `wrangler.toml` and deploys `worker.js`.
After a few seconds you'll see a URL like:

```
https://kotn-proxy.YOUR-SUBDOMAIN.workers.dev
```

Copy that URL — you'll need it in Step 5.

---

## Step 4 — Add your API key as a secret

```bash
wrangler secret put API_FOOTBALL_KEY
```

Wrangler will prompt you to paste your api-football.com key.
It's stored encrypted in Cloudflare — never visible in your code or logs.

---

## Step 5 — Update index.html

Open `index.html` and find this line near the top of the `<script>` block:

```js
const WORKER_URL = 'REPLACE_WITH_YOUR_WORKER_URL';
```

Replace the placeholder with your Worker URL from Step 3:

```js
const WORKER_URL = 'https://kotn-proxy.YOUR-SUBDOMAIN.workers.dev';
```

Save and push to GitHub. The dashboard will now route all API calls
through the Worker instead of hitting api-football directly.

---

## Step 6 (Optional but recommended) — Lock down CORS

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

You can test it directly in your browser or with curl:

```bash
# Health check
curl https://kotn-proxy.kingsofthenorth.workers.dev/health

# Fixtures (should return World Cup match data)
curl https://kotn-proxy.kingsofthenorth.workers.dev/fixtures

# Standings
curl https://kotn-proxy.kingsofthenorth.workers.dev/standings
```

Check the `X-Cache` response header:
- `X-Cache: MISS`  → fresh fetch from api-football (counts against quota)
- `X-Cache: HIT`   → served from Cloudflare edge cache (free, instant)

---

## How caching works

1. First person opens the dashboard → Worker fetches from api-football, caches result for 15 min
2. Everyone else who opens it in that 15-min window → served instantly from Cloudflare cache
3. After 15 minutes → next visitor triggers a fresh fetch, cycle repeats
4. Total api-football requests: max 2 per 15-min window (fixtures + standings), = ~192/day max

Free tier limit: 100 requests/day on api-football → upgrade to their $10/mo starter plan,
which gives 7,500 requests/day. With the Worker caching, 192/day is all you'll ever use.

---

## Folder structure

```
cloudflare-worker/
  worker.js       ← The Worker code (deploy this)
  wrangler.toml   ← Wrangler config (name, compatibility date)
  README.md       ← This file

index.html        ← Your dashboard (points to the Worker URL)
.github/
  workflows/
    deploy.yml    ← Auto-deploys index.html to GitHub Pages on push
```

# gsc-mcp — Google Search Console connector for Claude

A small self-hosted MCP server that exposes Search Console to Claude as a **custom connector**. Runs on any Node host behind your own domain (e.g. `https://gsc.grobern.com`).

Tools it exposes:

| Tool | What it does |
|---|---|
| `list_sites` | Properties the service account can see |
| `search_analytics` | Clicks / impressions / CTR / position by query, page, country, device, date |
| `list_sitemaps` | Submitted sitemaps with errors/warnings |
| `inspect_url` | URL Inspection API for one URL (index verdict, coverage state, canonical, robots, last crawl) |
| `audit_indexing` | Inspect a list of URLs or an entire sitemap and group them by coverage state — the closest thing to the "Page indexing" report the API allows |

> Google does not expose the Page Indexing report itself through the API. `audit_indexing` rebuilds it by inspecting each URL (2,000 inspections per property per day, 600/min).

---

## 1. Google side (once, ~10 min)

1. Google Cloud Console → create/select a project → **APIs & Services → Library** → enable **Google Search Console API**.
2. **IAM & Admin → Service Accounts → Create service account** (any name, no roles needed).
3. Open it → **Keys → Add key → JSON**. Download the file. Keep it private.
4. In **Search Console → property → Settings → Users and permissions → Add user**, paste the service account's email (`…@…iam.gserviceaccount.com`) with **Full** permission (Full is required for URL Inspection). Do this for every property you want Claude to see.

For thesurferweligama.com the property is most likely `sc-domain:thesurferweligama.com` (Domain property) or `https://thesurferweligama.com/` (URL-prefix). `list_sites` will tell you.

## 2. Run it

```bash
cp .env.example .env         # fill in MCP_SECRET and GOOGLE_SERVICE_ACCOUNT_JSON
npm install
npm run build
npm start                    # http://localhost:3000/mcp/<MCP_SECRET>
```

Generate a secret with `openssl rand -hex 24`.
`GOOGLE_SERVICE_ACCOUNT_JSON` accepts the raw JSON on one line, or `base64 -w0 key.json` output if your host mangles newlines.

Health check: `GET /health` → `{"ok":true}`.

## 3. Put it on your domain

Any of these work; the server is stateless so it scales horizontally and needs no sticky sessions.

**Docker / VPS (Coolify, Dokploy, plain docker):**
```bash
docker build -t gsc-mcp .
docker run -d --env-file .env -p 3000:3000 gsc-mcp
```
Point `gsc.yourdomain.com` at it with an HTTPS reverse proxy (Caddy: `gsc.yourdomain.com { reverse_proxy localhost:3000 }`).

**Railway / Render / Fly:** deploy the repo, set the three env vars, attach a custom domain in the dashboard, done.

**Vercel:** the app uses a long-lived Express listener, so Vercel serverless is not a drop-in. Use one of the above, or ask Claude to port the two files into a Next.js route handler with `mcp-handler`.

## 4. Add it to Claude

Claude.ai → **Settings → Connectors → Add custom connector**

- Name: `Google Search Console`
- URL: `https://gsc.yourdomain.com/mcp/<MCP_SECRET>`
- Authentication: none (the secret in the path is the credential — treat the URL like a password)

Then enable it in the chat and ask, for example:

> Audit page indexing for thesurferweligama.com using the sitemap at https://thesurferweligama.com/sitemap.xml

## Security notes

- Anyone with the full URL can read your Search Console data. Rotate `MCP_SECRET` if it leaks; the server 404s on any other path.
- The service account only has the Search Console scope; it cannot touch anything else in your Google account.
- Read-only by design: no tool submits sitemaps, requests indexing or changes settings.

## Development

```bash
npm run dev   # tsx watch, hot reload
```

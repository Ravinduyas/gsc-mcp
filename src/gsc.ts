import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/webmasters"];

function loadCredentials(): Record<string, unknown> | undefined {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    // Accept either raw JSON or base64-encoded JSON (handy for hosts that mangle newlines).
    const text = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(text);
  }
  return undefined; // fall back to GOOGLE_APPLICATION_CREDENTIALS / ADC
}

const auth = new google.auth.GoogleAuth({
  credentials: loadCredentials(),
  scopes: SCOPES,
});

export const searchconsole = google.searchconsole({ version: "v1", auth });

export function resolveSite(siteUrl?: string): string {
  const site = siteUrl || process.env.DEFAULT_SITE;
  if (!site) {
    throw new Error(
      "siteUrl is required (e.g. 'sc-domain:example.com' or 'https://www.example.com/'). " +
        "Call list_sites to see what this service account can access, or set DEFAULT_SITE."
    );
  }
  return site;
}

export async function listSites() {
  const res = await searchconsole.sites.list();
  return res.data.siteEntry ?? [];
}

export async function listSitemaps(siteUrl: string) {
  const res = await searchconsole.sitemaps.list({ siteUrl });
  return res.data.sitemap ?? [];
}

export interface SearchAnalyticsArgs {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dimensionFilterGroups?: unknown[];
}

export async function searchAnalytics(a: SearchAnalyticsArgs) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl: a.siteUrl,
    requestBody: {
      startDate: a.startDate,
      endDate: a.endDate,
      dimensions: a.dimensions ?? ["query"],
      rowLimit: a.rowLimit ?? 100,
      startRow: a.startRow ?? 0,
      type: a.type,
      dimensionFilterGroups: a.dimensionFilterGroups as any,
    },
  });
  return res.data;
}

export async function inspectUrl(siteUrl: string, inspectionUrl: string) {
  const res = await searchconsole.urlInspection.index.inspect({
    requestBody: { siteUrl, inspectionUrl, languageCode: "en-US" },
  });
  return res.data.inspectionResult ?? {};
}

/** Fetch a sitemap (or sitemap index) and return all page URLs it lists. */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  depth = 0,
  seen = new Set<string>()
): Promise<string[]> {
  if (depth > 3 || seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);
  const res = await fetch(sitemapUrl, {
    headers: { "user-agent": "gsc-mcp/1.0 (+indexing audit)" },
  });
  if (!res.ok) throw new Error(`Sitemap ${sitemapUrl} returned HTTP ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    m[1].trim()
  );
  if (/<sitemapindex/i.test(xml)) {
    const nested = await Promise.all(
      locs.map((u) => fetchSitemapUrls(u, depth + 1, seen))
    );
    return nested.flat();
  }
  return locs;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

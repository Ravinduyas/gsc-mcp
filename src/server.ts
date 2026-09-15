import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  fetchSitemapUrls,
  inspectUrl,
  listSitemaps,
  listSites,
  mapLimit,
  resolveSite,
  searchAnalytics,
} from "./gsc.js";

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.MCP_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("MCP_SECRET must be set to a random string of at least 16 characters.");
  process.exit(1);
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (err: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: err instanceof Error ? err.message : String(err),
    },
  ],
});

const siteParam = z
  .string()
  .optional()
  .describe(
    "Search Console property, e.g. 'sc-domain:example.com' (Domain property) or 'https://www.example.com/' (URL-prefix). Omit to use DEFAULT_SITE."
  );

function buildServer(): McpServer {
  const server = new McpServer({ name: "google-search-console", version: "1.0.0" });

  server.registerTool(
    "list_sites",
    {
      title: "List Search Console properties",
      description:
        "List every Search Console property the connected service account can access, with its permission level.",
      inputSchema: {},
    },
    async () => {
      try {
        return json(await listSites());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_analytics",
    {
      title: "Search performance report",
      description:
        "Query Search Console performance data (clicks, impressions, CTR, position). Dimensions: query, page, country, device, date, searchAppearance. Dates are YYYY-MM-DD; data lags ~2-3 days.",
      inputSchema: {
        siteUrl: siteParam,
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dimensions: z
          .array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"]))
          .optional()
          .describe("Defaults to ['query']"),
        rowLimit: z.number().int().min(1).max(25000).optional(),
        startRow: z.number().int().min(0).optional(),
        type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional(),
        dimensionFilterGroups: z
          .array(z.any())
          .optional()
          .describe(
            "Raw Search Console filter groups, e.g. [{filters:[{dimension:'page',operator:'contains',expression:'/surf-camp'}]}]"
          ),
      },
    },
    async (args) => {
      try {
        return json(await searchAnalytics({ ...args, siteUrl: resolveSite(args.siteUrl) }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_sitemaps",
    {
      title: "List submitted sitemaps",
      description:
        "List sitemaps submitted for a property, with last-download time, errors, warnings and URL counts.",
      inputSchema: { siteUrl: siteParam },
    },
    async ({ siteUrl }) => {
      try {
        return json(await listSitemaps(resolveSite(siteUrl)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "inspect_url",
    {
      title: "Inspect a URL's index status",
      description:
        "Run the URL Inspection API for one URL: index verdict, coverage state (e.g. 'Crawled - currently not indexed'), robots.txt state, canonical chosen by Google vs. declared, last crawl time, mobile usability and rich result issues. Quota: 2,000 inspections per property per day.",
      inputSchema: {
        url: z.string().url().describe("Full URL to inspect; must belong to the property."),
        siteUrl: siteParam,
      },
    },
    async ({ url, siteUrl }) => {
      try {
        return json(await inspectUrl(resolveSite(siteUrl), url));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "audit_indexing",
    {
      title: "Audit page indexing issues",
      description:
        "Inspect many URLs at once and group them by Google's coverage state, surfacing indexing problems (not indexed, canonical mismatch, robots blocked, 404/soft-404, redirect, noindex). Supply explicit urls, or a sitemapUrl to inspect every URL it lists (sitemap indexes are expanded). Each URL costs one inspection against the 2,000/day quota, so use `limit`.",
      inputSchema: {
        siteUrl: siteParam,
        urls: z.array(z.string().url()).optional(),
        sitemapUrl: z.string().url().optional(),
        limit: z.number().int().min(1).max(500).default(100),
        onlyProblems: z
          .boolean()
          .default(true)
          .describe("If true, per-URL rows are returned only for URLs that are NOT cleanly indexed."),
      },
    },
    async ({ siteUrl, urls, sitemapUrl, limit, onlyProblems }) => {
      try {
        const site = resolveSite(siteUrl);
        let targets = urls ?? [];
        if (sitemapUrl) targets = targets.concat(await fetchSitemapUrls(sitemapUrl));
        targets = [...new Set(targets)];
        if (targets.length === 0) throw new Error("Provide urls or a sitemapUrl.");
        const truncated = targets.length > limit;
        targets = targets.slice(0, limit);

        const rows = await mapLimit(targets, 4, async (url) => {
          try {
            const r: any = await inspectUrl(site, url);
            const idx = r.indexStatusResult ?? {};
            const declared = idx.userCanonical;
            const chosen = idx.googleCanonical;
            const problems: string[] = [];
            if (idx.verdict && idx.verdict !== "PASS") problems.push(`verdict: ${idx.verdict}`);
            if (idx.coverageState && !/^Submitted and indexed$/i.test(idx.coverageState)
                && !/^Indexed, not submitted in sitemap$/i.test(idx.coverageState))
              problems.push(`coverage: ${idx.coverageState}`);
            if (idx.robotsTxtState && idx.robotsTxtState !== "ALLOWED")
              problems.push(`robots.txt: ${idx.robotsTxtState}`);
            if (idx.indexingState && idx.indexingState !== "INDEXING_ALLOWED")
              problems.push(`indexing: ${idx.indexingState}`);
            if (idx.pageFetchState && idx.pageFetchState !== "SUCCESSFUL")
              problems.push(`fetch: ${idx.pageFetchState}`);
            if (chosen && declared && chosen !== declared)
              problems.push(`canonical mismatch: google=${chosen} declared=${declared}`);
            if (chosen && chosen !== url && (!declared || declared === url))
              problems.push(`google chose different canonical: ${chosen}`);
            return {
              url,
              coverageState: idx.coverageState ?? "UNKNOWN",
              verdict: idx.verdict,
              lastCrawlTime: idx.lastCrawlTime,
              googleCanonical: chosen,
              userCanonical: declared,
              robotsTxtState: idx.robotsTxtState,
              indexingState: idx.indexingState,
              pageFetchState: idx.pageFetchState,
              crawledAs: idx.crawledAs,
              problems,
            };
          } catch (e) {
            return {
              url,
              coverageState: "ERROR",
              problems: [e instanceof Error ? e.message : String(e)],
            } as any;
          }
        });

        const byState: Record<string, number> = {};
        for (const r of rows) byState[r.coverageState] = (byState[r.coverageState] ?? 0) + 1;
        const problemRows = rows.filter((r) => r.problems.length > 0);

        return json({
          site,
          inspected: rows.length,
          truncatedToLimit: truncated,
          summaryByCoverageState: byState,
          problemCount: problemRows.length,
          rows: onlyProblems ? problemRows : rows,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const guard: express.RequestHandler = (req, res, next) => {
  if (req.params.secret !== SECRET) {
    res.status(404).end();
    return;
  }
  next();
};

// Stateless Streamable HTTP: a fresh server+transport per request.
app.post("/mcp/:secret", guard, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

for (const method of ["get", "delete"] as const) {
  app[method]("/mcp/:secret", guard, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  });
}

app.listen(PORT, () => {
  console.log(`GSC MCP connector listening on :${PORT}  (POST /mcp/<secret>)`);
});

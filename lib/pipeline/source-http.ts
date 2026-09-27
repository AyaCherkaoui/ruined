import { archiveRaw } from "./cms-snapshots";

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

/** Public CMS requests only; credentials, cookies, and response headers are never archived. */
export async function fetchCmsPage(url: string, page: number, root: string, options: HttpOptions = {}): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "data.cms.gov" || parsed.username || parsed.password) throw new Error("Expected a public CMS URL");
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await send(url, { signal: AbortSignal.timeout(30_000), redirect: "error" }); }
    catch { if (attempt >= retries) throw new Error("CMS network request failed"); await sleep(500 * 2 ** attempt); continue; }
    const body = await response.text();
    await archiveRaw(root, body, { source: parsed.pathname + parsed.search, page, status: response.status, capturedAt: new Date().toISOString() });
    if (response.ok) return JSON.parse(body);
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Math.min(30_000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
      continue;
    }
    throw new Error(`CMS HTTP ${response.status}`);
  }
}

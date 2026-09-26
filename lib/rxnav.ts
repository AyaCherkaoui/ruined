// Minimal client for the public NLM RxNav / RxClass REST APIs (no key needed).
// https://lhncbc.nlm.nih.gov/RxNav/APIs/  -- NLM asks for <= 20 requests/second/IP.

const DEFAULT_BASE = "https://rxnav.nlm.nih.gov/REST";

export interface RxConcept {
  rxcui: string;
  name: string;
  tty: string;
}

export interface AtcClass {
  classId: string;
  className: string;
  classType: string;
  /** The concept RxClass attached this class to (an ingredient, or a multi-ingredient MIN). */
  viaRxcui: string;
  viaTty: string;
}

export interface RxRelated {
  ingredients: RxConcept[]; // tty IN
  multiIngredient: RxConcept[]; // tty MIN
  doseFormGroups: string[];
  genericDrugs: RxConcept[]; // tty SCD (for a brand SBD: the clinical drug it is a tradename of)
}

export interface RxNavOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Minimum gap between request starts. 80ms ~ 12 req/s, comfortably under NLM's 20/s. */
  minIntervalMs?: number;
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RxNavClient {
  private fetchFn: typeof fetch;
  private baseUrl: string;
  private minIntervalMs: number;
  private maxRetries: number;
  private nextSlot = 0;
  requestCount = 0;

  constructor(opts: RxNavOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.minIntervalMs = opts.minIntervalMs ?? 80;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  private async throttle() {
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    if (start > now) await sleep(start - now);
  }

  private async getJson<T>(pathAndQuery: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();
      this.requestCount++;
      try {
        const res = await this.fetchFn(`${this.baseUrl}${pathAndQuery}`, {
          headers: { Accept: "application/json" },
        });
        if (res.ok) return (await res.json()) as T;
        if (res.status !== 429 && res.status < 500) {
          throw new Error(`RxNav ${res.status} for ${pathAndQuery}`);
        }
        lastErr = new Error(`RxNav ${res.status} for ${pathAndQuery}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("RxNav 4")) throw err;
        lastErr = err;
      }
      await sleep(500 * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Exact / normalized name match. search=2 = exact first, then normalized. */
  async findRxcuiByName(name: string): Promise<string[]> {
    const d = await this.getJson<{ idGroup?: { rxnormId?: string[] } }>(
      `/rxcui.json?name=${encodeURIComponent(name)}&search=2`,
    );
    return d.idGroup?.rxnormId ?? [];
  }

  /** Fuzzy match for misspellings / partial names. Deduped by rxcui, best score first. */
  async approximateTerm(term: string, maxEntries = 10): Promise<{ rxcui: string; score: number; name?: string }[]> {
    const d = await this.getJson<{
      approximateGroup?: { candidate?: { rxcui: string; score: string; name?: string }[] };
    }>(`/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=${maxEntries}`);
    const seen = new Map<string, { rxcui: string; score: number; name?: string }>();
    for (const c of d.approximateGroup?.candidate ?? []) {
      const score = Number(c.score);
      const prev = seen.get(c.rxcui);
      if (!prev) seen.set(c.rxcui, { rxcui: c.rxcui, score, name: c.name });
      else if (!prev.name && c.name) prev.name = c.name;
    }
    return [...seen.values()].sort((a, b) => b.score - a.score);
  }

  async getConcept(rxcui: string): Promise<RxConcept | null> {
    const d = await this.getJson<{ properties?: { rxcui: string; name: string; tty: string } }>(
      `/rxcui/${encodeURIComponent(rxcui)}/properties.json`,
    );
    const p = d.properties;
    return p && p.rxcui ? { rxcui: p.rxcui, name: p.name, tty: p.tty } : null;
  }

  async getRelated(rxcui: string): Promise<RxRelated> {
    const d = await this.getJson<{
      relatedGroup?: { conceptGroup?: { tty: string; conceptProperties?: RxConcept[] }[] };
    }>(`/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN+MIN+DFG+SCD`);
    const groups = d.relatedGroup?.conceptGroup ?? [];
    const of = (tty: string): RxConcept[] =>
      (groups.find((g) => g.tty === tty)?.conceptProperties ?? []).map((c) => ({
        rxcui: c.rxcui,
        name: c.name,
        tty: c.tty,
      }));
    return {
      ingredients: of("IN"),
      multiIngredient: of("MIN"),
      doseFormGroups: of("DFG").map((c) => c.name),
      genericDrugs: of("SCD"),
    };
  }

  /** WHO ATC classes (levels 1-4) that RxClass attaches to this drug's ingredients. */
  async getAtcClasses(rxcui: string): Promise<AtcClass[]> {
    const d = await this.getJson<{
      rxclassDrugInfoList?: {
        rxclassDrugInfo?: {
          minConcept: { rxcui: string; tty: string };
          rxclassMinConceptItem: { classId: string; className: string; classType: string };
        }[];
      };
    }>(`/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}&relaSource=ATC`);
    return (d.rxclassDrugInfoList?.rxclassDrugInfo ?? []).map((i) => ({
      classId: i.rxclassMinConceptItem.classId,
      className: i.rxclassMinConceptItem.className,
      classType: i.rxclassMinConceptItem.classType,
      viaRxcui: i.minConcept.rxcui,
      viaTty: i.minConcept.tty,
    }));
  }
}

const ATC_LEVEL_4 = /^[A-Z]\d{2}[A-Z]{2}$/; // e.g. C10AA = HMG CoA reductase inhibitors

/**
 * Pick the single "same class" label we use for finding alternatives: the ATC level-4
 * class of the drug's ingredient. Deterministic: lowest class id wins if there are several.
 *  - single-ingredient drug: classes attached to the ingredient (ignore combos that RxClass mixes in)
 *  - combination drug: only a class attached to the combination itself (MIN); otherwise none,
 *    because the classes of the individual ingredients say nothing about the combination.
 */
export function pickPrimaryClass(classes: AtcClass[], ingredients: RxConcept[]): AtcClass | null {
  const level4 = classes.filter((c) => ATC_LEVEL_4.test(c.classId));
  const pool = ingredients.length <= 1 ? level4.filter((c) => c.viaTty !== "MIN") : level4.filter((c) => c.viaTty === "MIN");
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => a.classId.localeCompare(b.classId))[0];
}

/**
 * SEC EDGAR client — company filings + insider activity. NO API KEY required;
 * the SEC only asks for a descriptive User-Agent with a contact email and a
 * 10 req/sec ceiling. This is the OSINT backbone: 10-K/10-Q/8-K filings and
 * Form 4 insider transactions, straight from the source.
 *
 * Endpoints:
 *   - ticker→CIK map: https://www.sec.gov/files/company_tickers.json
 *   - submissions:     https://data.sec.gov/submissions/CIK{cik10}.json
 */

const SEC_UA = process.env.SEC_EDGAR_UA || 'TheDesk/1.0 (chickenwow66@gmail.com)';
const HEADERS = { 'User-Agent': SEC_UA, Accept: 'application/json' };

export interface Filing {
  form: string;
  filingDate: string;
  reportDate?: string;
  accessionNumber: string;
  primaryDocument: string;
  description?: string;
  url: string;
}

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

let cikCache: Map<string, { cik: string; name: string }> | null = null;

async function secFetch(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`SEC EDGAR ${res.status} for ${url}`);
  return res.json();
}

/** Resolve a ticker to its zero-padded 10-digit CIK + company name (cached). */
export async function resolveCik(ticker: string): Promise<{ cik: string; name: string }> {
  const sym = ticker.trim().toUpperCase();
  if (!cikCache) {
    const data = (await secFetch('https://www.sec.gov/files/company_tickers.json')) as Record<string, TickerEntry>;
    cikCache = new Map();
    for (const entry of Object.values(data)) {
      cikCache.set(entry.ticker.toUpperCase(), {
        cik: String(entry.cik_str).padStart(10, '0'),
        name: entry.title,
      });
    }
  }
  const hit = cikCache.get(sym);
  if (!hit) throw new Error(`no SEC CIK found for ticker ${sym}`);
  return hit;
}

/**
 * Recent filings for a ticker, newest first. Optionally filter to specific form
 * types (e.g. ['10-K','10-Q','8-K'] or ['4'] for insider transactions).
 */
export async function getRecentFilings(
  ticker: string,
  opts: { forms?: string[]; limit?: number } = {},
): Promise<{ company: string; cik: string; filings: Filing[] }> {
  const { cik, name } = await resolveCik(ticker);
  const cikNum = String(Number(cik)); // un-padded for the archive URL path
  const data = (await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)) as {
    filings: {
      recent: {
        accessionNumber: string[];
        filingDate: string[];
        reportDate: string[];
        form: string[];
        primaryDocument: string[];
        primaryDocDescription: string[];
      };
    };
  };

  const r = data.filings.recent;
  const wantForms = opts.forms?.map((f) => f.toUpperCase());
  const limit = opts.limit ?? 15;
  const out: Filing[] = [];

  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    const form = r.form[i];
    if (wantForms && !wantForms.includes(form.toUpperCase())) continue;
    const accNoDashes = r.accessionNumber[i].replace(/-/g, '');
    out.push({
      form,
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i] || undefined,
      accessionNumber: r.accessionNumber[i],
      primaryDocument: r.primaryDocument[i],
      description: r.primaryDocDescription[i] || undefined,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDashes}/${r.primaryDocument[i]}`,
    });
  }

  return { company: name, cik, filings: out };
}

/** Convenience: recent Form 4 insider transactions for a ticker. */
export function getInsiderForm4(ticker: string, limit = 12) {
  return getRecentFilings(ticker, { forms: ['4'], limit });
}

/** Convenience: recent periodic + material-event filings (10-K/10-Q/8-K). */
export function getKeyFilings(ticker: string, limit = 10) {
  return getRecentFilings(ticker, { forms: ['10-K', '10-Q', '8-K'], limit });
}

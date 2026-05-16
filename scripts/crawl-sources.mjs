import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const CRAWL_TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS) || 20000;
const REACHABILITY_TIMEOUT_MS = Number(process.env.REACHABILITY_TIMEOUT_MS) || Math.min(7000, CRAWL_TIMEOUT_MS);
const USER_AGENT = 'Just-DDL-Crawler/1.0 (+https://just-agent.github.io/just-ddl/)';

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 200) : null;
}

function fetchViaPowerShell(url) {
  if (process.platform !== 'win32') return null;
  const timeoutSec = Math.max(15, Math.ceil(CRAWL_TIMEOUT_MS / 1000) + 5);
  const escapedUrl = url.replace(/'/g, "''");
  const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); (Invoke-WebRequest -Uri '" + escapedUrl + "' -UseBasicParsing -TimeoutSec " + timeoutSec + " -Headers @{ 'User-Agent'='Mozilla/5.0'; 'Accept-Language'='en-US,en;q=0.9' }).Content";
  for (const command of ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: (timeoutSec + 5) * 1000
    });
    if (result.status === 0 && result.stdout && result.stdout.trim().length > 1000) {
      return result.stdout;
    }
  }
  return null;
}

async function fetchSourcePage(source) {
  const report = {
    sourceId: source.id,
    source: source.name,
    url: source.url,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'Source reachability check only; curated data/items.json preserved until item parser is implemented.',
    error: null
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    const res = await fetch(source.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT }
    });
    clearTimeout(timer);
    report.httpStatus = res.status;
    report.finalUrl = res.url;
    const text = await res.text();
    report.contentLength = text.length;
    report.title = extractTitle(text);
    report.reachable = res.status >= 200 && res.status < 400;
    report.note = report.reachable
      ? 'Source reachable. Curated data/items.json preserved until item parser is implemented.'
      : `Source returned HTTP ${res.status}. Curated data/items.json preserved.`;
  } catch (err) {
    report.error = err.name === 'AbortError' ? `Timeout after ${REACHABILITY_TIMEOUT_MS}ms` : err.message;
    report.note = `Source fetch failed: ${report.error}. Curated data/items.json preserved.`;
  }
  return report;
}

const DRIVENDATA_HEALTH_URL = 'https://www.drivendata.org/competitions/';
const DRIVENDATA_HEALTH_MIN_ITEMS = 2;
const DRIVENDATA_HEALTH_MAX_FUTURE_DAYS = Number(process.env.DRIVENDATA_HEALTH_MAX_FUTURE_DAYS) || 700;

function ddHealthDecode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function ddHealthStripHtml(value) {
  return ddHealthDecode(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ddHealthParseDate(value) {
  const normalized = ddHealthDecode(value)
    .replace(/\b([A-Z][a-z]{2})\./g, '$1')
    .replace(/a\.m\./i, 'AM')
    .replace(/p\.m\./i, 'PM')
    .replace(/\s+/g, ' ')
    .trim();
  return new Date(normalized);
}

function ddHealthSlugFromHref(href, fallbackTitle) {
  const path = href.replace(/^https?:\/\/www\.drivendata\.org/i, '');
  const slug = path
    .replace(/^\/(competitions|benchmarks)\//, '')
    .replace(/\/$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  if (slug) return slug;
  return fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function parseDrivenDataHealthItems() {
  const report = {
    sourceId: 'drivendata-health',
    source: 'DrivenData Health Competitions',
    url: DRIVENDATA_HEALTH_URL,
    items: [],
    reachable: false,
    httpStatus: null,
    finalUrl: null,
    title: null,
    contentLength: null,
    fetchedAt: new Date().toISOString(),
    note: 'DrivenData health competitions parser (filtered to health category).',
    error: null,
    parsedItemCount: 0,
    invalidItemCount: 0,
    parserHealthy: false
  };
  try {
    let text;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
      const res = await fetch(DRIVENDATA_HEALTH_URL, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      clearTimeout(timer);
      report.httpStatus = res.status;
      report.finalUrl = res.url;
      text = await res.text();
      report.reachable = res.status >= 200 && res.status < 400;
    } catch (fetchErr) {
      const fallbackText = fetchViaPowerShell(DRIVENDATA_HEALTH_URL);
      if (!fallbackText) throw fetchErr;
      text = fallbackText;
      report.httpStatus = 200;
      report.finalUrl = DRIVENDATA_HEALTH_URL;
      report.reachable = true;
      report.note = 'Fetched DrivenData Health with Windows PowerShell fallback after Node fetch failed.';
    }
    report.contentLength = text.length;
    report.title = (text.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || null;

    if (!report.reachable) {
      report.note = 'DrivenData Health returned HTTP ' + report.httpStatus + '. No items parsed.';
      return report;
    }

    // DrivenData is SSR. Cards expose exact UTC end dates in .end-date title attributes.
    // Filter to health-category cards: data-category_health="1"
    const cardStarts = [...text.matchAll(/<div\s+class="[^"]*\bpanel-container\b[^"]*"[^>]*>/gi)].map(match => match.index);
    const seen = new Set();
    for (let i = 0; i < cardStarts.length; i += 1) {
      const block = text.slice(cardStarts[i], cardStarts[i + 1] ?? text.length);

      // Only emit cards with health category marker
      const isHealth = /data-category_health="1"/i.test(block);
      if (!isHealth) continue;

      const href = (block.match(/<a\s+[^>]*href=['"]([^'"]+)['"][^>]*class="image/i) || block.match(/<h3[^>]*>[\s\S]*?<a\s+[^>]*href=['"]([^'"]+)['"]/i) || [])[1];
      const rawTitle = (block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i) || [])[1];
      const dateTitle = (block.match(/class="end-date"[^>]*title="([^"]+)"/i) || [])[1];
      const title = ddHealthStripHtml(rawTitle);

      if (!href || !title || !dateTitle) {
        report.invalidItemCount += 1;
        continue;
      }
      const deadlineDate = ddHealthParseDate(dateTitle);
      if (!deadlineDate || isNaN(deadlineDate.getTime())) {
        report.invalidItemCount += 1;
        continue;
      }
      const daysFromNow = (deadlineDate.getTime() - Date.now()) / 86400000;
      if (daysFromNow < -7 || daysFromNow > DRIVENDATA_HEALTH_MAX_FUTURE_DAYS) {
        report.invalidItemCount += 1;
        continue;
      }

      const isoDeadline = deadlineDate.toISOString().replace('.000Z', 'Z');
      const slug = ddHealthSlugFromHref(href, title);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const isBenchmark = href.includes('/benchmarks/');
      report.items.push({
        id: 'dd-health-' + slug,
        title: title,
        deadline: isoDeadline,
        dateRange: ddHealthStripHtml(dateTitle),
        location: 'Online',
        isOnline: true,
        tags: ['biotech', 'health', 'DrivenData', isBenchmark ? 'benchmark' : 'competition'],
        url: new URL(href, DRIVENDATA_HEALTH_URL).href,
        status: 'upcoming',
        description: 'Parsed from DrivenData health competitions listing. Deadline is read from the card end-date tooltip.',
        stage: 'Deadline',
        source: 'DrivenData Health Competitions',
        type: 'challenge'
      });
    }

    report.items.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    report.parsedItemCount = report.items.length;
    report.parserHealthy = report.parsedItemCount >= DRIVENDATA_HEALTH_MIN_ITEMS;
    report.note = 'Parsed ' + report.parsedItemCount + ' health items from DrivenData; rejected ' + report.invalidItemCount + ' non-health or invalid entries.';
  } catch (err) {
    report.error = err.name === 'AbortError' ? 'Timeout after ' + CRAWL_TIMEOUT_MS + 'ms' : err.message;
    report.note = 'DrivenData Health fetch failed: ' + report.error;
  }
  return report;
}

async function drivenDataHealthAdapter() {
  return parseDrivenDataHealthItems();
}
async function grandChallengeAdapter() {
  return fetchSourcePage({ id: "grand-challenge", name: "Grand Challenge", url: "https://grand-challenge.org" });
}

async function camdaAdapter() {
  return fetchSourcePage({ id: "camda", name: "CAMDA", url: "https://camda.info" });
}

async function bioCreativeAdapter() {
  return fetchSourcePage({ id: "biocreative", name: "BioCreative", url: "https://biocreative.bioinformatics.udel.edu" });
}

const adapters = [grandChallengeAdapter, camdaAdapter, bioCreativeAdapter, drivenDataHealthAdapter];
const existingItemsUrl = new URL('../data/items.json', import.meta.url);
const existingItems = JSON.parse(fs.readFileSync(existingItemsUrl, 'utf8'));
let previousParsedItemCount = null;
try {
  const previousReport = JSON.parse(fs.readFileSync(new URL('../data/crawl-report.json', import.meta.url), 'utf8'));
  previousParsedItemCount = previousReport.parsedItemCount ?? null;
} catch {}
const reports = await Promise.all(adapters.map(adapter => adapter()));

const harvestedItems = reports.flatMap(report => report.items);
const parsedItemCount = reports.reduce((s, r) => s + (r.parsedItemCount || 0), 0);
const parserHealthy = reports.every(r => r.parserHealthy !== false);
const parserDropOk = previousParsedItemCount === null || parsedItemCount >= Math.floor(previousParsedItemCount * 0.5);

function mergeFetchedWithExisting(fetchedItems, currentItems) {
  const merged = new Map();
  for (const item of currentItems) {
    if (item?.id) merged.set(item.id, item);
  }
  for (const item of fetchedItems) {
    if (item?.id) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => {
    const dateDiff = Date.parse(a.deadline) - Date.parse(b.deadline);
    if (dateDiff !== 0) return dateDiff;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
  });
}

if (harvestedItems.length >= DRIVENDATA_HEALTH_MIN_ITEMS && parserHealthy && parserDropOk) {
  const mergedItems = mergeFetchedWithExisting(harvestedItems, existingItems);
  fs.writeFileSync(existingItemsUrl, JSON.stringify(mergedItems, null, 2) + '\n', 'utf8');
  console.log('crawler wrote ' + harvestedItems.length + ' fetched items; preserved/merged total ' + mergedItems.length + ' items');
} else {
  console.log('parser emitted ' + harvestedItems.length + ' items (health gate failed or threshold not met); preserving ' + existingItems.length + ' curated items in data/items.json');
}

const reachableCount = reports.filter(r => r.reachable).length;
console.log('reachability: ' + reachableCount + '/' + reports.length + ' sources reachable');
if (parsedItemCount > 0) console.log('parsedItemCount: ' + parsedItemCount);

fs.writeFileSync(new URL('../data/crawl-report.json', import.meta.url), JSON.stringify({
  topicId: "biotech-ddl",
  generatedAt: new Date().toISOString(),
  adapterCount: reports.length,
  reachableCount,
  parsedItemCount,
  previousParsedItemCount,
  parserHealthy,
  parserDropOk,
  adapters: reports
}, null, 2) + '\n', 'utf8');

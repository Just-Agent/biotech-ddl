import fs from 'node:fs';

async function grandChallengeAdapter() {
  return {
    source: "Grand Challenge",
    url: "https://grand-challenge.org",
    items: [],
    note: 'TODO: implement parser for Grand Challenge; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function camdaAdapter() {
  return {
    source: "CAMDA",
    url: "https://camda.info",
    items: [],
    note: 'TODO: implement parser for CAMDA; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function bioCreativeAdapter() {
  return {
    source: "BioCreative",
    url: "https://biocreative.bioinformatics.udel.edu",
    items: [],
    note: 'TODO: implement parser for BioCreative; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function drivenDataHealthAdapter() {
  return {
    source: "DrivenData Health Competitions",
    url: "https://www.drivendata.org/competitions/",
    items: [],
    note: 'TODO: implement parser for DrivenData Health Competitions; keep data/items.json as curated fallback until parser is verified.'
  };
}

const adapters = [grandChallengeAdapter, camdaAdapter, bioCreativeAdapter, drivenDataHealthAdapter];
const existingItemsUrl = new URL('../data/items.json', import.meta.url);
const existingItems = JSON.parse(fs.readFileSync(existingItemsUrl, 'utf8'));
const reports = [];

for (const adapter of adapters) {
  reports.push(await adapter());
}

const harvestedItems = reports.flatMap(report => report.items);
if (harvestedItems.length > 0) {
  fs.writeFileSync(existingItemsUrl, JSON.stringify(harvestedItems, null, 2) + '\n', 'utf8');
  console.log(`crawler wrote ${harvestedItems.length} fetched items`);
} else {
  console.log(`crawler adapters ran; no verified fetched items yet, preserving ${existingItems.length} curated items`);
}

fs.writeFileSync(new URL('../data/crawl-report.json', import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  topicId: "biotech-ddl",
  adapters: reports
}, null, 2) + '\n', 'utf8');

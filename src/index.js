const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CSV_OUTPUT_PATH = process.env.CSV_OUTPUT_PATH
  || path.join(__dirname, '..', 'data', 'leads_export.csv');

const JSON_OUTPUT_PATH = process.env.JSON_OUTPUT_PATH
  || path.join(__dirname, '..', 'data', 'leads_export.json');

// ─── Configuración ───────────────────────────────────────────────────────────

const SEARCH_QUERY = process.env.SEARCH_QUERY || 'barberías norte de bogotá';
const RESULT_LIMIT = parseInt(process.env.RESULT_LIMIT || '150', 10);

// ─── Constantes ───────────────────────────────────────────────────────────────

const SOCIAL_DOMAINS = [
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'wa.me',
  'whatsapp.com',
];

const THRESHOLD_LOW_REVIEWS = 20;

// ─── Limpieza y normalización ────────────────────────────────────────────────

function cleanAddress(raw) {
  if (!raw) return '';
  return raw
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/@-?\d+\.\d+,\s*-?\d+\.\d+/g, '')
    .replace(/-?\d{1,3}\.\d{5,},\s*-?\d{1,3}\.\d{5,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return raw.trim();

  let local = digits;
  if (local.startsWith('57') && local.length > 10) {
    local = local.slice(2);
  }

  if (local.length === 10 && local.startsWith('3')) {
    return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }

  if (local.length === 7) {
    return `+57 601 ${local.slice(0, 3)} ${local.slice(3)}`;
  }

  if (local.length === 10 && local.startsWith('601')) {
    return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }

  return raw.trim();
}

function isSocialLink(url) {
  if (!url) return false;
  return SOCIAL_DOMAINS.some((domain) => url.includes(domain));
}

// ─── Detección de redes sociales ─────────────────────────────────────────────

function detectSocialLinks(website) {
  if (!website) return { instagram: '', facebook: '', whatsapp: '' };
  const lower = website.toLowerCase();
  return {
    instagram: lower.includes('instagram.com') ? website : '',
    facebook:  lower.includes('facebook.com')  ? website : '',
    whatsapp:  lower.includes('wa.me') || lower.includes('whatsapp.com') ? website : '',
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function computeScore({ has_website, has_phone, has_email, reviews_count, rating }) {
  let score = 0;
  if (!has_website)                                score += 50;
  if (has_phone)                                   score += 15;
  if (has_email)                                   score += 10;
  if ((parseInt(reviews_count, 10) || 0) >= 30)   score += 15;
  if ((parseFloat(rating) || 0) >= 4.0)            score += 10;
  return score;
}

// ─── Normalización del registro crudo ────────────────────────────────────────

function normalizeRecord(raw) {
  const address      = cleanAddress(raw.address);
  const phone        = normalizePhone(raw.phone);
  const mapsPlaceKey = extractMapsPlaceKey(raw.google_maps_url);

  const hasPhone   = phone.length > 0;
  const hasEmail   = false; // Google Maps no expone email
  const hasWebsite = raw.website.length > 0 && !isSocialLink(raw.website);

  const opportunityType = hasWebsite ? 'has_website' : 'no_website';
  const flowType        = hasWebsite ? 'website_audit' : 'no_website_demo';

  const score = computeScore({
    has_website:   hasWebsite,
    has_phone:     hasPhone,
    has_email:     hasEmail,
    reviews_count: raw.reviews_count,
    rating:        raw.rating,
  });

  const reviews = parseInt(raw.reviews_count, 10) || 0;
  const lowReviews = reviews < THRESHOLD_LOW_REVIEWS;

  return {
    ...raw,
    address,
    phone,
    maps_place_key:   mapsPlaceKey,
    has_website:      hasWebsite,
    has_email:        hasEmail,
    has_phone:        hasPhone,
    opportunity_type: opportunityType,
    flow_type:        flowType,
    score,
    low_reviews:      lowReviews,
  };
}

// ─── Transformación al schema del Google Sheet ────────────────────────────────

function makeLeadId(name, address) {
  return 'lead_' + crypto.createHash('md5').update(`${name}|${address}`).digest('hex').slice(0, 8);
}

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function transformToLead(record) {
  const ts = nowString();
  return {
    lead_id:              makeLeadId(record.name, record.address),
    business_name:        record.name,
    sector:               'peluqueria',
    city:                 'bogota',
    rating:               record.rating,
    reviews_count:        record.reviews_count,
    address:              record.address,
    phone:                record.phone,
    email:                '',
    website:              record.website,
    google_maps_url:      record.google_maps_url,
    maps_place_key:       record.maps_place_key,
    has_website:          record.has_website,
    has_email:            record.has_email,
    has_phone:            record.has_phone,
    score:                record.score,
    opportunity_type:     record.opportunity_type,
    flow_type:            record.flow_type,
    budget_qualified:     record.score >= 60,
    status:               'new',
    demo_generated:       false,
    audit_generated:      false,
    demo_url:             '',
    email_subject:        '',
    email_body:           '',
    email_sent:           false,
    last_contact_channel: 'none',
    last_contact_date:    '',
    contact_result:       '',
    notes:                '',
    created_at:           ts,
    Updated_at:           ts,
  };
}

// ─── Deduplicación ────────────────────────────────────────────────────────────

// Extracts the stable hex place key embedded in Google Maps URLs.
// Example: "0x8e3f9af5106ab819:0xb9cb5f3a1d4a906e"
function extractMapsPlaceKey(url) {
  if (!url) return '';
  const m = url.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
  return m ? m[0].toLowerCase() : '';
}

// Lowercase + remove accents + collapse spaces — used for fallback keys.
function normalizeText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the stable dedup key for a business.
// Primary:  maps_place_key (hex id embedded in the URL)
// Fallback: normalized name + address (when the hex key is absent)
function makeDedupeKey(mapsPlaceKey, name, address) {
  if (mapsPlaceKey) return `key:${mapsPlaceKey}`;
  return `fb:${normalizeText(name)}|${normalizeText(address)}`;
}

function loadExistingKeys() {
  const seen = new Set();
  if (!fs.existsSync(CSV_OUTPUT_PATH)) return seen;

  const content = fs.readFileSync(CSV_OUTPUT_PATH, 'utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true });
  for (const row of records) {
    // Prefer the stored maps_place_key column; fall back to recomputing from the URL.
    const placeKey =
      row.maps_place_key || extractMapsPlaceKey(row.google_maps_url || '');
    const key = makeDedupeKey(placeKey, row.business_name, row.address);
    if (key) seen.add(key);
  }
  return seen;
}

// ─── Scraping ────────────────────────────────────────────────────────────────

async function autoScroll(page) {
  console.log('Iniciando scroll del panel...');
  const feed = page.locator('div[role="feed"]');

  let lastCount = 0;
  let stableRounds = 0;

  for (let i = 0; i < 25; i++) {
    await feed.evaluate((el) => el.scrollBy(0, 2000));
    console.log(`Scroll ${i + 1}`);
    await page.waitForTimeout(2000);

    const reachedEnd = await page
      .locator('text=Has llegado al final de la lista')
      .isVisible()
      .catch(() => false);
    if (reachedEnd) {
      console.log('Fin de lista alcanzado.');
      break;
    }

    const count = await page
      .locator('div[role="feed"] a[href*="/maps/place/"]')
      .count();

    if (count === lastCount) {
      stableRounds++;
      if (stableRounds >= 3) break;
    } else {
      stableRounds = 0;
      lastCount = count;
    }
  }
}

async function extractPlaceDetails(page) {
  await page.waitForSelector('h1', { timeout: 15000 });
  await page.waitForTimeout(1500);

  const name = await page
    .locator('h1')
    .first()
    .innerText()
    .catch(() => '');

  const rating = await page
    .locator('div.F7nice span[aria-hidden="true"]')
    .first()
    .innerText()
    .catch(() => '');

  let reviews_count = '';
  const reviewsLabel = await page
    .locator('div.F7nice span[aria-label]')
    .first()
    .getAttribute('aria-label')
    .catch(() => '');
  if (reviewsLabel) {
    const m = reviewsLabel.match(/[\d.,]+/);
    if (m) reviews_count = m[0].replace(/\./g, '').replace(',', '');
  }

  const address = await page
    .locator('button[data-item-id="address"] .Io6YTe')
    .first()
    .innerText()
    .catch(() => '');

  const phone = await page
    .locator('[data-item-id^="phone:tel"] .Io6YTe')
    .first()
    .innerText()
    .catch(() => '');

  const website = await page
    .locator('a[data-item-id="authority"]')
    .first()
    .getAttribute('href')
    .catch(() => '');

  const google_maps_url = page.url();

  return {
    name:          name.trim(),
    rating:        rating.trim().replace(',', '.'),
    reviews_count: reviews_count.trim(),
    address:       address.trim(),
    phone:         phone.trim(),
    website:       (website || '').trim(),
    google_maps_url,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvExistedAtStart = fs.existsSync(CSV_OUTPUT_PATH);
  const existingKeys = loadExistingKeys();
  console.log(`Claves existentes en CSV: ${existingKeys.size}`);

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo: process.env.HEADLESS !== 'false' ? 0 : 200,
  });
  const page = await browser.newPage();

  console.log(`\nStarting scrape\nQuery: ${SEARCH_QUERY}\nLimit: ${RESULT_LIMIT} businesses\n`);

  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(SEARCH_QUERY)}`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Página de búsqueda abierta');
  await page.waitForTimeout(5000);

  await autoScroll(page);

  const linkLocator = page.locator('div[role="feed"] a[href*="/maps/place/"]');
  const total = await linkLocator.count();
  console.log(`Tarjetas detectadas en feed: ${total}`);

  const urls = new Set();
  for (let i = 0; i < total; i++) {
    const href = await linkLocator.nth(i).getAttribute('href').catch(() => null);
    if (href) {
      const fullUrl = href.startsWith('http')
        ? href
        : `https://www.google.com${href}`;
      urls.add(fullUrl);
    }
  }

  const urlList = [...urls].slice(0, RESULT_LIMIT);
  console.log(`URLs únicas a visitar: ${urlList.length} (límite: ${RESULT_LIMIT})`);

  const scraped = [];
  let skipped = 0;

  for (let i = 0; i < urlList.length; i++) {
    const url = urlList[i];

    // Early skip: check place key extracted from feed URL before even visiting the page
    const earlyKey = extractMapsPlaceKey(url);
    if (earlyKey && existingKeys.has(`key:${earlyKey}`)) {
      console.log(`[${i + 1}/${urlList.length}] DUPLICADO (feed key) — omitido`);
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${urlList.length}] ${url.substring(0, 80)}...`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const raw = await extractPlaceDetails(page);

      if (raw.name) {
        const record = normalizeRecord(raw);
        const dedupeKey = makeDedupeKey(record.maps_place_key, record.name, record.address);

        if (existingKeys.has(dedupeKey)) {
          console.log(`  ~ DUPLICADO (post-scrape) — omitido: ${record.name}`);
          skipped++;
          continue;
        }

        existingKeys.add(dedupeKey);
        scraped.push(record);
        console.log(
          `  ✓ ${record.name} | ${record.rating}★ | ${record.reviews_count} reseñas | score:${record.score} [${record.opportunity_type}] | key:${record.maps_place_key || 'fallback'}`
        );
      }
    } catch (err) {
      console.log(`  ✗ Error en ficha ${i + 1}: ${err.message}`);
    }
  }

  console.log(`\nTotal nuevas peluquerías: ${scraped.length} | Duplicados omitidos: ${skipped}`);

  if (scraped.length === 0) {
    console.log('Sin registros nuevos. CSV no modificado.');
    await browser.close();
    return;
  }

  // Final dedup pass — safety net in case the same business appeared under
  // different feed URLs within this run and slipped through the early check.
  const seenThisRun = new Set();
  const dedupedScrape = scraped.filter((r) => {
    const key = makeDedupeKey(r.maps_place_key, r.name, r.address);
    if (seenThisRun.has(key)) return false;
    seenThisRun.add(key);
    return true;
  });

  if (dedupedScrape.length < scraped.length) {
    console.log(`Duplicados eliminados en paso final: ${scraped.length - dedupedScrape.length}`);
  }

  // Ordenar por score descendente
  dedupedScrape.sort((a, b) => b.score - a.score);

  const leads = dedupedScrape.map((r) => transformToLead(r));

  const csvWriter = createObjectCsvWriter({
    path: CSV_OUTPUT_PATH,
    header: [
      { id: 'lead_id',              title: 'lead_id' },
      { id: 'business_name',        title: 'business_name' },
      { id: 'sector',               title: 'sector' },
      { id: 'city',                 title: 'city' },
      { id: 'rating',               title: 'rating' },
      { id: 'reviews_count',        title: 'reviews_count' },
      { id: 'address',              title: 'address' },
      { id: 'phone',                title: 'phone' },
      { id: 'email',                title: 'email' },
      { id: 'website',              title: 'website' },
      { id: 'google_maps_url',      title: 'google_maps_url' },
      { id: 'maps_place_key',       title: 'maps_place_key' },
      { id: 'has_website',          title: 'has_website' },
      { id: 'has_email',            title: 'has_email' },
      { id: 'has_phone',            title: 'has_phone' },
      { id: 'score',                title: 'score' },
      { id: 'opportunity_type',     title: 'opportunity_type' },
      { id: 'flow_type',            title: 'flow_type' },
      { id: 'budget_qualified',     title: 'budget_qualified' },
      { id: 'status',               title: 'status' },
      { id: 'demo_generated',       title: 'demo_generated' },
      { id: 'audit_generated',      title: 'audit_generated' },
      { id: 'demo_url',             title: 'demo_url' },
      { id: 'email_subject',        title: 'email_subject' },
      { id: 'email_body',           title: 'email_body' },
      { id: 'email_sent',           title: 'email_sent' },
      { id: 'last_contact_channel', title: 'last_contact_channel' },
      { id: 'last_contact_date',    title: 'last_contact_date' },
      { id: 'contact_result',       title: 'contact_result' },
      { id: 'notes',                title: 'notes' },
      { id: 'created_at',           title: 'created_at' },
      { id: 'Updated_at',           title: 'Updated_at' },
    ],
    append: csvExistedAtStart,
  });

  await csvWriter.writeRecords(leads);
  console.log(`CSV guardado en ${CSV_OUTPUT_PATH} (${leads.length} leads nuevos)`);

  // JSON export — current run's leads only (n8n reads this to append to Sheets)
  fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(leads, null, 2), 'utf8');
  console.log(`JSON guardado en ${JSON_OUTPUT_PATH} (${leads.length} leads)`);

  await browser.close();
}

main().catch((err) => {
  console.error('Error ejecutando el scraper:', err);
  process.exit(1);
});

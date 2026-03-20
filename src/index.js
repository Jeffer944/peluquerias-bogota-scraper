const https = require('https');
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

const RESULT_LIMIT   = parseInt(process.env.RESULT_LIMIT || '10', 10);
const SEARCH_QUERIES = process.env.SEARCH_QUERIES
  ? process.env.SEARCH_QUERIES.split(',').map((q) => q.trim()).filter(Boolean)
  : [process.env.SEARCH_QUERY || 'barberías norte de bogotá'];
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

if (!API_KEY) {
  console.error('ERROR: falta GOOGLE_PLACES_API_KEY en el archivo .env');
  process.exit(1);
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const SOCIAL_DOMAINS = [
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'wa.me',
  'whatsapp.com',
  'linktr.ee',
];

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Google Places API ───────────────────────────────────────────────────────

async function textSearch(query, pageToken = '') {
  const params = new URLSearchParams({
    query,
    key:      API_KEY,
    language: 'es',
    region:   'co',
  });
  if (pageToken) params.set('pagetoken', pageToken);
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`;
  return fetchJson(url);
}

async function placeDetails(placeId) {
  const fields = [
    'place_id', 'name', 'rating', 'user_ratings_total',
    'formatted_phone_number', 'website', 'formatted_address', 'url', 'reviews',
  ].join(',');
  const params = new URLSearchParams({ place_id: placeId, fields, key: API_KEY, language: 'es' });
  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  return fetchJson(url);
}

// Collects up to `limit` place_ids via Text Search (max 3 pages = 60 per query)
async function collectPlaceIds(query, limit) {
  const ids = [];
  let pageToken = '';

  for (let page = 0; page < 3 && ids.length < limit; page++) {
    if (page > 0) await sleep(2000); // API requires delay between pages

    const res = await textSearch(query, pageToken);

    if (res.status !== 'OK' && res.status !== 'ZERO_RESULTS') {
      console.error(`Text Search error: ${res.status} — ${res.error_message || ''}`);
      break;
    }

    for (const place of (res.results || [])) {
      if (ids.length >= limit) break;
      ids.push(place.place_id);
    }

    pageToken = res.next_page_token || '';
    if (!pageToken) break;
  }

  return ids;
}

// ─── Resumen de reseñas negativas ────────────────────────────────────────────

function summarizeNegativeReviews(reviews) {
  if (!reviews || reviews.length === 0) return '';

  const negative = reviews.filter((r) => r.rating <= 3 && r.text && r.text.trim().length > 0);
  if (negative.length === 0) return '';

  // Junta todos los textos negativos y extrae hasta 2 oraciones reales
  const allText = negative.map((r) => r.text.trim()).join(' ');
  const sentences = allText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  return sentences.slice(0, 2).join(' ');
}

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
  if (local.startsWith('57') && local.length > 10) local = local.slice(2);

  if (local.length === 10 && local.startsWith('3'))
    return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  if (local.length === 7)
    return `+57 601 ${local.slice(0, 3)} ${local.slice(3)}`;
  if (local.length === 10 && local.startsWith('601'))
    return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;

  return raw.trim();
}

function isSocialLink(url) {
  if (!url) return false;
  return SOCIAL_DOMAINS.some((d) => url.includes(d));
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function computeScore({ has_website, has_phone, has_email, reviews_count, rating }) {
  let score = 0;
  if (!has_website)          score += 50;
  if (has_phone)             score += 15;
  if (has_email)             score += 10;
  if (reviews_count >= 30)   score += 15;
  if (rating >= 4.0)         score += 10;
  return score;
}

// ─── Normalización del registro crudo ────────────────────────────────────────

function normalizeRecord(raw) {
  const address    = cleanAddress(raw.address);
  const phone      = normalizePhone(raw.phone);
  const hasPhone       = phone.length > 0;
  const hasEmail       = false;
  const hasSocialMedia = raw.website.length > 0 && isSocialLink(raw.website);
  const hasWebsite     = raw.website.length > 0 && !hasSocialMedia;
  const reviews    = parseInt(raw.reviews_count, 10) || 0;
  const rating     = parseFloat(raw.rating) || 0;

  const opportunityType = hasWebsite ? 'has_website' : 'no_website';
  const flowType        = hasWebsite ? 'website_audit' : 'no_website_demo';

  const score = computeScore({ has_website: hasWebsite, has_phone: hasPhone, has_email: hasEmail, reviews_count: reviews, rating });

  return {
    ...raw,
    address,
    phone,
    rating,
    reviews_count:             reviews,
    has_website:               hasWebsite,
    has_social_media:          hasSocialMedia,
    has_email:                 hasEmail,
    has_phone:                 hasPhone,
    opportunity_type:          opportunityType,
    flow_type:                 flowType,
    score,
    negative_reviews_summary:  raw.negative_reviews_summary || '',
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
    has_social_media:     record.has_social_media,
    has_email:            record.has_email,
    has_phone:            record.has_phone,
    score:                record.score,
    opportunity_type:     record.opportunity_type,
    flow_type:            record.flow_type,
    budget_qualified:     record.has_website
      ? (record.reviews_count >= 50 && record.has_phone && record.rating >= 4.3)
      : (record.reviews_count >= 40 && record.has_phone),
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
    notes:                    '',
    negative_reviews_summary: record.negative_reviews_summary || '',
    created_at:               ts,
    Updated_at:               ts,
  };
}

// ─── Deduplicación ────────────────────────────────────────────────────────────

function normalizeText(str) {
  if (!str) return '';
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function makeDedupeKey(placeId, name, address) {
  if (placeId) return `pid:${placeId}`;
  return `fb:${normalizeText(name)}|${normalizeText(address)}`;
}

function loadExistingKeys() {
  const seen = new Set();
  if (!fs.existsSync(CSV_OUTPUT_PATH)) return seen;
  const content = fs.readFileSync(CSV_OUTPUT_PATH, 'utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true });
  for (const row of records) {
    const key = makeDedupeKey(row.maps_place_key, row.business_name, row.address);
    if (key) seen.add(key);
  }
  return seen;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvExistedAtStart = fs.existsSync(CSV_OUTPUT_PATH);
  const existingKeys = loadExistingKeys();
  console.log(`Claves existentes en CSV: ${existingKeys.size}`);
  console.log(`\nQueries: ${SEARCH_QUERIES.length} | Límite total: ${RESULT_LIMIT}\n`);

  // 1. Recopilar place_ids via Text Search (todas las queries)
  const allPlaceIds = [];
  const seenPlaceIds = new Set();

  for (const query of SEARCH_QUERIES) {
    if (allPlaceIds.length >= RESULT_LIMIT) break;
    console.log(`Buscando: "${query}"...`);
    const remaining = RESULT_LIMIT - allPlaceIds.length;
    const ids = await collectPlaceIds(query, remaining);
    let added = 0;
    for (const id of ids) {
      if (!seenPlaceIds.has(id)) {
        seenPlaceIds.add(id);
        allPlaceIds.push(id);
        added++;
      }
    }
    console.log(`  → ${added} nuevos place_ids (total acumulado: ${allPlaceIds.length})\n`);
  }

  const placeIds = allPlaceIds;
  console.log(`place_ids únicos encontrados: ${placeIds.length}\n`);

  const scraped = [];
  let skipped = 0;

  // 2. Obtener detalles de cada negocio
  for (let i = 0; i < placeIds.length; i++) {
    const placeId = placeIds[i];
    const dedupeKey = makeDedupeKey(placeId, '', '');

    if (existingKeys.has(dedupeKey)) {
      console.log(`[${i + 1}/${placeIds.length}] DUPLICADO — omitido (${placeId})`);
      skipped++;
      continue;
    }

    try {
      const res = await placeDetails(placeId);

      if (res.status !== 'OK') {
        console.log(`[${i + 1}/${placeIds.length}] ERROR details: ${res.status}`);
        continue;
      }

      const p = res.result;
      const negative_reviews_summary = summarizeNegativeReviews(p.reviews || []);
      const raw = {
        name:          (p.name || '').trim(),
        rating:        p.rating || 0,
        reviews_count: p.user_ratings_total || 0,
        address:       (p.formatted_address || '').trim(),
        phone:         (p.formatted_phone_number || '').trim(),
        website:       (p.website || '').trim(),
        google_maps_url: p.url || '',
        maps_place_key:  p.place_id || placeId,
        negative_reviews_summary,
      };

      if (!raw.name) continue;

      const record = normalizeRecord(raw);
      const fullKey = makeDedupeKey(record.maps_place_key, record.name, record.address);

      if (existingKeys.has(fullKey)) {
        console.log(`  ~ DUPLICADO (post-fetch) — omitido: ${record.name}`);
        skipped++;
        continue;
      }

      existingKeys.add(fullKey);
      scraped.push(record);

      const qualified = record.has_website
        ? (record.reviews_count >= 50 && record.has_phone && record.rating >= 4.3)
        : (record.reviews_count >= 40 && record.has_phone);

      console.log(
        `[${i + 1}/${placeIds.length}] ✓ ${record.name}` +
        ` | rating:${record.rating} | reviews_count:${record.reviews_count}` +
        ` | web:${record.has_website} | phone:${record.has_phone} | qualified:${qualified}`
      );

    } catch (err) {
      console.log(`[${i + 1}/${placeIds.length}] ✗ Error: ${err.message}`);
    }

    // Pequeña pausa para no saturar la API
    await sleep(200);
  }

  console.log(`\nTotal nuevos: ${scraped.length} | Duplicados omitidos: ${skipped}`);

  if (scraped.length === 0) {
    console.log('Sin registros nuevos. CSV no modificado.');
    return;
  }

  scraped.sort((a, b) => b.score - a.score);
  const leads = scraped.map((r) => transformToLead(r));

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
      { id: 'has_social_media',     title: 'has_social_media' },
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
      { id: 'notes',                    title: 'notes' },
      { id: 'negative_reviews_summary', title: 'negative_reviews_summary' },
      { id: 'created_at',               title: 'created_at' },
      { id: 'Updated_at',               title: 'Updated_at' },
    ],
    append: csvExistedAtStart,
  });

  await csvWriter.writeRecords(leads);
  console.log(`CSV guardado en ${CSV_OUTPUT_PATH} (${leads.length} leads nuevos)`);

  fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(leads, null, 2), 'utf8');
  console.log(`JSON guardado en ${JSON_OUTPUT_PATH} (${leads.length} leads)`);
}

main().catch((err) => {
  console.error('Error ejecutando el scraper:', err);
  process.exit(1);
});

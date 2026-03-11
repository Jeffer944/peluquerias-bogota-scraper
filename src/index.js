const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const CSV_OUTPUT_PATH = process.env.CSV_OUTPUT_PATH
  || path.join(__dirname, '..', 'data', 'leads_export.csv');

// ─── Constantes de umbral ────────────────────────────────────────────────────

const THRESHOLD_LOW_REVIEWS = 50;
const THRESHOLD_LOW_RATING = 4.2;

// ─── Limpieza y normalización ────────────────────────────────────────────────

function cleanAddress(raw) {
  if (!raw) return '';
  return raw
    .replace(/https?:\/\/\S+/gi, '')              // URLs
    .replace(/@-?\d+\.\d+,\s*-?\d+\.\d+/g, '')   // @lat,lng (formato Google Maps)
    .replace(/-?\d{1,3}\.\d{5,},\s*-?\d{1,3}\.\d{5,}/g, '') // coordenadas sueltas
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return raw.trim();

  // Quitar prefijo de país 57 si viene con él
  let local = digits;
  if (local.startsWith('57') && local.length > 10) {
    local = local.slice(2);
  }

  // Celular colombiano: 10 dígitos empezando en 3
  if (local.length === 10 && local.startsWith('3')) {
    return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }

  // Bogotá fijo solo 7 dígitos (sin área)
  if (local.length === 7) {
    return `+57 601 ${local.slice(0, 3)} ${local.slice(3)}`;
  }

  // Fijo con código de área 601 (10 dígitos)
  if (local.length === 10 && local.startsWith('601')) {
    return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }

  // Fallback: devolver original limpio
  return raw.trim();
}

// ─── Análisis de sitio web ───────────────────────────────────────────────────

async function analyzeWebsite(url) {
  // Regla 5: sin HTTPS (no requiere petición HTTP)
  if (url.startsWith('http://')) {
    return {
      website_issue_type:    'no_https',
      website_issue_details: 'El sitio no usa HTTPS y puede generar desconfianza en los usuarios',
    };
  }

  let html;
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAudit/1.0)' },
      maxRedirects: 5,
    });
    html = response.data;
  } catch {
    return {
      website_issue_type:    'site_unreachable',
      website_issue_details: 'No fue posible cargar el sitio web para analizarlo',
    };
  }

  const $ = cheerio.load(html);
  const bodyHtml = $.html().toLowerCase();
  const bodyText = $('body').text().toLowerCase();

  // Regla 1: sin botón de WhatsApp
  if (!bodyHtml.includes('wa.me') && !bodyHtml.includes('whatsapp.com')) {
    return {
      website_issue_type:    'no_whatsapp_cta',
      website_issue_details: 'El sitio no tiene botón visible para reservar por WhatsApp',
    };
  }

  // Regla 2: sin CTA para agendar
  const bookingKeywords = ['reservar', 'agendar', 'book', 'appointment'];
  const hasBookingCta = bookingKeywords.some((kw) =>
    $('a, button').toArray().some((el) => $(el).text().toLowerCase().includes(kw))
  );
  if (!hasBookingCta) {
    return {
      website_issue_type:    'no_booking_cta',
      website_issue_details: 'El sitio no muestra llamadas claras para reservar o agendar citas',
    };
  }

  // Regla 3: sin teléfono visible
  if (!bodyHtml.includes('tel:') && !bodyText.includes('phone')) {
    return {
      website_issue_type:    'no_phone_visible',
      website_issue_details: 'El sitio no muestra un teléfono visible para contacto rápido',
    };
  }

  // Regla 4: sin dirección visible
  const addressKeywords = ['dirección', 'address', 'ubicación', 'location'];
  if (!addressKeywords.some((kw) => bodyText.includes(kw))) {
    return {
      website_issue_type:    'no_location_visible',
      website_issue_details: 'El sitio no muestra claramente la dirección del negocio',
    };
  }

  return {
    website_issue_type:    'no_issue_detected',
    website_issue_details: 'No se detectaron problemas básicos automáticamente',
  };
}

// ─── Cálculo de oportunidad ──────────────────────────────────────────────────

function computeOpportunity(record, websiteIssueType) {
  const rating = parseFloat(record.rating) || 0;
  const reviews = parseInt(record.reviews_count, 10) || 0;
  const hasWebsite = record.website.length > 0;
  const hasPhone = record.phone.length > 0;

  const lowReviews = reviews < THRESHOLD_LOW_REVIEWS;
  const lowRating = rating > 0 && rating < THRESHOLD_LOW_RATING;

  // Puntuación aditiva (máx 10)
  let score = 0;
  if (!hasWebsite) score += 4;   // mayor necesidad: sin presencia web
  if (lowReviews)  score += 3;   // poca visibilidad online
  if (lowRating)   score += 2;   // reputación mejorable
  if (hasPhone)    score += 1;   // contactable directamente

  // Tipo de oportunidad según nueva lógica
  let opportunity_type;
  if (!hasWebsite) {
    opportunity_type = 'no_website';
  } else if (websiteIssueType && websiteIssueType !== 'no_issue_detected') {
    opportunity_type = 'bad_website';
  } else if (lowReviews) {
    opportunity_type = 'low_reviews';
  } else {
    opportunity_type = 'establecido';
  }

  return {
    has_website:       hasWebsite ? 'true' : 'false',
    low_reviews:       lowReviews ? 'true' : 'false',
    low_rating:        lowRating  ? 'true' : 'false',
    opportunity_score: score,
    opportunity_type,
  };
}

// ─── Transformación al schema final del Google Sheet ─────────────────────────

function makeLeadId(name, address) {
  // Hash estable: mismo negocio → mismo ID en re-runs
  return 'lead_' + crypto.createHash('md5').update(`${name}|${address}`).digest('hex').slice(0, 8);
}

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function transformToLead(record) {
  const hasWebsite  = record.has_website === 'true';
  const hasPhone    = record.phone.length > 0;
  // Score escalado 0-100 (el cálculo interno es 0-10, factor x10)
  const score       = record.opportunity_score * 10;
  // flow_type: sin web → demostración, con web → auditoría
  const flowType    = !hasWebsite ? 'no_website_demo' : 'website_audit';
  const ts          = nowString();

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
    has_website:          hasWebsite,
    has_email:            false,
    has_phone:            hasPhone,
    score,
    opportunity_type:     record.opportunity_type,
    website_issue_type:   record.website_issue_type   || '',
    website_issue_details: record.website_issue_details || '',
    flow_type:            flowType,
    budget_qualified:     score >= 60,
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

// ─── Enriquecimiento de un registro crudo ───────────────────────────────────

async function enrichRecord(raw) {
  const cleaned = {
    ...raw,
    address: cleanAddress(raw.address),
    phone:   normalizePhone(raw.phone),
  };

  const websiteAnalysis = cleaned.website
    ? await analyzeWebsite(cleaned.website)
    : { website_issue_type: '', website_issue_details: '' };

  return {
    ...cleaned,
    ...computeOpportunity(cleaned, websiteAnalysis.website_issue_type),
    ...websiteAnalysis,
  };
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
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo: process.env.HEADLESS !== 'false' ? 0 : 200,
  });
  const page = await browser.newPage();

  const searchUrl =
    'https://www.google.com/maps/search/peluquer%C3%ADas+en+Bogot%C3%A1';

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

  const urlList = [...urls].slice(0, 20);
  console.log(`URLs únicas a visitar: ${urlList.length} (límite de prueba: 20)`);

  const scraped = [];

  for (let i = 0; i < urlList.length; i++) {
    const url = urlList[i];
    console.log(`[${i + 1}/${urlList.length}] ${url.substring(0, 80)}...`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const raw = await extractPlaceDetails(page);

      if (raw.name) {
        const record = await enrichRecord(raw);
        scraped.push(record);
        console.log(
          `  ✓ ${record.name} | ${record.rating}★ | ${record.reviews_count} reseñas | score:${record.opportunity_score} [${record.opportunity_type}] | web:${record.website_issue_type || 'n/a'}`
        );
      }
    } catch (err) {
      console.log(`  ✗ Error en ficha ${i + 1}: ${err.message}`);
    }
  }

  console.log(`\nTotal peluquerías extraídas: ${scraped.length}`);

  // Ordenar por score descendente antes de transformar
  scraped.sort((a, b) => b.opportunity_score - a.opportunity_score);

  // Transformar al schema final del Google Sheet
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
      { id: 'has_website',          title: 'has_website' },
      { id: 'has_email',            title: 'has_email' },
      { id: 'has_phone',            title: 'has_phone' },
      { id: 'score',                title: 'score' },
      { id: 'opportunity_type',      title: 'opportunity_type' },
      { id: 'website_issue_type',   title: 'website_issue_type' },
      { id: 'website_issue_details', title: 'website_issue_details' },
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
  });

  await csvWriter.writeRecords(leads);
  console.log(`CSV guardado en ${CSV_OUTPUT_PATH} (${leads.length} leads)`);

  await browser.close();
}

main().catch((err) => {
  console.error('Error ejecutando el scraper:', err);
});

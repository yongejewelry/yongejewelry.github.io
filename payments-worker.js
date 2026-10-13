// Yonge Jewelry payments
// A Cloudflare Worker that takes Square card payments for the website and reports online stock.
// Paste this whole file into the Worker's code editor in the Cloudflare dashboard, then Deploy.
//
// Settings (Cloudflare dashboard > Workers & Pages > this Worker > Settings > Variables and Secrets):
//   SQUARE_ACCESS_TOKEN   Secret  your Square access token (never put this anywhere else)
//   SQUARE_LOCATION_ID    Text    your Square location ID
//   SQUARE_ENVIRONMENT    Text    sandbox while testing, production when live
//   SITE_URL              Text    your website address, e.g. https://yongejewelry.com
//   ALLOWED_ORIGINS       Text    optional: other site addresses allowed to use this Worker, comma-separated
//   SQUARE_VERSION        Text    optional: a Square API version date to pin
//
// Routes:
//   GET  /stock  -> { sold: { "<product id>": <units sold online> } }
//   POST /pay    -> charges the card token from Square's card form and records the order in Square

const SOURCE_NAME = 'Yonge Jewelry website';   // tags website orders so stock can be counted from Square
const CURRENCY = 'CAD';

// Same shipping and tax rules the checkout page shows.
const TAX = { AB: 0.05, BC: 0.12, MB: 0.12, NB: 0.15, NL: 0.15, NS: 0.14, NT: 0.05, NU: 0.05, ON: 0.13, PE: 0.15, QC: 0.14975, SK: 0.11, YT: 0.05 };
const PROV = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
const SHIP = { ON: 12, CA: 18, US: 28, INTL: 45 };
const EUROPE = new Set(['AT', 'BE', 'DK', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'NL', 'NO', 'PL', 'PT', 'ES', 'SE', 'CH', 'GB']);

const CARD_MESSAGES = {
  CARD_DECLINED: 'Your card was declined. Please try another card.',
  GENERIC_DECLINE: 'Your card was declined. Please try another card.',
  INSUFFICIENT_FUNDS: 'Your card was declined for insufficient funds.',
  CVV_FAILURE: 'The security code (CVV) did not match. Please check it and try again.',
  VERIFY_CVV_FAILURE: 'The security code (CVV) did not match. Please check it and try again.',
  ADDRESS_VERIFICATION_FAILURE: 'The postal code did not match your card. Please check it and try again.',
  VERIFY_AVS_FAILURE: 'The postal code did not match your card. Please check it and try again.',
  INVALID_EXPIRATION: 'The expiry date is not valid. Please check it and try again.',
  CARD_EXPIRED: 'This card has expired. Please use another card.',
  INVALID_CARD: 'The card details are not valid. Please check them and try again.',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(request.headers.get('Origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (path === '/stock' && request.method === 'GET') {
        return json({ sold: await soldCounts(env) }, 200, cors, 'public, max-age=15');
      }
      if (path === '/pay' && request.method === 'POST') return await pay(request, env, cors);
      if (path === '/') return json({ ok: true, service: 'Yonge Jewelry payments', environment: env.SQUARE_ENVIRONMENT || 'sandbox' }, 200, cors);
      return json({ error: 'Not found.' }, 404, cors);
    } catch (err) {
      console.log('error', err && err.message);
      return json({ error: 'Something went wrong. Please try again.' }, 500, cors);
    }
  },
};

// ---------- helpers ----------

function json(body, status, cors, cache) {
  const headers = { 'Content-Type': 'application/json', ...cors };
  headers['Cache-Control'] = cache || 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

function siteOrigins(env) {
  const list = [];
  if (env.SITE_URL) {
    try {
      const u = new URL(env.SITE_URL);
      list.push(u.origin);
      const host = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
      if (!u.hostname.endsWith('github.io')) list.push(u.protocol + '//' + host);
    } catch (e) { /* ignore a malformed SITE_URL */ }
  }
  (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean).forEach((o) => list.push(o));
  return list;
}

// Lets the website (on GitHub Pages, a different address) call this Worker from the browser.
function corsHeaders(origin, env) {
  if (!origin || !siteOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function need(env, name) {
  if (!env[name]) throw new Error(`Missing setting ${name}`);
  return env[name];
}

// The catalogue is the products.json file on the website itself, so prices live in one place.
let productCache = { at: 0, byId: null };
async function products(env) {
  if (productCache.byId && Date.now() - productCache.at < 60000) return productCache.byId;
  const base = need(env, 'SITE_URL').replace(/\/+$/, '');
  const res = await fetch(base + '/products.json', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`products.json returned ${res.status}`);
  const list = await res.json();
  productCache = { at: Date.now(), byId: new Map(list.map((p) => [String(p.id), p])) };
  return productCache.byId;
}

async function square(env, path, body) {
  const base = (env.SQUARE_ENVIRONMENT || 'sandbox') === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const headers = { Authorization: `Bearer ${need(env, 'SQUARE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' };
  if (env.SQUARE_VERSION) headers['Square-Version'] = env.SQUARE_VERSION;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((out.errors && out.errors[0] && out.errors[0].detail) || `Square error ${res.status}`);
    err.squareErrors = out.errors || [];
    err.status = res.status;
    throw err;
  }
  return out;
}

// Units sold online per product id, counted from paid website orders in Square.
async function soldCounts(env) {
  const sold = {};
  let cursor;
  do {
    const page = await square(env, '/v2/orders/search', {
      location_ids: [need(env, 'SQUARE_LOCATION_ID')],
      limit: 500,
      cursor,
      query: { filter: { state_filter: { states: ['OPEN', 'COMPLETED'] }, source_filter: { source_names: [SOURCE_NAME] } } },
    });
    for (const order of page.orders || []) {
      if (!order.tenders || !order.tenders.length) continue;   // created but never paid
      for (const line of order.line_items || []) {
        const sku = line.metadata && line.metadata.sku;
        if (sku) sold[sku] = (sold[sku] || 0) + Number(line.quantity || 0);
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return sold;
}

const cents = (dollars) => Math.round(dollars * 100);
const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

function shippingFor(subtotal, country, province) {
  const zone = country === 'CA' ? (province === 'ON' ? 'ON' : 'CA') : country === 'US' ? 'US' : 'INTL';
  if (zone === 'ON') return 0;
  const base = SHIP[zone];
  const freeFrom = base <= 20 ? 150 : 250;
  return subtotal >= freeFrom ? 0 : base;
}

// ---------- POST /pay ----------
// Body: { sourceId, idempotencyKey, ref, items: [{ id, qty }], destination: { country, province }, buyer: {...} }
// Prices, stock, shipping and tax are recomputed here, never trusted from the browser.

async function pay(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  const dest = body.destination || {};
  const buyer = body.buyer || {};
  const country = clean(dest.country, 2).toUpperCase();
  const province = clean(dest.province, 2).toUpperCase();

  if (!body.sourceId || !items.length) return json({ error: 'Your order is missing items or payment details.' }, 400, cors);
  if (!(country === 'CA' || country === 'US' || EUROPE.has(country))) return json({ error: 'We cannot ship to that country online yet.' }, 400, cors);
  if (country === 'CA' && !TAX[province]) return json({ error: 'Please choose a province or territory.' }, 400, cors);
  if (!clean(buyer.email, 254).includes('@')) return json({ error: 'Please add a valid email address.' }, 400, cors);

  const catalogue = await products(env);
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const product = catalogue.get(String(it.id));
    const qty = Math.floor(Number(it.qty));
    if (!product || product.price == null || !(qty >= 1)) return json({ error: 'One of the pieces in your cart is not available online.' }, 400, cors);
    lines.push({ product, qty });
    subtotal += product.price * qty;
  }

  try {
    const sold = await soldCounts(env);
    const soldOut = lines.filter(({ product, qty }) => product.qty - (sold[String(product.id)] || 0) < qty).map(({ product }) => product.id);
    if (soldOut.length) return json({ error: 'Some pieces have just sold.', soldOut }, 409, cors);

    const shipping = shippingFor(subtotal, country, province);
    const ref = clean(body.ref, 40) || `YJ-${Date.now().toString(36).toUpperCase()}`;
    const key = clean(body.idempotencyKey, 36) || crypto.randomUUID();
    const locationId = need(env, 'SQUARE_LOCATION_ID');

    const order = {
      location_id: locationId,
      reference_id: ref,
      source: { name: SOURCE_NAME },
      line_items: lines.map(({ product, qty }) => ({
        name: product.name,
        quantity: String(qty),
        base_price_money: { amount: cents(product.price), currency: CURRENCY },
        metadata: { sku: String(product.id) },
        note: product.material || undefined,
      })),
    };
    if (shipping > 0) {
      order.service_charges = [{ uid: 'shipping', name: 'Shipping', amount_money: { amount: cents(shipping), currency: CURRENCY }, calculation_phase: 'SUBTOTAL_PHASE', taxable: true }];
    }
    if (country === 'CA') {
      order.taxes = [{ uid: 'sales-tax', name: `Sales tax (${PROV[province]})`, percentage: String(+(TAX[province] * 100).toFixed(3)), scope: 'ORDER' }];
    }
    const created = await square(env, '/v2/orders', { idempotency_key: `${key}-o`, order });
    const totalMoney = created.order.total_money;

    const name = clean(buyer.name, 120);
    const [firstName, ...rest] = name.split(/\s+/);
    const address = {
      first_name: firstName || undefined,
      last_name: rest.join(' ') || undefined,
      address_line_1: clean(buyer.address, 200),
      locality: clean(buyer.city, 100),
      administrative_district_level_1: clean(buyer.region, 100) || undefined,
      postal_code: clean(buyer.postal, 20),
      country,
    };
    const paid = await square(env, '/v2/payments', {
      source_id: String(body.sourceId),
      idempotency_key: `${key}-p`,
      amount_money: totalMoney,
      order_id: created.order.id,
      location_id: locationId,
      autocomplete: true,
      reference_id: ref,
      note: `Website order ${ref}`,
      buyer_email_address: clean(buyer.email, 254),
      shipping_address: address,
      billing_address: address,
    });
    return json({ ok: true, ref, orderId: created.order.id, total: totalMoney.amount / 100, receiptUrl: (paid.payment && paid.payment.receipt_url) || null }, 200, cors);
  } catch (err) {
    const code = err.squareErrors && err.squareErrors[0] && err.squareErrors[0].code;
    console.log('pay failed', code || '', err.message);
    if (err.status && err.status < 500 && CARD_MESSAGES[code]) return json({ error: CARD_MESSAGES[code] }, 402, cors);
    return json({ error: 'The payment did not go through. Please try again, or contact the shop.' }, 502, cors);
  }
}

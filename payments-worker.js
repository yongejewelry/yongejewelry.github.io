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
// Receipts (optional). Square does not send receipts for website payments, so this Worker does,
// right after a payment goes through. Leave these out and payments still work, just without receipts.
//   Email receipt, sent with Resend (resend.com):
//     RESEND_API_KEY      Secret  your Resend API key
//     RECEIPT_FROM        Text    the sender, e.g. Yonge Jewelry <receipts@yongejewelry.com> (a domain verified in Resend)
//     SHOP_EMAIL          Text    optional: the shop's own inbox. Customers' replies go here, and it gets a copy of every receipt
//   Text receipt, sent with Twilio (twilio.com), only when the customer typed a phone number:
//     TWILIO_ACCOUNT_SID  Text    starts with AC
//     TWILIO_AUTH_TOKEN   Secret  your Twilio auth token
//     TWILIO_FROM         Text    your Twilio phone number, e.g. +18445550123
//
// Routes:
//   GET  /stock  -> { sold: { "<product id>": <units sold online> } }
//   POST /pay    -> charges the card token from Square's card form, records the order in Square, sends receipts

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(request.headers.get('Origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (path === '/stock' && request.method === 'GET') {
        return json({ sold: await soldCounts(env) }, 200, cors, 'public, max-age=15');
      }
      if (path === '/pay' && request.method === 'POST') return await pay(request, env, cors, ctx);
      if (path === '/') {
        return json({
          ok: true,
          service: 'Yonge Jewelry payments',
          environment: env.SQUARE_ENVIRONMENT || 'sandbox',
          emailReceipts: emailReady(env) ? 'on' : 'off',
          textReceipts: textReady(env) ? 'on' : 'off',
        }, 200, cors);
      }
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
  // The ?v= changes every minute so no cache in between can hand back an old price list.
  const res = await fetch(`${base}/products.json?v=${Math.floor(Date.now() / 60000)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`products.json returned ${res.status}`);
  const list = readCatalogue(await res.text());
  productCache = { at: Date.now(), byId: new Map(list.map((p) => [String(p.id), p])) };
  return productCache.byId;
}

// Same forgiving reading as the website: a stray or missing comma, "$1,250" as a price, "2" as a quantity.
function readCatalogue(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { raw = JSON.parse(String(text).replace(/,\s*([\]}])/g, '$1').replace(/}\s*{/g, '},{')); }
  if (!Array.isArray(raw)) throw new Error('products.json is not a list');
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const id = parseInt(p.id, 10);
    if (!(id > 0) || seen.has(id)) continue;
    seen.add(id);
    let price = typeof p.price === 'string' ? p.price.replace(/[^\d.]/g, '') : p.price;
    price = price === null || price === '' || price === undefined || isNaN(+price) ? null : Math.round(+price * 100) / 100;
    const qty = parseInt(p.qty, 10);
    out.push({ id, name: String(p.name || `Piece #${id}`).trim(), category: String(p.category || '').trim(), material: String(p.material || '').trim(), qty: isNaN(qty) ? 1 : Math.max(0, qty), price });
  }
  return out;
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

async function pay(request, env, cors, ctx) {
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
    const payment = paid.payment || {};

    // The card has been charged. From here nothing may turn this into an error for the customer.
    // Receipts go out after the reply, so a slow or failed email or text never holds up a payment.
    const receipts = { email: null, text: null };
    try {
      const receipt = receiptData({ ref, order: created.order, payment, lines, shipping, subtotal, buyer, country, province });
      const phone = toE164(buyer.phone, country);
      const jobs = [];
      if (emailReady(env)) {
        jobs.push(sendEmail(env, receipt).catch((e) => console.log('email receipt failed', e.message)));
        receipts.email = receipt.email;
      }
      if (textReady(env) && phone) {
        jobs.push(sendText(env, phone, receipt).catch((e) => console.log('text receipt failed', e.message)));
        receipts.text = clean(buyer.phone, 30);
      }
      if (jobs.length) {
        const all = Promise.all(jobs);
        if (ctx && ctx.waitUntil) ctx.waitUntil(all); else await all;
      }
    } catch (e) {
      console.log('receipts skipped', e.message);
    }

    return json({
      ok: true,
      ref,
      orderId: created.order.id,
      total: totalMoney.amount / 100,
      receiptUrl: payment.receipt_url || null,
      receipts,
    }, 200, cors);
  } catch (err) {
    const code = err.squareErrors && err.squareErrors[0] && err.squareErrors[0].code;
    console.log('pay failed', code || '', err.message);
    if (err.status && err.status < 500 && CARD_MESSAGES[code]) return json({ error: CARD_MESSAGES[code] }, 402, cors);
    return json({ error: 'The payment did not go through. Please try again, or contact the shop.' }, 502, cors);
  }
}

// ---------- receipts ----------

const SHOP = { name: 'Yonge Jewelry', street: '29 St Andrew St, Unit B', area: 'Kensington Market, Toronto, ON', phone: '437-212-6273' };
const MATERIAL = {
  '925 Silver': '925 silver', '925 Silver & 18K Vermeil': '925 silver, 18k gold vermeil',
  '925 Silver & 18K Rose Gold Vermeil': '925 silver, 18k rose gold vermeil', '18K Gold Vermeil': '18k gold vermeil',
  'Surgical Steel': 'Surgical steel', 'Surgical Steel & 18K Vermeil': 'Surgical steel, 18k gold vermeil', 'Fine Jewelry': 'Fine jewelry',
};
const COUNTRY = {
  CA: 'Canada', US: 'United States', AT: 'Austria', BE: 'Belgium', DK: 'Denmark', FI: 'Finland', FR: 'France', DE: 'Germany', GR: 'Greece',
  IE: 'Ireland', IT: 'Italy', NL: 'Netherlands', NO: 'Norway', PL: 'Poland', PT: 'Portugal', ES: 'Spain', SE: 'Sweden', CH: 'Switzerland', GB: 'United Kingdom',
};
const CALLING_CODE = {
  CA: '1', US: '1', AT: '43', BE: '32', DK: '45', FI: '358', FR: '33', DE: '49', GR: '30', IE: '353', IT: '39',
  NL: '31', NO: '47', PL: '48', PT: '351', ES: '34', SE: '46', CH: '41', GB: '44',
};
const CARD_BRAND = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMERICAN_EXPRESS: 'American Express', DISCOVER: 'Discover', DISCOVER_DINERS: 'Diners Club', JCB: 'JCB', CHINA_UNIONPAY: 'UnionPay', INTERAC: 'Interac' };

const emailReady = (env) => !!(env.RESEND_API_KEY && env.RECEIPT_FROM);
const textReady = (env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
const money = (amountCents) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: CURRENCY }).format(amountCents / 100);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A phone number as typed ("416 555 0100", "(416) 555-0100", "+44 7700 900123") in the +15555550100 form texts need.
function toE164(raw, country) {
  const typed = String(raw == null ? '' : raw).trim();
  if (!typed) return null;
  let digits = typed.replace(/\D/g, '');
  const ok = (d) => (d.length >= 8 && d.length <= 15 ? '+' + d : null);
  if (typed.startsWith('+')) return ok(digits);
  if (digits.startsWith('00')) return ok(digits.slice(2));
  const code = CALLING_CODE[country] || '1';
  if (code === '1') {
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
    return null;
  }
  if (country !== 'IT') digits = digits.replace(/^0/, '');
  return ok(code + digits);
}

function receiptData({ ref, order, payment, lines, shipping, subtotal, buyer, country, province }) {
  const name = clean(buyer.name, 120);
  const card = payment.card_details && payment.card_details.card;
  const total = (payment.total_money || payment.amount_money || order.total_money).amount;
  const region = clean(buyer.region, 100);
  let when = '';
  try {
    when = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'long', timeStyle: 'short' }).format(new Date(payment.created_at || Date.now()));
  } catch (e) { when = new Date().toUTCString(); }
  return {
    ref,
    when,
    name,
    first: name.split(/\s+/)[0] || '',
    email: clean(buyer.email, 254),
    items: lines.map(({ product, qty }) => ({
      name: product.name,
      detail: `#${product.id}` + (product.material ? ` · ${MATERIAL[product.material] || product.material}` : ''),
      qty,
      line: cents(product.price) * qty,
    })),
    subtotal: cents(subtotal),
    shipping: cents(shipping),
    tax: country === 'CA' ? ((order.total_tax_money && order.total_tax_money.amount) || 0) : null,
    taxLabel: country === 'CA' ? `Tax (${PROV[province]}, ${+(TAX[province] * 100).toFixed(3)}%)` : null,
    total,
    card: card && card.last_4 ? `${CARD_BRAND[card.card_brand] || 'Card'} ending in ${card.last_4}` : null,
    shipTo: [name, clean(buyer.address, 200), [clean(buyer.city, 100), region].filter(Boolean).join(', ') + '  ' + clean(buyer.postal, 20), COUNTRY[country] || country]
      .map((s) => s.trim()).filter(Boolean),
    receiptUrl: payment.receipt_url || null,
  };
}

function totalsRows(r) {
  const rows = [['Subtotal', money(r.subtotal)], ['Shipping', r.shipping ? money(r.shipping) : 'Free']];
  if (r.taxLabel) rows.push([r.taxLabel, money(r.tax)]);
  return rows;
}

function emailText(r, canReply) {
  const out = [
    `Thank you${r.first ? ', ' + r.first : ''}.`,
    'Your order is confirmed and your payment has been received.',
    '',
    `Order ${r.ref}`,
    r.when,
    '',
    ...r.items.map((it) => `${it.qty} x ${it.name} (${it.detail})  ${money(it.line)}`),
    '',
    ...totalsRows(r).map(([k, v]) => `${k}: ${v}`),
    `Total paid: ${money(r.total)}`,
  ];
  if (r.card) out.push(`Paid with ${r.card}`);
  out.push('', 'Shipping to:', ...r.shipTo);
  if (r.receiptUrl) out.push('', `Square receipt: ${r.receiptUrl}`);
  out.push('', canReply ? `Questions? Reply to this email, or text or call us at ${SHOP.phone}.` : `Questions? Text or call us at ${SHOP.phone}.`);
  out.push('', `${SHOP.name}`, SHOP.street, SHOP.area);
  return out.join('\n');
}

function emailHtml(r, canReply) {
  const gold = '#a8834a', ink = '#1a1714', muted = '#6f675d', line = '#e7dfd3';
  const serif = "Georgia,'Times New Roman',serif", sans = "'Helvetica Neue',Helvetica,Arial,sans-serif";
  const cell = (html, style = '') => `<td style="padding:10px 0;border-bottom:1px solid ${line};font:15px/1.5 ${sans};color:${ink};${style}">${html}</td>`;
  const items = r.items.map((it) => `<tr>${cell(`${esc(it.name)}<br><span style="color:${muted};font-size:13px">${esc(it.detail)} &middot; Qty ${it.qty}</span>`)}${cell(esc(money(it.line)), 'text-align:right;white-space:nowrap;vertical-align:top')}</tr>`).join('');
  const totals = totalsRows(r).map(([k, v]) => `<tr><td style="padding:4px 0;font:14px/1.5 ${sans};color:${muted}">${esc(k)}</td><td style="padding:4px 0;font:14px/1.5 ${sans};color:${ink};text-align:right">${esc(v)}</td></tr>`).join('');
  const button = r.receiptUrl
    ? `<tr><td style="padding:28px 0 4px"><a href="${esc(r.receiptUrl)}" style="display:inline-block;background:${ink};color:#f4ead8;text-decoration:none;font:600 12px/1 ${sans};letter-spacing:2px;text-transform:uppercase;padding:15px 26px">View your Square receipt</a></td></tr>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Yonge Jewelry receipt</title></head>
<body style="margin:0;padding:0;background:#f3eee6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3eee6"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff">
  <tr><td align="center" style="background:#0d0b09;padding:30px 20px">
    <div style="font:400 30px/1 ${serif};letter-spacing:6px;color:#f4ead8">YONGE</div>
    <div style="font:400 10px/1 ${sans};letter-spacing:7px;color:#c9a96e;padding-top:8px">JEWELRY</div>
  </td></tr>
  <tr><td style="padding:34px 32px 8px">
    <div style="font:600 11px/1 ${sans};letter-spacing:3px;color:${gold};text-transform:uppercase">Receipt</div>
    <h1 style="margin:12px 0 8px;font:400 30px/1.2 ${serif};color:${ink}">Thank you${r.first ? ', ' + esc(r.first) : ''}.</h1>
    <p style="margin:0;font:15px/1.6 ${sans};color:${muted}">Your order is confirmed and your payment has been received.</p>
    <p style="margin:18px 0 0;font:14px/1.6 ${sans};color:${ink}"><strong>Order ${esc(r.ref)}</strong><br><span style="color:${muted}">${esc(r.when)}</span></p>
  </td></tr>
  <tr><td style="padding:12px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${line}">${items}</table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px">${totals}
      <tr><td style="padding:10px 0 0;font:600 16px/1.5 ${sans};color:${ink};border-top:1px solid ${line}">Total paid</td><td style="padding:10px 0 0;font:600 16px/1.5 ${sans};color:${ink};text-align:right;border-top:1px solid ${line}">${esc(money(r.total))}</td></tr>
      ${r.card ? `<tr><td colspan="2" style="padding:4px 0 0;font:13px/1.5 ${sans};color:${muted}">Paid with ${esc(r.card)}</td></tr>` : ''}
    </table>
  </td></tr>
  <tr><td style="padding:26px 32px 0">
    <div style="font:600 11px/1 ${sans};letter-spacing:3px;color:${gold};text-transform:uppercase">Shipping to</div>
    <p style="margin:10px 0 0;font:15px/1.6 ${sans};color:${ink}">${r.shipTo.map(esc).join('<br>')}</p>
  </td></tr>
  <tr><td style="padding:0 32px"><table role="presentation" cellpadding="0" cellspacing="0">${button}</table></td></tr>
  <tr><td style="padding:28px 32px 34px">
    <p style="margin:0;font:14px/1.6 ${sans};color:${muted}">${canReply ? 'Questions? Reply to this email, or text or call us at ' : 'Questions? Text or call us at '}<a href="tel:+14372126273" style="color:${ink}">${SHOP.phone}</a>.</p>
  </td></tr>
  <tr><td align="center" style="background:#f8f5ef;padding:22px 20px;font:12px/1.7 ${sans};color:${muted}">
    ${SHOP.name}<br>${SHOP.street}<br>${SHOP.area}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function sendEmail(env, r) {
  const canReply = !!env.SHOP_EMAIL;
  const message = {
    from: env.RECEIPT_FROM,
    to: [r.email],
    subject: `Your Yonge Jewelry receipt, order ${r.ref}`,
    html: emailHtml(r, canReply),
    text: emailText(r, canReply),
  };
  if (canReply) {
    message.reply_to = env.SHOP_EMAIL;
    if (env.SHOP_EMAIL.toLowerCase() !== r.email.toLowerCase()) message.bcc = [env.SHOP_EMAIL];
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `receipt-${r.ref}` },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendText(env, to, r) {
  const body = `${SHOP.name}: Thank you${r.first ? ', ' + r.first : ''}! We received your payment of ${money(r.total)} for order ${r.ref}.`
    + (r.receiptUrl ? ` Receipt: ${r.receiptUrl}` : '')
    + ` Questions? Text or call ${SHOP.phone}.`;
  const from = String(env.TWILIO_FROM).trim();
  const form = new URLSearchParams({ To: to, Body: body });
  if (/^MG/i.test(from)) form.set('MessagingServiceSid', from);
  else form.set('From', toE164(from, 'CA') || from);
  const sid = String(env.TWILIO_ACCOUNT_SID).trim();
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${sid}:${String(env.TWILIO_AUTH_TOKEN).trim()}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

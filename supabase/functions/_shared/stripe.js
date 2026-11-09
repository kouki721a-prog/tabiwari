/* Stripe helpers shared by the Edge Functions. Plain ES module: runs on Deno and Node (tested in test/stripe.test.js). */

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/* Verify a Stripe-Signature header ("t=...,v1=...") against the raw request body. */
export async function verifyStripeSignature(payload, header, secret, nowMs = Date.now(), toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = header.split(',').map(p => p.split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1], sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]);
  if (!t || !sigs.length || Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + payload)));
  return sigs.some(s => same(s, mac));
}

/* Stripe subscription object -> subscriptions row. current_period_end moved onto items in newer API versions. */
export function subscriptionRow(sub, userId) {
  const end = sub.current_period_end != null ? sub.current_period_end : (sub.items && sub.items.data && sub.items.data[0] || {}).current_period_end;
  return {
    user_id: userId,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    status: sub.status,
    current_period_end: end != null ? new Date(end * 1000).toISOString() : null,
    cancel_at_period_end: !!(sub.cancel_at_period_end || sub.cancel_at),
    updated_at: new Date().toISOString()
  };
}

/* Stripe wants application/x-www-form-urlencoded with bracketed keys: {a:{b:1},c:[{d:2}]} -> a[b]=1&c[0][d]=2 */
export function form(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (typeof v === 'object') out.push(form(v, key)); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.filter(Boolean).join('&');
}

export async function stripe(secretKey, method, path, params) {
  const res = await fetch('https://api.stripe.com/v1' + path, {
    method, headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params ? form(params) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error('stripe: ' + ((json.error && json.error.message) || res.status));
  return json;
}

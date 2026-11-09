import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { verifyStripeSignature, subscriptionRow, form } from '../supabase/functions/_shared/stripe.js';
import { reminderMessage } from '../supabase/functions/_shared/messages.js';

const secret = 'whsec_test', body = '{"id":"evt_1"}', now = 1_800_000_000_000, t = now / 1000;
const sig = (ts, b = body, s = secret) => `t=${ts},v1=${createHmac('sha256', s).update(ts + '.' + b).digest('hex')}`;
assert.ok(await verifyStripeSignature(body, sig(t), secret, now));
assert.ok(await verifyStripeSignature(body, sig(t) + ',v1=deadbeef', secret, now), 'any matching v1 is enough');
assert.ok(!(await verifyStripeSignature(body + ' ', sig(t), secret, now)), 'tampered body');
assert.ok(!(await verifyStripeSignature(body, sig(t, body, 'other'), secret, now)), 'wrong secret');
assert.ok(!(await verifyStripeSignature(body, sig(t - 301), secret, now)), 'too old (replay)');
assert.ok(!(await verifyStripeSignature(body, '', secret, now)) && !(await verifyStripeSignature(body, sig(t), '', now)), 'missing header/secret');

const sub = { id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1_900_000_000, cancel_at_period_end: false };
let r = subscriptionRow(sub, 'U1');
assert.deepStrictEqual([r.user_id, r.stripe_customer_id, r.stripe_subscription_id, r.status, r.current_period_end, r.cancel_at_period_end], ['U1', 'cus_1', 'sub_1', 'active', new Date(1_900_000_000_000).toISOString(), false]);
r = subscriptionRow({ id: 's', customer: { id: 'cus_2' }, status: 'trialing', items: { data: [{ current_period_end: 1_900_000_000 }] }, cancel_at: 1_900_000_000 }, 'U2');
assert.strictEqual(r.stripe_customer_id, 'cus_2'); assert.strictEqual(r.current_period_end, new Date(1_900_000_000_000).toISOString()); assert.strictEqual(r.cancel_at_period_end, true);

assert.strictEqual(form({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], subscription_data: { metadata: { user_id: 'u' } }, x: undefined, locale: 'ja' }),
  'mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&subscription_data%5Bmetadata%5D%5Buser_id%5D=u&locale=ja');

assert.match(reminderMessage('eve', '箱根').title, /明日/); assert.match(reminderMessage('daily', '箱根').body, /箱根/);
assert.match(reminderMessage('settle', '箱根').title, /精算/); assert.strictEqual(reminderMessage('nope', 'x'), null);
console.log('stripe tests passed');

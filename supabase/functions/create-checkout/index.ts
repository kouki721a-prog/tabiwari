// Signed-in user -> Stripe Checkout URL for the premium subscription.
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, SITE_URL (e.g. https://tabiwari.example.com, no trailing slash).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { stripe } from '../_shared/stripe.js';
import { cors, json } from '../_shared/http.js';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('STRIPE_SECRET_KEY')!, site = Deno.env.get('SITE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'not_signed_in' }, 401);

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: row } = await db.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle();
  if (row && ['active', 'trialing', 'past_due'].includes(row.status) && !row.cancel_at_period_end) return json({ error: 'already_subscribed' }, 409);

  let customer = row?.stripe_customer_id;
  if (!customer) {
    const c = await stripe(key, 'POST', '/customers', { email: user.email, metadata: { user_id: user.id } });
    customer = c.id;
    await db.from('subscriptions').insert({ user_id: user.id, stripe_customer_id: customer, status: 'incomplete' });
  }
  const s = await stripe(key, 'POST', '/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: user.id, locale: 'ja', allow_promotion_codes: true,
    line_items: [{ price: Deno.env.get('STRIPE_PRICE_ID')!, quantity: 1 }],
    subscription_data: { metadata: { user_id: user.id } },
    success_url: site + '/?billing=success', cancel_url: site + '/?billing=cancel'
  });
  return json({ url: s.url });
});

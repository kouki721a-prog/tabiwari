// Signed-in subscriber -> Stripe Customer Portal URL (change card, cancel, receipts).
// Secrets: STRIPE_SECRET_KEY, SITE_URL.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { stripe } from '../_shared/stripe.js';
import { cors, json } from '../_shared/http.js';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = Deno.env.get('SUPABASE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: 'not_signed_in' }, 401);
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: row } = await db.from('subscriptions').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
  if (!row) return json({ error: 'no_subscription' }, 404);
  const s = await stripe(Deno.env.get('STRIPE_SECRET_KEY')!, 'POST', '/billing_portal/sessions', { customer: row.stripe_customer_id, return_url: Deno.env.get('SITE_URL')! + '/?billing=return' });
  return json({ url: s.url });
});

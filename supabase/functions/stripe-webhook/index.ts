// Stripe -> subscriptions table. Deploy with --no-verify-jwt (Stripe signs the request instead).
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyStripeSignature, subscriptionRow, stripe } from '../_shared/stripe.js';

Deno.serve(async (req: Request) => {
  const body = await req.text();
  if (!(await verifyStripeSignature(body, req.headers.get('stripe-signature') ?? '', Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''))) {
    return new Response('bad signature', { status: 400 });
  }
  const ev = JSON.parse(body), obj = ev.data.object;
  let subId: string | null = null;
  if (typeof ev.type === 'string' && ev.type.startsWith('customer.subscription.')) subId = obj.id;
  else if (ev.type === 'checkout.session.completed' && obj.mode === 'subscription') subId = obj.subscription;
  if (!subId) return new Response('ignored', { status: 200 });

  // Always re-read the subscription: events can arrive out of order, the API gives the current truth.
  const sub = await stripe(Deno.env.get('STRIPE_SECRET_KEY')!, 'GET', '/subscriptions/' + subId);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let userId: string | undefined = sub.metadata?.user_id ?? obj.client_reference_id;
  if (!userId) {
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const { data } = await db.from('subscriptions').select('user_id').eq('stripe_customer_id', customer).maybeSingle();
    userId = data?.user_id;
  }
  if (!userId) return new Response('no user for subscription', { status: 200 });   // not ours; do not make Stripe retry
  const { error } = await db.from('subscriptions').upsert(subscriptionRow(sub, userId), { onConflict: 'user_id' });
  if (error) return new Response(error.message, { status: 500 });                  // let Stripe retry
  return new Response('ok', { status: 200 });
});

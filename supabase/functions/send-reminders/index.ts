// Hourly job (see docs/SETUP.md for the pg_cron schedule). Deploy with --no-verify-jwt; it checks CRON_SECRET itself.
// Secrets: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com).
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { reminderMessage } from '../_shared/messages.js';

Deno.serve(async (req: Request) => {
  if (req.headers.get('Authorization') !== 'Bearer ' + Deno.env.get('CRON_SECRET')) return new Response('unauthorized', { status: 401 });
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await db.rpc('claim_notifications');
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0, dropped = 0, failed = 0;
  for (const r of data as any[]) {
    const m = reminderMessage(r.kind, r.trip_name); if (!m) continue;
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        JSON.stringify({ ...m, url: './', tag: r.kind + '-' + r.trip_id }), { TTL: 6 * 3600 });
      sent++;
    } catch (e: any) {
      if (e.statusCode === 404 || e.statusCode === 410) { await db.rpc('drop_push_endpoint', { p_endpoint: r.endpoint }); dropped++; } else failed++;
    }
  }
  return new Response(JSON.stringify({ claimed: data.length, sent, dropped, failed }), { headers: { 'Content-Type': 'application/json' } });
});

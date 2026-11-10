/* Small helpers shared by the Worker modules. */
export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
export const b64u = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export const randomToken = bytes => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
export const reply = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });

/* Counts a hit for (bucket, caller IP) in D1; true when the caller is over `limit` within the window. The IP is stored only as a short hash. */
export async function limited(env, req, bucket, limit, windowSec) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const k = bucket + ':' + (await sha256hex(ip)).slice(0, 16), now = Math.floor(Date.now() / 1000), w = Math.floor(now / windowSec);
  const r = await env.DB.prepare('INSERT INTO hits(k,w,n,t) VALUES (?1,?2,1,?3) ON CONFLICT(k,w) DO UPDATE SET n=n+1, t=?3 RETURNING n').bind(k, w, now).first();
  return r.n > limit;
}

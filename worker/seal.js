/* AES-GCM sealing with a key derived (HKDF) from the AUTH_SECRET secret. `aad` binds a sealed value to what it belongs to. */
import { b64u, unb64u } from './util.js';

async function aesKey(env) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('tabiwari-backup'), info: new TextEncoder().encode('v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(env, aad, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(env), new TextEncoder().encode(JSON.stringify(obj)));
  return b64u(iv) + '.' + b64u(ct);
}
export async function open(env, aad, data) {
  const [iv, ct] = data.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: new TextEncoder().encode(aad) }, await aesKey(env), unb64u(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ─── Plantis Push Worker (Cloudflare) ────────────────────────────────────────
// Deploy this as a Cloudflare Worker.
// Set these environment variables in the Worker settings (not hardcoded):
//
//   VAPID_PUBLIC_KEY   → your VAPID public key
//   VAPID_PRIVATE_KEY  → your VAPID private key
//   FIREBASE_URL       → https://plantis-5934a-default-rtdb.europe-west1.firebasedatabase.app
//   VAPID_SUBJECT      → mailto:deine@email.com
//
// Schedule: Add a Cron Trigger in Cloudflare → "0 8 * * *" (täglich 8 Uhr UTC)

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyCheck(env));
  },
  // Also allow manual trigger via GET for testing
  async fetch(request, env, ctx) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/subscribe') {
      return handleSubscribe(request, env);
    }
    if (request.method === 'GET' && new URL(request.url).pathname === '/test') {
      await runDailyCheck(env);
      return new Response('Push triggered', {status: 200});
    }
    return new Response('Plantis Push Worker', {status: 200, headers: corsHeaders()});
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

// ─── Store subscription ───────────────────────────────────────────────────────
async function handleSubscribe(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {status: 204, headers: corsHeaders()});
  }
  try {
    const body = await request.json();
    const { subscription, userId } = body;
    if (!subscription || !userId) {
      return new Response(JSON.stringify({error:'Missing subscription or userId'}), {status:400, headers:corsHeaders()});
    }
    // Store subscription in Firebase
    const url = `${env.FIREBASE_URL}/subscriptions/${userId}.json`;
    const r = await fetch(url, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ subscription, updatedAt: new Date().toISOString() })
    });
    if (!r.ok) throw new Error('Firebase write failed');
    return new Response(JSON.stringify({ok:true}), {status:200, headers:corsHeaders()});
  } catch(e) {
    return new Response(JSON.stringify({error:e.message}), {status:500, headers:corsHeaders()});
  }
}

// ─── Daily check: fetch all plants, push to subscribers who have plants needing water ──
async function runDailyCheck(env) {
  // 1. Get all plants from Firebase
  const plantsRes = await fetch(`${env.FIREBASE_URL}/pflanzen.json`);
  if (!plantsRes.ok) return;
  const plantsData = await plantsRes.json();
  if (!plantsData) return;

  const plants = Object.values(plantsData);
  const needsWater = plants.filter(p => {
    if (!p.watered) return true;
    const daysSince = Math.floor((Date.now() - new Date(p.watered)) / 86400000);
    return daysSince >= (p.interval || 7);
  });

  if (!needsWater.length) return;

  // 2. Get all push subscriptions
  const subsRes = await fetch(`${env.FIREBASE_URL}/subscriptions.json`);
  if (!subsRes.ok) return;
  const subsData = await subsRes.json();
  if (!subsData) return;

  const names = needsWater.map(p => p.name).join(', ');
  const body = needsWater.length === 1
    ? `${names} braucht heute Wasser 💧`
    : `${needsWater.length} Pflanzen brauchen Wasser: ${names}`;

  const payload = JSON.stringify({
    title: '🌿 Plantis – Giessen nicht vergessen!',
    body,
    tag: 'plantis-water'
  });

  // 3. Send push to all subscriptions
  const sends = Object.values(subsData).map(({ subscription }) =>
    sendPush(env, subscription, payload)
  );
  await Promise.allSettled(sends);
}

// ─── VAPID Web Push ───────────────────────────────────────────────────────────
async function sendPush(env, subscription, payload) {
  const { endpoint, keys } = subscription;
  const { p256dh, auth } = keys;

  const vapidHeaders = await buildVapidHeaders(env, endpoint);
  const encrypted = await encryptPayload(payload, p256dh, auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      ...encrypted.headers
    },
    body: encrypted.body
  });

  return res.status;
}

async function buildVapidHeaders(env, endpoint) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({typ:'JWT',alg:'ES256'}));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: now + 43200,
    sub: env.VAPID_SUBJECT
  }));

  const signingInput = `${header}.${claims}`;
  const key = await importVapidKey(env.VAPID_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    {name:'ECDSA', hash:'SHA-256'},
    key,
    new TextEncoder().encode(signingInput)
  );

  const token = `${signingInput}.${b64url(sig)}`;
  return {
    'Authorization': `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`
  };
}

async function importVapidKey(privateKeyB64) {
  const raw = b64decode(privateKeyB64);
  return crypto.subtle.importKey(
    'pkcs8', raw,
    {name:'ECDSA', namedCurve:'P-256'},
    false, ['sign']
  );
}

// ─── Payload Encryption (aes128gcm) ──────────────────────────────────────────
async function encryptPayload(payload, p256dhB64, authB64) {
  const p256dh = b64decode(p256dhB64);
  const auth = b64decode(authB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Server key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    {name:'ECDH', namedCurve:'P-256'}, true, ['deriveKey','deriveBits']
  );
  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'raw', p256dh, {name:'ECDH', namedCurve:'P-256'}, false, []
  );

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    {name:'ECDH', public: clientPublicKey}, serverKeyPair.privateKey, 256
  );

  // HKDF to derive content encryption key and nonce
  const prk = await hkdf(auth, sharedBits, concat(
    new TextEncoder().encode('WebPush: info\x00'),
    clientPublicKey && p256dh,
    serverPublicKeyRaw
  ), 32);

  const cek = await hkdf(salt, prk, new TextEncoder().encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, prk, new TextEncoder().encode('Content-Encoding: nonce\x00'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = new TextEncoder().encode(payload);
  const padded = concat(data, new Uint8Array([2])); // padding delimiter

  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce}, key, padded);

  // Build aes128gcm content (salt + rs + keyid_len + keyid + ciphertext)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const keyid = new Uint8Array(serverPublicKeyRaw);
  const keyidLen = new Uint8Array([keyid.length]);
  const body = concat(salt, rs, keyidLen, keyid, new Uint8Array(ciphertext));

  return { body, headers: {} };
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const prk = await crypto.subtle.sign('HMAC', saltKey, ikm);
  const prkKey = await crypto.subtle.importKey('raw', prk, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const t = await crypto.subtle.sign('HMAC', prkKey, concat(info, new Uint8Array([1])));
  return new Uint8Array(t).slice(0, length);
}

function concat(...arrays) {
  const arrays2 = arrays.map(a => a instanceof ArrayBuffer ? new Uint8Array(a) : a);
  const total = arrays2.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays2) { out.set(a, offset); offset += a.length; }
  return out;
}

function b64url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function b64decode(str) {
  const s = str.replace(/-/g,'+').replace(/_/g,'/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

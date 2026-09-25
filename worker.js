const AD_TOKEN_TTL_MS = 5 * 60 * 1000;
const MIN_AD_DURATION_MS = 10 * 1000;
const UNLOCK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_DAILY_AD_LIMIT = 15;

const adTokens = new Map();
let adRotation = 0;
let firebaseToken = null;
let firebaseTokenExp = 0;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra }
  });
}

function b64url(input) {
  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input instanceof Uint8Array) bytes = input;
  else bytes = new TextEncoder().encode(String(input));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function parseFirebaseKey(env) {
  if (!env.FIREBASE_KEY) throw new Error('FIREBASE_KEY is missing');
  let raw = env.FIREBASE_KEY;
  try { raw = JSON.parse(raw); } catch { throw new Error('FIREBASE_KEY is not valid JSON'); }
  if (!raw.project_id || !raw.client_email || !raw.private_key) throw new Error('FIREBASE_KEY is missing required service-account fields');
  return raw;
}

async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (firebaseToken && firebaseTokenExp > now + 60) return firebaseToken;
  const sa = parseFirebaseKey(env);
  const pem = sa.private_key.replace(/\\n/g, '\n');
  const body = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const toBytes = (v) => new TextEncoder().encode(v);
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', fromB64url(b64url(Uint8Array.from(atob(pemBody), c => c.charCodeAt(0)))), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const unsigned = `${b64url(JSON.stringify(body))}.${b64url(JSON.stringify(claim))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, toBytes(unsigned));
  const assertion = `${unsigned}.${b64url(sig)}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!r.ok) throw new Error(`Google auth failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  firebaseToken = data.access_token;
  firebaseTokenExp = now + Number(data.expires_in || 3600);
  return firebaseToken;
}

function fsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, x] of Object.entries(v)) fields[k] = fsValue(x);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function jsValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(jsValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, jsValue(x)]));
  return null;
}

function decodeDoc(doc) {
  return Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, jsValue(v)]));
}

async function fsRequest(env, path, init = {}) {
  const sa = parseFirebaseKey(env);
  const token = await googleAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/databases/(default)/documents/${path}`;
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  headers.set('content-type', 'application/json');
  const r = await fetch(url, { ...init, headers });
  if (r.status === 401) { firebaseToken = null; firebaseTokenExp = 0; }
  return r;
}

async function getDoc(env, collection, id) {
  const r = await fsRequest(env, `${collection}/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function patchDoc(env, collection, id, fields) {
  const r = await fsRequest(env, `${collection}/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fsValue(v)])) })
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${r.status}: ${await r.text()}`);
  return r.json();
}

async function listTopics(env) {
  const all = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await fsRequest(env, `topics?${q}`);
    if (!r.ok) throw new Error(`Firestore topics ${r.status}: ${await r.text()}`);
    const data = await r.json();
    for (const d of data.documents || []) all.push({ id: d.name.split('/').pop(), ...decodeDoc(d) });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  all.sort((a, b) => {
    const ao = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : new Date(a.createdAt || 0).getTime();
    const bo = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : new Date(b.createdAt || 0).getTime();
    return bo - ao;
  });
  return all;
}

async function dailyLimit(env) {
  try {
    const d = await getDoc(env, 'system', 'settings');
    const n = d ? Number(decodeDoc(d).dailyAdLimit) : DEFAULT_DAILY_AD_LIMIT;
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_AD_LIMIT;
  } catch { return DEFAULT_DAILY_AD_LIMIT; }
}

async function telegram(env, method, body) {
  if (!env.BOT_TOKEN) throw new Error('BOT_TOKEN is missing');
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

function cleanupTokens() {
  const now = Date.now();
  for (const [token, v] of adTokens) if (now - v.createdAt > AD_TOKEN_TTL_MS) adTokens.delete(token);
}

function tokenString() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

function userIdFromRequest(req) {
  const raw = new URL(req.url).searchParams.get('userId');
  return raw ? String(raw) : '';
}

function unlockedInfo(data, now = Date.now()) {
  const topics = Array.isArray(data.unlockedTopics) ? data.unlockedTopics : [];
  const times = data.topicUnlockTime && typeof data.topicUnlockTime === 'object' ? data.topicUnlockTime : {};
  const active = [];
  const expiresAt = {};
  for (const id of topics) {
    const t = Number(times[id]) || 0;
    if (t > 0 && now - t < UNLOCK_TTL_MS) {
      active.push(id); expiresAt[id] = t + UNLOCK_TTL_MS;
    }
  }
  return { active, expiresAt };
}

async function handleApi(req, env, path) {
  if (req.method === 'GET' && path === '/api/topics') {
    const topics = await listTopics(env);
    const cards = topics.map(({ videos, ...topic }) => ({ ...topic, videoCount: topic.videoCount || (Array.isArray(videos) ? videos.length : 0) }));
    return json(cards, 200, { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' });
  }

  const topicMatch = path.match(/^\/api\/topic\/([^/]+)$/);
  if (req.method === 'GET' && topicMatch) {
    const d = await getDoc(env, 'topics', decodeURIComponent(topicMatch[1]));
    if (!d) return json({ error: 'Topic not found' }, 404);
    const topic = { id: topicMatch[1], ...decodeDoc(d) };
    delete topic.videos;
    topic.videoCount = topic.videoCount || (Array.isArray(decodeDoc(d).videos) ? decodeDoc(d).videos.length : 0);
    return json(topic, 200, { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' });
  }

  const verifyMatch = path.match(/^\/api\/users\/verify\/([^/]+)$/);
  if (req.method === 'GET' && verifyMatch) {
    const d = await getDoc(env, 'users', decodeURIComponent(verifyMatch[1]));
    if (!d) return json({ verified: false, exists: false });
    const data = decodeDoc(d);
    return json({ verified: data.verified || false, exists: true, username: data.username, firstName: data.firstName });
  }

  const unlockedMatch = path.match(/^\/api\/user-unlocked\/([^/]+)$/);
  if (req.method === 'GET' && unlockedMatch) {
    const uid = decodeURIComponent(unlockedMatch[1]);
    const d = await getDoc(env, 'users', uid);
    const data = d ? decodeDoc(d) : {};
    const info = unlockedInfo(data);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const dailyUsed = data.dailyAdDate === today ? Number(data.dailyAdsUsed) || 0 : 0;
    return json({ topics: info.active, expiresAt: info.expiresAt, history: Array.isArray(data.watchedTopicIds) ? data.watchedTopicIds : [], adProgress: data.adProgress || {}, dailyUsed, dailyLimit: await dailyLimit(env) });
  }

  const thumbMatch = path.match(/^\/api\/thumbnail\/(.+)$/);
  if (req.method === 'GET' && thumbMatch) {
    try {
      const fileId = decodeURIComponent(thumbMatch[1]);
      const file = await telegram(env, 'getFile', { file_id: fileId });
      const upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
      if (!upstream.ok) return json({ error: 'Thumbnail not found' }, 404);
      const headers = new Headers({ 'cache-control': 'public, max-age=604800, immutable' });
      headers.set('content-type', upstream.headers.get('content-type') || 'image/jpeg');
      return new Response(upstream.body, { status: 200, headers });
    } catch { return json({ error: 'Thumbnail not found' }, 404); }
  }

  if (req.method === 'POST' && path === '/api/ad-start') {
    const body = await req.json().catch(() => ({}));
    if (!body.userId || !body.topicId) return json({ success: false, error: 'Missing userId/topicId' }, 400);
    cleanupTokens();
    const token = tokenString();
    adTokens.set(token, { userId: String(body.userId), topicId: String(body.topicId), createdAt: Date.now() });
    adRotation++;
    return json({ success: true, token, network: adRotation % 2 ? 'monetag' : 'onclicka' });
  }

  if (req.method === 'POST' && path === '/api/ad-complete') {
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || '');
    const t = adTokens.get(token);
    if (!t) return json({ success: false, error: 'Ad token expired. আবার Ad দেখুন।' }, 400);
    adTokens.delete(token);
    if (t.userId !== String(body.userId) || t.topicId !== String(body.topicId)) return json({ success: false, error: 'Invalid ad token' }, 400);
    if (Date.now() - t.createdAt < MIN_AD_DURATION_MS) return json({ success: false, error: 'Ad খুব দ্রুত শেষ হয়েছে। আবার দেখুন।' }, 400);

    const uid = String(body.userId);
    const topicId = String(body.topicId);
    const td = await getDoc(env, 'topics', topicId);
    if (!td) return json({ success: false, error: 'Topic not found' }, 404);
    const topic = decodeDoc(td);
    const required = Math.max(1, Number(topic.adsRequired) || 1);
    const userDoc = await getDoc(env, 'users', uid);
    const data = userDoc ? decodeDoc(userDoc) : {};
    if (data.blocked === true) return json({ success: false, blocked: true, error: 'আপনাকে ব্যবহার থেকে ব্লক করা হয়েছে।' }, 403);

    const now = Date.now();
    const info = unlockedInfo(data, now);
    const unlockedAlready = info.active.includes(topicId);
    const progress = { ...(data.adProgress || {}) };
    let count = Number(progress[topicId]) || 0;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const used = data.dailyAdDate === today ? Number(data.dailyAdsUsed) || 0 : 0;
    const limit = await dailyLimit(env);
    if (unlockedAlready) return json({ success: true, count: required, required, unlocked: true, dailyUsed: used });
    if (used >= limit) return json({ success: false, limitReached: true, dailyLimit: limit, dailyUsed: used, error: 'আজকের Ad Limit শেষ' }, 429);

    count = Math.min(required, count + 1);
    progress[topicId] = count;
    const write = { adProgress: progress, dailyAdDate: today, dailyAdsUsed: used + 1 };
    let unlocked = count >= required;
    if (unlocked) {
      const unlockedTopics = Array.isArray(data.unlockedTopics) ? data.unlockedTopics.filter(x => x !== topicId) : [];
      unlockedTopics.push(topicId);
      const times = { ...(data.topicUnlockTime || {}) };
      times[topicId] = now;
      const history = Array.isArray(data.watchedTopicIds) ? data.watchedTopicIds.filter(x => x !== topicId) : [];
      history.push(topicId);
      write.unlockedTopics = unlockedTopics;
      write.topicUnlockTime = times;
      write.watchedTopicIds = history.slice(-300);
      delete write.adProgress;
    }
    await patchDoc(env, 'users', uid, write);

    if (!unlocked) return json({ success: true, count, required, unlocked: false });

    const videos = Array.isArray(topic.videos) ? topic.videos : (topic.videoId ? [topic.videoId] : []);
    let delivered = 0;
    let notStarted = false;
    for (const fileId of videos) {
      try {
        await telegram(env, 'sendVideo', { chat_id: uid, video: fileId, protect_content: true, caption: '⏳ এই ভিডিও ৩০ মিনিট পর ডিলিট হয়ে যাবে।' });
        delivered++;
      } catch (e) {
        if (/chat not found|user is deactivated|bot was blocked/i.test(e.message || '')) notStarted = true;
      }
    }
    if (!delivered && notStarted && env.BOT_USERNAME) {
      return json({ success: true, count, required, unlocked: true, directDelivered: false, requiresStart: true, startUrl: `https://t.me/${String(env.BOT_USERNAME).replace(/^@/, '')}?start=unlock_${encodeURIComponent(topicId)}` });
    }
    return json({ success: true, count, required, unlocked: true, directDelivered: delivered > 0, requiresStart: !!env.BOT_USERNAME, startUrl: env.BOT_USERNAME ? `https://t.me/${String(env.BOT_USERNAME).replace(/^@/, '')}` : undefined });
  }

  if (req.method === 'GET' && path === '/health') return json({ ok: true, service: 'telegram-bot-worker', time: new Date().toISOString() });
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
        const result = await handleApi(req, env, url.pathname);
        if (result) return result;
      }
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      if (url.pathname.startsWith('/api/')) return json({ error: 'Server error', detail: e.message }, 500);
      return new Response('Server error', { status: 500 });
    }
  }
};

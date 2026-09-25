const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const cron = require('node-cron');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new Telegraf(process.env.BOT_TOKEN);

// 🛡️ Telegram rejects an entire callback request with "inline keyboard
// button text must be encoded in UTF-8" the moment ANY button's text
// contains a lone (unpaired) UTF-16 surrogate. That happens whenever plain
// `.slice(0, N)` truncates a string exactly through the middle of a
// surrogate pair — most commonly an emoji inside a channel name, a custom
// button name, a user's Telegram display name, a post caption, or a video
// title (all free text admins/users can type, and Telegram display names in
// particular are full of emoji). `.slice()` counts raw UTF-16 code units, so
// it happily cuts a pair in half; this truncates on a whole-code-point
// boundary instead, and also scrubs any stray lone surrogate that may
// already be sitting in the string (e.g. from data saved before this fix).
function safeTruncate(value, maxLen) {
  const str = String(value == null ? '' : value);
  // Array.from() splits by Unicode code point (surrogate pairs stay
  // together), unlike .slice()/.substring() which split by raw UTF-16 code
  // unit and can leave a lone surrogate dangling at the cut point.
  const chars = Array.from(str);
  const truncated = chars.length <= maxLen ? str : chars.slice(0, maxLen).join('');
  // Defensive scrub: strip any lone surrogate left anywhere in the string
  // (e.g. already-corrupted data from before this fix), since a single
  // unpaired surrogate has no valid UTF-8 encoding and is exactly what
  // triggers Telegram's "must be encoded in UTF-8" error.
  return truncated.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// 🚫 NEVER process posts coming from Telegram channels.
// The bot should only process user/private/group updates. This guard is the
// final protection against Public Posting Channel media being copied to
// STORAGE_CHANNEL.
bot.use(async (ctx, next) => {
  if (ctx.updateType === 'channel_post' || ctx.updateType === 'edited_channel_post') {
    return;
  }
  return next();
});

// ✅ .env থেকে Firebase JSON ব্যবহার করুন
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// =============================================
// 🛡️ GLOBAL ERROR HANDLERS (must-have)
// =============================================

// ✅ 1) Telegraf-এর সর্বোচ্চ error handler
// এইটা না থাকলে এক user-এর error পুরো polling থামিয়ে দিতে পারে
bot.catch((err, ctx) => {
  const msg = err && err.message ? err.message : String(err);
  const updateType = ctx && ctx.updateType ? ctx.updateType : 'unknown';
  console.error(`🚨 Bot error [${updateType}]:`, msg);

  // 403 = bot blocked by user → শুধু ignore
  if (/403|blocked by the user|user is deactivated|chat not found/i.test(msg)) {
    console.warn('⚠️ User blocked the bot — ignoring this update.');
    return;
  }
  // 429 = rate limit → কিছু সময় অপেক্ষা
  if (/429|Too Many Requests|retry after/i.test(msg)) {
    console.warn('⚠️ Rate limited by Telegram — will retry on next update.');
    return;
  }
  // অন্য কোনো error হলে log করি, কিন্তু bot চলুক
  // চাইলে এখানে admin-কে notify করতে পারেন
});

// ✅ 2) পুরো process-এ unhandled rejection crash আটকানো
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('🚨 Unhandled Rejection:', msg);
  if (/403|blocked by the user|chat not found|user is deactivated/i.test(msg)) {
    console.warn('⚠️ Blocked-user rejection ignored.');
    return;
  }
  // অন্য কিছু হলে process চালু রাখি
});

process.on('uncaughtException', (err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error('🚨 Uncaught Exception:', msg);
  if (/403|blocked by the user|chat not found|user is deactivated/i.test(msg)) {
    console.warn('⚠️ Blocked-user exception ignored.');
    return;
  }
  // অন্য error হলে process চালু রাখি যাতে পরের update handle হয়
});

// =============================================
// ✅ SAFE SEND HELPERS (403/429 gracefully handle)
// =============================================

function isBlockedError(err) {
  const msg = err && err.message ? err.message : String(err || '');
  return /403|blocked by the user|chat not found|user is deactivated|bot was kicked/i.test(msg);
}

async function safeSendMessage(chatId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(chatId, text, extra);
  } catch (err) {
    if (isBlockedError(err)) {
      console.warn(`⚠️ Skipped sendMessage to ${chatId} (blocked).`);
      return null;
    }
    throw err;
  }
}

async function safeSendPhoto(chatId, fileId, extra = {}) {
  try {
    return await bot.telegram.sendPhoto(chatId, fileId, extra);
  } catch (err) {
    if (isBlockedError(err)) {
      console.warn(`⚠️ Skipped sendPhoto to ${chatId} (blocked).`);
      return null;
    }
    throw err;
  }
}

async function safeSendVideo(chatId, fileId, extra = {}) {
  try {
    return await bot.telegram.sendVideo(chatId, fileId, extra);
  } catch (err) {
    if (isBlockedError(err)) {
      console.warn(`⚠️ Skipped sendVideo to ${chatId} (blocked).`);
      return null;
    }
    throw err;
  }
}

async function safeSendAnimation(chatId, fileId, extra = {}) {
  try {
    return await bot.telegram.sendAnimation(chatId, fileId, extra);
  } catch (err) {
    if (isBlockedError(err)) {
      console.warn(`⚠️ Skipped sendAnimation to ${chatId} (blocked).`);
      return null;
    }
    throw err;
  }
}

async function safeSendPoll(chatId, question, options, extra = {}) {
  try {
    return await bot.telegram.sendPoll(chatId, question, options, extra);
  } catch (err) {
    if (isBlockedError(err)) {
      console.warn(`⚠️ Skipped sendPoll to ${chatId} (blocked).`);
      return null;
    }
    throw err;
  }
}

async function safeDeleteMessage(chatId, messageId) {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
    return { ok: true, retryable: false };
  } catch (err) {
    // These errors mean there is nothing useful left to retry.
    if (isBlockedError(err)) return { ok: false, retryable: false };
    if (/message to delete not found|message can't be deleted|MESSAGE_ID_INVALID/i.test(err.message || '')) {
      return { ok: false, retryable: false };
    }
    console.warn(`⚠️ deleteMessage failed for ${chatId}/${messageId}: ${err.message}`);
    return { ok: false, retryable: true };
  }
}

// =============================================
// ⚡ PERFORMANCE / CACHE
// =============================================

const THIRTY_MINUTES = 30 * 60 * 1000;
// 🐛 FIX (THE main cost driver for accounts with lots of uploaded videos):
// getTopicsCached() reads the ENTIRE `topics` collection on every refresh —
// Firestore bills that as one read PER DOCUMENT, not one read per query. So
// with 100 topics/videos uploaded, every single refresh costs 100 reads, and
// that refresh was happening every 5 minutes (288x/day) = up to ~28,800
// reads/day just from this, completely independent of how many users are
// even using the app. It's safe to make this MUCH longer: every admin
// add/edit/delete/rename/thumbnail/ads-count action already calls
// invalidateTopicsCache() immediately (15 call sites), so the list is never
// actually stale after a real change — this TTL is only a fallback safety
// net for the rare case an invalidation call is somehow missed, not the
// real freshness mechanism. 1 hour cuts this cost ~12x with zero real
// staleness risk.
const TOPICS_CACHE_TTL = 60 * 60 * 1000;
const FILE_LINK_CACHE_TTL = 45 * 60 * 1000;
const DAILY_LIMIT_CACHE_TTL = 5 * 60 * 1000;
const DEFAULT_DAILY_AD_LIMIT = 15;
let topicsCache = null;
let topicsCacheAt = 0;
let topicsRefreshPromise = null;
const SINGLE_TOPIC_CACHE_TTL = 5 * 60 * 1000;
let singleTopicCache = new Map();
let singleTopicRefresh = new Map();
// Caches Telegram file-URL lookups (fileId -> CDN url), bounded so a
// long-running server doesn't accumulate one entry per file forever.
const FILE_LINK_CACHE_MAX = 800;
let fileLinkCache = new Map();
function capFileLinkCache() {
  if (fileLinkCache.size > FILE_LINK_CACHE_MAX) {
    fileLinkCache.delete(fileLinkCache.keys().next().value);
  }
}
// In-memory byte cache for thumbnails: once an image is fetched from Telegram
// once, we keep the actual bytes here so every later request (any user) is
// served instantly from our own server instead of round-tripping to
// Telegram's CDN again. Capped (true LRU — a cache hit refreshes the entry's
// position) so memory usage stays bounded while keeping hot thumbnails in.
const THUMB_BYTES_CACHE_MAX = 400;
let thumbBytesCache = new Map(); // fileId -> { buf, type }
function cacheThumbBytes(fileId, buf, type) {
  if (thumbBytesCache.has(fileId)) thumbBytesCache.delete(fileId);
  thumbBytesCache.set(fileId, { buf, type });
  if (thumbBytesCache.size > THUMB_BYTES_CACHE_MAX) {
    thumbBytesCache.delete(thumbBytesCache.keys().next().value);
  }
}
function getThumbBytesCached(fileId) {
  const hit = thumbBytesCache.get(fileId);
  if (hit) {
    // Refresh position so frequently-viewed thumbnails are the last to be evicted.
    thumbBytesCache.delete(fileId);
    thumbBytesCache.set(fileId, hit);
  }
  return hit;
}
// Telegram sends several resolutions for every photo. We used to keep the
// largest one as the "thumbnail", which meant every card in the mini app grid
// was downloading a full-size photo. This picks a size around ~480px wide —
// plenty sharp for a card thumbnail, but a fraction of the file size.
function pickThumbPhotoSize(sizes) {
  if (!Array.isArray(sizes) || !sizes.length) return null;
  const sorted = [...sizes].sort((a, b) => (a.width || 0) - (b.width || 0));
  return sorted.find(s => (s.width || 0) >= 480) || sorted[sorted.length - 1];
}
let dailyLimitCache = DEFAULT_DAILY_AD_LIMIT;
let dailyLimitCacheAt = 0;
let adCpmCache = 0;
let adCpmCacheAt = 0;
let cleanupRunning = false;
// 🐛 FIX (same duplicate-read cause as the startup-tasks fix below, but for
// the recurring crons): a losing/zombie instance (lost the Telegram
// getUpdates race — see the 409 Conflict fix near bot.launch()) used to keep
// running its OWN copies of every cron on schedule for as long as it stayed
// alive, in parallel with the real live instance's crons. Every cron below
// now checks this flag first and skips entirely if this process never
// actually became the live bot instance.
let botLaunched = false;
let adminStatsCache = null;
let adminStatsCacheAt = 0;
let adminUserCursor = null;
let adminUserPage = 0;
// getChannels() used to run a fresh `channels` collection query on EVERY
// call — and it's called from ~11 different admin-panel screens (opening
// the panel home, Channels menu, Create Post, Repost, viewing/editing a
// channel...), so just clicking around the admin panel repeatedly re-read
// the same short list of channels over and over. A short TTL cache (same
// pattern as topicsCache/dailyLimitCache above) fixes that; it's
// invalidated immediately on add/edit/toggle/delete so admin changes are
// never stale for more than a moment.
const CHANNELS_CACHE_TTL = 5 * 60 * 1000;
let channelsCache = null;
let channelsCacheAt = 0;
function invalidateChannelsCache() {
  channelsCache = null;
  channelsCacheAt = 0;
}

function invalidateTopicsCache() {
  topicsCache = null;
  topicsCacheAt = 0;
  singleTopicCache.clear();
  singleTopicRefresh.clear();
}

async function getSingleTopicCached(topicId) {
  const id = String(topicId || '').trim();
  if (!id) return null;
  const now = Date.now();
  const cached = singleTopicCache.get(id);
  if (cached && cached.expiresAt > now) return cached.data;
  const pending = singleTopicRefresh.get(id);
  if (pending) return pending;

  const promise = (async () => {
    const doc = await db.collection('topics').doc(id).get();
    if (!doc.exists) return null;
    const data = doc.data() || {};
    const topic = {
      id: doc.id,
      title: data.title || 'নামবিহীন ভিডিও',
      thumbnail: data.thumbnail || '',
      adsRequired: Math.max(1, Number(data.adsRequired) || 1),
      type: data.type || 'single',
      videoCount: Number(data.videoCount) || (Array.isArray(data.videos) ? data.videos.length : 0),
      unlockCount: Number(data.unlockCount) || 0,
      // 🐛 FIX (extra Firestore read on every single unlock): delivery used to
      // do its OWN separate `topicRef.get()` just to fetch `videos`, even
      // though this cache had just been populated moments earlier for the
      // same topic. Carrying `videos` here too means deliverUnlockedTopic()
      // can reuse this exact cache entry instead of reading the topic doc a
      // second time.
      videos: Array.isArray(data.videos) ? data.videos : []
    };
    singleTopicCache.set(id, { data: topic, expiresAt: Date.now() + SINGLE_TOPIC_CACHE_TTL });
    return topic;
  })().finally(() => singleTopicRefresh.delete(id));

  singleTopicRefresh.set(id, promise);
  return promise;
}

function invalidateAdminStatsCache() {
  adminStatsCache = null;
  adminStatsCacheAt = 0;
}

async function getTopicsCached() {
  const now = Date.now();
  if (topicsCache && (now - topicsCacheAt) < TOPICS_CACHE_TTL) return topicsCache;
  if (topicsRefreshPromise) return topicsRefreshPromise;
  topicsRefreshPromise = (async () => {
    const snapshot = await db.collection('topics').get();
    const topics = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    topics.sort((a, b) => {
      const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : new Date(a.createdAt || 0).getTime();
      const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : new Date(b.createdAt || 0).getTime();
      return orderB - orderA;
    });
    topicsCache = topics;
    topicsCacheAt = Date.now();
    return topics;
  })().finally(() => { topicsRefreshPromise = null; });
  return topicsRefreshPromise;
}

async function getDailyAdLimit() {
  const now = Date.now();
  if ((now - dailyLimitCacheAt) < DAILY_LIMIT_CACHE_TTL) return dailyLimitCache;
  try {
    const doc = await db.collection('system').doc('settings').get();
    const value = doc.exists ? Number(doc.data().dailyAdLimit) : DEFAULT_DAILY_AD_LIMIT;
    dailyLimitCache = Number.isInteger(value) && value > 0 ? value : DEFAULT_DAILY_AD_LIMIT;
    dailyLimitCacheAt = now;
  } catch (e) {
    console.error('❌ Daily limit read error:', e.message);
  }
  return dailyLimitCache;
}

function invalidateDailyLimitCache() { dailyLimitCacheAt = 0; }

// 🛡️ Ad-watch anti-abuse: since the Monetag Frontend Callback (the browser
// Promise from show_XXX()) can be spoofed by anyone editing page JS — Monetag
// themselves warn about this — we require a short-lived, single-use token
// issued right before the ad is shown, and only accept /api/ad-complete if
// the token matches AND a realistic minimum amount of time has actually
// passed (a real rewarded ad takes several seconds; a scripted call hitting
// the endpoint instantly cannot fake that elapsed time).
const adTokens = new Map(); // token -> { userId, topicId, createdAt }
const AD_TOKEN_TTL_MS = 5 * 60 * 1000;      // tokens expire after 5 minutes unused
const MIN_AD_DURATION_MS = 10 * 1000;       // safety margin below the ~15s ad length — blocks obvious instant/skip abuse without risking false-rejecting a real viewer (slow network, ad render delay, or a slightly shorter creative)
function cleanupAdTokens() {
  const now = Date.now();
  for (const [token, data] of adTokens.entries()) {
    if ((now - data.createdAt) > AD_TOKEN_TTL_MS) adTokens.delete(token);
  }
}

// 💰 Revenue tracking: admin sets an estimated CPM (revenue per 1000 ad
// views) since third-party ad networks (libtl.com etc.) don't expose a
// revenue API here — this gives an estimate based on real ad-view counts.
async function getAdCpm() {
  const now = Date.now();
  if ((now - adCpmCacheAt) < DAILY_LIMIT_CACHE_TTL) return adCpmCache;
  try {
    const doc = await db.collection('system').doc('settings').get();
    const value = doc.exists ? Number(doc.data().adCpm) : 0;
    adCpmCache = Number.isFinite(value) && value >= 0 ? value : 0;
    adCpmCacheAt = now;
  } catch (e) {
    console.error('❌ Ad CPM read error:', e.message);
  }
  return adCpmCache;
}

// 📉 Firestore optimization: batch ad-view analytics in memory.
// The user/ad-count transaction remains immediate and reliable; only the
// non-critical revenue counter is buffered. This changes one Firestore write
// per ad into roughly one write per 10 seconds.
let pendingAdViews = 0;
let pendingAdViewDate = null;
let adStatsFlushPromise = null;

async function flushAdViews() {
  if (!pendingAdViews || adStatsFlushPromise) return adStatsFlushPromise;
  const count = pendingAdViews;
  const dateKey = pendingAdViewDate || getDhakaDateKey();
  pendingAdViews = 0;
  pendingAdViewDate = null;

  adStatsFlushPromise = db.collection('system').doc('adStats').set({
    totalAdViews: admin.firestore.FieldValue.increment(count),
    adViewsByDate: { [dateKey]: admin.firestore.FieldValue.increment(count) },
    updatedAt: Date.now()
  }, { merge: true }).catch(e => {
    // Put failed increments back so a temporary Firestore/network error does
    // not silently lose revenue statistics.
    pendingAdViews += count;
    pendingAdViewDate = dateKey;
    console.error('❌ adStats batch flush error:', e.message);
  }).finally(() => { adStatsFlushPromise = null; });
  return adStatsFlushPromise;
}

function recordAdView() {
  const today = getDhakaDateKey();
  // If midnight passes before the flush, keep separate day buckets.
  if (pendingAdViewDate && pendingAdViewDate !== today) {
    flushAdViews().catch(() => {});
  }
  pendingAdViewDate = today;
  pendingAdViews++;
  if (pendingAdViews >= 50) flushAdViews().catch(() => {});
}

// Flush periodically instead of writing once per ad. Keep this timer
// from preventing Render/Node from exiting during a deploy.
const adStatsFlushTimer = setInterval(() => flushAdViews().catch(() => {}), 30000);
if (typeof adStatsFlushTimer.unref === 'function') adStatsFlushTimer.unref();

// 🐛 FIX (real cause of the Firestore read/write spike right after the
// recordAdView crash was fixed): every single topic unlock used to do its
// OWN `db.runTransaction(async tx => { tx.get(topicRef); ...; tx.set(...) })`
// synchronously, right in the delivery hot path — 1 read + 1 write PER
// UNLOCK, just to update `unlockCount`/`recentUnlocks`/the daily-unlock
// counter. Because the old `.catch()` bug made /api/ad-complete crash
// BEFORE this code ever ran, this cost had never actually shown up in
// production — fixing that bug for the first time let this pre-existing
// per-unlock read+write actually execute on every real unlock. Same fix as
// recordAdView()/flushAdViews() above: batch it in memory per topic and
// flush periodically, so N unlocks of the same topic inside one flush
// window cost 1 read + 1 write total instead of N of each.
let pendingUnlockStats = new Map(); // topicId -> { count, timestamps: number[] }
let unlockStatsFlushPromise = null;

function recordUnlock(topicId) {
  const id = String(topicId);
  const entry = pendingUnlockStats.get(id) || { count: 0, timestamps: [] };
  entry.count++;
  entry.timestamps.push(Date.now());
  pendingUnlockStats.set(id, entry);
  if (pendingUnlockStats.size >= 50) flushUnlockStats().catch(() => {});
}

async function flushUnlockStats() {
  if (!pendingUnlockStats.size || unlockStatsFlushPromise) return unlockStatsFlushPromise;
  const batch = pendingUnlockStats;
  pendingUnlockStats = new Map();
  unlockStatsFlushPromise = (async () => {
    for (const [topicId, entry] of batch) {
      const topicRef = db.collection('topics').doc(topicId);
      try {
        await db.runTransaction(async tx => {
          const fresh = await tx.get(topicRef);
          if (!fresh.exists) return; // topic deleted since — nothing to update
          const current = fresh.data() || {};
          const lastTs = entry.timestamps[entry.timestamps.length - 1];
          const todayKey = getDhakaDateKey(new Date(lastTs));
          const sameDay = current.dailyUnlockDate === todayKey;
          const dailyUnlockCount = (sameDay ? (Number(current.dailyUnlockCount) || 0) : 0) + entry.count;
          const existingRecent = Array.isArray(current.recentUnlocks) ? current.recentUnlocks : [];
          const recentUnlocks = existingRecent
            .map(v => typeof v === 'number' ? v : new Date(v).getTime())
            .filter(v => Number.isFinite(v))
            .concat(entry.timestamps)
            .slice(-99);
          tx.set(topicRef, {
            unlockCount: admin.firestore.FieldValue.increment(entry.count),
            lastUnlockAt: lastTs,
            recentUnlocks,
            dailyUnlockDate: todayKey,
            dailyUnlockCount
          }, { merge: true });
        });
      } catch (e) {
        // Put this topic's counts back for the next flush instead of losing them.
        const back = pendingUnlockStats.get(topicId) || { count: 0, timestamps: [] };
        back.count += entry.count;
        back.timestamps = entry.timestamps.concat(back.timestamps);
        pendingUnlockStats.set(topicId, back);
        console.error(`❌ Unlock-stats flush error for topic ${topicId}:`, e.message);
      }
    }
  })().finally(() => { unlockStatsFlushPromise = null; });
  return unlockStatsFlushPromise;
}

const unlockStatsFlushTimer = setInterval(() => flushUnlockStats().catch(() => {}), 30000);
if (typeof unlockStatsFlushTimer.unref === 'function') unlockStatsFlushTimer.unref();

async function getAdStats() {
  const today = getDhakaDateKey();
  const doc = await db.collection('system').doc('adStats').get();
  const data = doc.exists ? doc.data() : {};
  const totalAdViews = Number(data.totalAdViews) || 0;
  const byDate = data.adViewsByDate || {};
  const todayAdViews = Number(byDate[today]) || 0;
  return { totalAdViews, todayAdViews };
}

// sentAt can be a number, a numeric string, an ISO date string (very old data)
// or a Firestore Timestamp — read all of them instead of silently treating
// anything unusual as "no time".
function sentAtOf(m) {
  if (!m) return 0;
  const raw = m.sentAt;
  if (raw && typeof raw.toMillis === 'function') return raw.toMillis();
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function msgKey(m) { return `${m && m.chatId}:${m && m.messageId}`; }
// When the message must be deleted. An entry whose time can't be read is
// treated as ALREADY DUE (deleted at the next pass) — never forgotten.
function dueAtOf(m) {
  const sentAt = sentAtOf(m);
  return sentAt ? sentAt + THIRTY_MINUTES : 1;
}
function getCleanupDueAt(sentMessages) {
  const list = (Array.isArray(sentMessages) ? sentMessages : []).filter(m => m && m.chatId && m.messageId);
  if (!list.length) return null;
  return Math.min(...list.map(dueAtOf));
}

// Deliveries currently in progress (used so a redeploy waits for them).
let inflightDeliveries = 0;

// 🐛 FIX (videos surviving a redeploy): every video is now written to the
// user's `sentMessages` list THE MOMENT it is sent — atomically, in a
// transaction that re-reads the fresh document. Before, all sent videos were
// saved in one write at the very end of delivery (and that write replaced the
// whole array), so a restart in the middle, or a concurrent cleanup pass,
// could lose track of a video that was already in the user's chat.
// 🐛 FIX (THE real "unlock 1-2 videos = tons of reads" cause): this used to
// be called ONCE PER VIDEO inside deliverUnlockedTopicInner's send loop, and
// each call runs a full transaction — a real Firestore READ (tx.get) plus a
// WRITE — with up to 3 retries on failure. A topic with, say, 8 videos
// therefore cost 8 separate read+write transactions for ONE unlock, on top
// of the 1 read already spent in /api/ad-complete's own transaction. This
// now takes the whole batch of videos sent in one delivery and does exactly
// ONE read + ONE write for all of them together, regardless of how many
// videos the topic has — unlocking a 1-video topic or a 20-video topic now
// costs the same single read+write here.
async function trackSentMessages(userRef, entries) {
  if (!entries || !entries.length) return true;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(userRef);
        const data = snap.exists ? (snap.data() || {}) : {};
        const list = Array.isArray(data.sentMessages) ? data.sentMessages.slice() : [];
        for (const entry of entries) {
          if (!list.some(m => msgKey(m) === msgKey(entry))) list.push(entry);
        }
        tx.set(userRef, { sentMessages: list, cleanupDueAt: getCleanupDueAt(list) }, { merge: true });
      });
      return true;
    } catch (e) {
      lastError = e;
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  console.error('❌ trackSentMessages failed after retries:', lastError && lastError.message);
  // Last resort so the videos are still removed even though Firestore is failing.
  entries.forEach(entry => {
    setTimeout(() => { safeDeleteMessage(entry.chatId, entry.messageId).catch(() => {}); }, THIRTY_MINUTES);
  });
  return false;
}

console.log('✅ Firebase Connected');

const REQUIRED_CHANNELS = (process.env.REQUIRED_CHANNELS || '').split(',').map(id => id.trim()).filter(Boolean);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL;
const POST_CHANNEL = process.env.POST_CHANNEL || '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID);
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://telegram-bot-app-24ti.onrender.com';

let addTopicData = {};
let addVideoData = {};
let broadcastData = {};
let updateAdsData = {};
let renameData = {};
let thumbnailData = {};
let postData = {};
let repostData = {};
let adminChannelData = {};
let adminButtonData = {};
let bulkSelect = { ids: new Set(), page: 0 };
const BULK_PAGE_SIZE = 15;
let adminVideoData = {};
let userSearchData = {};
let forwardRepostData = {};
let topicSearchData = {};
let appendVideoData = {};
let duplicateTopicData = {};
let channelPickData = {};

// Isolate admin workflows. Add Video/Topic always has priority over /post.
function clearAdminWorkflow(userId) {
  delete postData[userId];
  delete repostData[userId];
  delete broadcastData[userId];
  delete adminChannelData[userId];
  delete adminButtonData[userId];
  delete adminVideoData[userId];
  delete updateAdsData[userId];
  delete renameData[userId];
  delete thumbnailData[userId];
  delete userSearchData[userId];
  delete forwardRepostData[userId];
  delete topicSearchData[userId];
  delete appendVideoData[userId];
  delete duplicateTopicData[userId];
  delete channelPickData[userId];
}
function startAddVideoWorkflow(userId) {
  clearAdminWorkflow(userId);
  delete addTopicData[userId];
  addVideoData[userId] = { step: 'video' };
}
function startAddTopicWorkflow(userId) {
  clearAdminWorkflow(userId);
  delete addVideoData[userId];
  addTopicData[userId] = { step: 'video', videos: [] };
}
function startAppendVideoWorkflow(userId, topicId) {
  clearAdminWorkflow(userId);
  delete addTopicData[userId];
  delete addVideoData[userId];
  appendVideoData[userId] = { step: 'video', topicId };
}
function startDuplicateTopicWorkflow(userId, sourceTopic) {
  clearAdminWorkflow(userId);
  delete addTopicData[userId];
  delete addVideoData[userId];
  duplicateTopicData[userId] = {
    step: 'video',
    sourceId: sourceTopic.id,
    title: sourceTopic.title || 'নামবিহীন',
    thumbnail: sourceTopic.thumbnail || '',
    adsRequired: Math.max(1, Number(sourceTopic.adsRequired) || 1),
    videos: []
  };
}

let helpAdminLinkCache = process.env.HELP_ADMIN_LINK || '';
let helpAdminLinkCacheAt = helpAdminLinkCache ? Date.now() : 0;

async function getHelpAdminLink() {
  const now = Date.now();
  if (helpAdminLinkCache && (now - helpAdminLinkCacheAt) < 10 * 60 * 1000) {
    return helpAdminLinkCache;
  }
  try {
    const doc = await db.collection('system').doc('settings').get();
    const link = doc.exists ? String(doc.data().helpAdminLink || '').trim() : '';
    if (link) {
      helpAdminLinkCache = link;
      helpAdminLinkCacheAt = now;
      return link;
    }
  } catch (error) {
    console.error('❌ Help Admin link read error:', error.message);
  }
  return helpAdminLinkCache;
}

function buildMiniAppTopicUrl(topicId) {
  const encodedId = encodeURIComponent(String(topicId));
  if (BOT_USERNAME) return `https://t.me/${BOT_USERNAME}?startapp=${encodedId}`;
  return `${MINI_APP_URL.replace(/\/$/, '')}/?topic=${encodedId}`;
}

function getForwardChannelInfo(msg) {
  if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
    return { channelId: String(msg.forward_from_chat.id), messageId: msg.forward_from_message_id };
  }
  if (msg.forward_origin && msg.forward_origin.type === 'channel' && msg.forward_origin.chat) {
    return { channelId: String(msg.forward_origin.chat.id), messageId: msg.forward_origin.message_id };
  }
  return null;
}

// Returns true if it consumed the message (caller should stop processing further).
async function handleForwardedRepostCapture(ctx) {
  const userId = ctx.from.id;
  if (!forwardRepostData[userId] || forwardRepostData[userId].step !== 'awaiting_forward') return false;
  if (ctx.from.id !== ADMIN_ID) return false;

  const msg = ctx.message;
  const info = getForwardChannelInfo(msg);
  if (!info || !info.messageId) {
    await ctx.reply('❌ এটা কোনো Channel থেকে সরাসরি Forward করা মেসেজ মনে হচ্ছে না। আবার Forward করে পাঠান।');
    return true;
  }

  // A copy made by the Repost button is not a source post — adding it would
  // put a duplicate of the original into the list.
  const hiddenIds = await getRepostHiddenIds(info.channelId);
  if (hiddenIds.has(Number(info.messageId))) {
    await ctx.reply('ℹ️ এটা Repost করা কপি (বা মুছে যাওয়া Post)। এটা list-এ যোগ করা যাবে না — original Post-টা Forward করুন।');
    return true;
  }

  const channels = await getChannels();
  const known = channels.find(c => String(c.channelId) === info.channelId);
  if (!known) {
    delete forwardRepostData[userId];
    await ctx.reply(`❌ এই Channel (🆔 ${info.channelId}) এখনো Channel Manager-এ add করা নেই।\n\nআগে Channel Manager থেকে এটা add করুন, তারপর আবার চেষ্টা করুন।`);
    return true;
  }

  let type = 'text';
  if (msg.video) type = 'video';
  else if (msg.photo && msg.photo.length) type = 'photo';
  else if (msg.animation) type = 'animation';
  const caption = msg.caption || msg.text || '';

  forwardRepostData[userId] = { step: 'topicId', channelId: info.channelId, messageId: info.messageId, type, caption };
  await ctx.reply(
    `✅ Post পাওয়া গেছে (📢 ${known.name || info.channelId})।\n\n` +
    'এটা কোনো নির্দিষ্ট Video/Topic ID-এর সাথে যুক্ত থাকলে সেই ID পাঠান, যাতে Repost করলে সঠিক "▶️ ভিডিও দেখুন" বাটন যোগ হয়।\n\n' +
    'না থাকলে "skip" লিখুন — Post টা Repost list-এ যোগ হবে, তবে বাটন ছাড়া কপি হবে।'
  );
  return true;
}

function buildPostKeyboard(topicId, helpLink) {
  const buttons = [
    [Markup.button.url('▶️ ভিডিও দেখুন', buildMiniAppTopicUrl(topicId))]
  ];
  if (helpLink) buttons.push([Markup.button.url('Help Admin', helpLink)]);
  return Markup.inlineKeyboard(buttons);
}

// =============================================
// 👑 ADMIN PANEL / MULTI-CHANNEL HELPERS
// =============================================
const DEFAULT_POST_BUTTONS = [
  { name: '▶️ ভিডিও দেখুন', url: '{VIDEO_LINK}' },
  { name: '❓ Help Admin', url: '{HELP_LINK}' }
];

async function getPostButtons() {
  try {
    const snap = await db.collection('system').doc('settings').get();
    const saved = snap.exists && Array.isArray(snap.data().postButtons) ? snap.data().postButtons : null;
    if (saved && saved.length) return saved;
  } catch (e) {
    console.error('❌ Post buttons read error:', e.message);
  }
  return DEFAULT_POST_BUTTONS;
}

async function savePostButtons(buttons) {
  await db.collection('system').doc('settings').set({ postButtons: buttons, updatedAt: Date.now() }, { merge: true });
}

async function buildConfiguredPostKeyboard(topicId) {
  const helpLink = await getHelpAdminLink();
  const configured = await getPostButtons();
  const rows = [];
  for (const b of configured) {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) continue;
    let url = String(b.url || '').trim();
    if (url === '{VIDEO_LINK}') url = buildMiniAppTopicUrl(topicId);
    else if (url === '{HELP_LINK}') url = helpLink || '';
    else url = url.replaceAll('{topicId}', encodeURIComponent(String(topicId)));
    if (/^https?:\/\//i.test(url)) rows.push([Markup.button.url(name, url)]);
  }
  return Markup.inlineKeyboard(rows);
}

async function getChannels() {
  const now = Date.now();
  if (channelsCache && (now - channelsCacheAt) < CHANNELS_CACHE_TTL) return channelsCache;

  // Merge BOTH saved Admin-panel channels and the legacy POST_CHANNEL env channel.
  // This prevents an already-connected channel from disappearing from the Admin Panel.
  const result = [];
  const seen = new Set();

  try {
    const chSnap = await db.collection('channels').orderBy('createdAt', 'asc').get();
    for (const d of chSnap.docs) {
      const c = { id: d.id, ...d.data() };
      const key = String(c.channelId || c.id || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(c);
    }
  } catch (e) {
    console.error('❌ Channel list read error:', e.message);
  }

  // Keep old POST_CHANNEL working and show it in Admin > Channels too.
  if (POST_CHANNEL) {
    const key = String(POST_CHANNEL).trim();
    if (!seen.has(key)) {
      const envId = `env_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const override = result.find(c => c.legacyOverride && String(c.channelId||'').trim() === key) || null;
      result.unshift(override ? { id: envId, ...override, legacy: true } : {
        id: envId,
        name: 'Posting Channel',
        channelId: key,
        link: '',
        active: true,
        legacy: true
      });
    }
  }

  channelsCache = result;
  channelsCacheAt = now;
  return result;
}

// 📤 Multi-channel picker — lets the admin tick 1 or more channels at once
// instead of posting to each channel one at a time.
async function renderChannelPicker(ctx) {
  const userId = ctx.from.id;
  const state = channelPickData[userId];
  if (!state) return;
  const channels = await getChannels();
  const active = channels.filter(c => c.active !== false);
  const rows = active.map(c => {
    const key = c.id || c.channelId;
    const checked = state.selected.has(key) ? '✅' : '⬜';
    return [Markup.button.callback(`${checked} ${safeTruncate(c.name || c.channelId, 35)}`, 'pch_toggle:' + key)];
  });
  if (!rows.length && POST_CHANNEL) {
    const checked = state.selected.has(POST_CHANNEL) ? '✅' : '⬜';
    rows.push([Markup.button.callback(`${checked} Posting Channel`, 'pch_toggle:' + POST_CHANNEL)]);
  }
  const n = state.selected.size;
  rows.push([Markup.button.callback(`▶️ Continue (${n} selected)`, 'pch_continue')]);
  rows.push([Markup.button.callback('❌ Cancel', 'pch_cancel')]);
  const heading = state.mode === 'topic_post'
    ? '📤 SELECT CHANNEL(S)\n\nএক বা একাধিক Channel সিলেক্ট করুন:'
    : '➕ CREATE NEW POST\n\nএক বা একাধিক Channel সিলেক্ট করুন:';
  return ctx.editMessageText(heading, Markup.inlineKeyboard(rows)).catch(() => ctx.reply(heading, Markup.inlineKeyboard(rows)));
}

bot.action(/^pch_toggle:(.+)$/, async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = channelPickData[ctx.from.id];
  if (!state) { try { await ctx.answerCbQuery('❌ /admin দিয়ে আবার শুরু করুন'); } catch (e) {} return; }
  const key = ctx.match[1];
  if (state.selected.has(key)) state.selected.delete(key); else state.selected.add(key);
  try { await ctx.answerCbQuery(); } catch (e) {}
  return renderChannelPicker(ctx);
});

bot.action('pch_cancel', async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  delete channelPickData[ctx.from.id];
  try { await ctx.answerCbQuery('Cancelled'); } catch (e) {}
  return ctx.editMessageText('❌ বাতিল করা হয়েছে।', Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]));
});

bot.action('pch_continue', async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = channelPickData[ctx.from.id];
  if (!state || !state.selected.size) { try { await ctx.answerCbQuery('❌ কমপক্ষে একটি Channel সিলেক্ট করুন'); } catch (e) {} return; }
  try { await ctx.answerCbQuery(); } catch (e) {}

  const keys = Array.from(state.selected);
  const resolved = [];
  for (const key of keys) {
    let channelId = key;
    try {
      const doc = await db.collection('channels').doc(key).get();
      if (doc.exists) channelId = doc.data().channelId;
    } catch (e) {}
    resolved.push(channelId);
  }

  if (state.mode === 'new_post') {
    delete channelPickData[ctx.from.id];
    postData[ctx.from.id] = { step: 'mediaType', channels: resolved };
    return ctx.editMessageText(
      `📤 ${resolved.length}টি Channel সিলেক্ট হয়েছে।\n\nকী পোস্ট করবেন?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🎬 Video', 'post_type_video'), Markup.button.callback('🖼️ Photo', 'post_type_photo')],
        [Markup.button.callback('❌ Cancel', 'post_cancel')]
      ])
    );
  }

  if (state.mode === 'topic_post') {
    const topicId = state.topicId;
    delete channelPickData[ctx.from.id];
    const td = await db.collection('topics').doc(topicId).get();
    if (!td.exists) return ctx.reply('❌ Video/Topic পাওয়া যায়নি।');
    const t = td.data();
    const fileId = (t.videos && t.videos[0]) || t.videoId || '';
    if (!fileId) return ctx.reply('❌ Video file পাওয়া যায়নি।');
    const kb = await buildConfiguredPostKeyboard(topicId);
    const lines = [];
    for (const channelId of resolved) {
      try {
        const sent = await bot.telegram.sendVideo(channelId, fileId, { caption: t.title || '', reply_markup: kb.reply_markup });
        await recordTopicPost(topicId, channelId, sent.message_id, 'video', t.title || '', t.title || '');
        lines.push(`✅ ${channelId} — Message ID: ${sent.message_id}`);
      } catch (e) {
        lines.push(`❌ ${channelId} — ${e.message}`);
      }
    }
    return ctx.reply(
      `📤 Post সম্পন্ন হয়েছে (${resolved.length}টি Channel):\n\n${lines.join('\n')}`,
      { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup }
    );
  }
});

async function addChannelRecord(data) {
  const ref = await db.collection('channels').add({
    name: data.name, channelId: data.channelId, link: data.link || '', active: true, createdAt: Date.now(), updatedAt: Date.now()
  });
  invalidateChannelsCache();
  return { id: ref.id, ...data, active: true };
}

async function sendAdminPanel(ctx, edit = false) {
  const counts = await getUserCountsCached();
  const topics = await getTopicsCached();
  const channels = await getChannels();
  const text = `👑 PREMIUM ADMIN PANEL\n\n👥 Users: ${counts.totalUsers}\n🎬 Videos/Topics: ${topics.length}\n📢 Channels: ${channels.length}\n\n👇 একটি অপশন বেছে নিন:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Dashboard', 'adm_dashboard'), Markup.button.callback('🎬 Videos', 'adm_videos')],
    [Markup.button.callback('📢 Channels', 'adm_channels'), Markup.button.callback('📤 Create Post', 'adm_create_post')],
    [Markup.button.callback('👥 Users', 'adm_users'), Markup.button.callback('📺 Ads', 'adm_ads')],
    [Markup.button.callback('📣 Broadcast', 'adm_broadcast'), Markup.button.callback('🔘 Post Buttons', 'adm_buttons')],
    [Markup.button.callback('💰 Revenue', 'adm_revenue'), Markup.button.callback('📦 Export Data', 'adm_export')],
    [Markup.button.callback('🕒 Scheduled Posts', 'adm_scheduled')]
  ]);
  if (edit && ctx.callbackQuery?.message) {
    return ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
  }
  return ctx.reply(text, keyboard);
}


function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;');
}

async function sendHtmlChunks(ctx, header, entries, options = {}) {
  const maxLength = options.maxLength || 3800;
  let chunk = String(header || '');
  const sent = [];
  for (const entry of entries) {
    const part = String(entry || '');
    if ((chunk + part).length > maxLength && chunk.trim()) {
      sent.push(await ctx.reply(chunk, { parse_mode: 'HTML' }));
      chunk = part;
    } else {
      chunk += part;
    }
  }
  if (chunk.trim()) sent.push(await ctx.reply(chunk, { parse_mode: 'HTML' }));
  return sent;
}

function adminOnly(ctx) { return ctx.from && ctx.from.id === ADMIN_ID; }

// =============================================
// 🔐 USER HELPERS
// =============================================

async function getOrCreateUser(userId, username, firstName, lastName) {
  try {
    const userRef = db.collection('users').doc(userId.toString());
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({
        userId: userId,
        username: username || '',
        firstName: firstName || '',
        lastName: lastName || '',
        verified: false,
        verifiedAt: null,
        createdAt: new Date().toISOString(),
        unlockedTopics: [],
        topicUnlockTime: {},
        sentMessages: [],
        cleanupDueAt: null,
        dailyAdDate: null,
        dailyAdsUsed: 0
      });
      invalidateAdminStatsCache();
      // 📊 Daily Summary tracking: count of brand-new users, per Dhaka date.
      // 🐛 FIX: a dotted STRING key with set(merge:true) writes a literal
      // field named "newUsersByDate.2026-09-17" instead of nesting — a real
      // nested object merges correctly instead.
      const today = getDhakaDateKey();
      db.collection('system').doc('dailyStats').set({
        newUsersByDate: { [today]: admin.firestore.FieldValue.increment(1) }
      }, { merge: true }).catch(e => console.error('❌ dailyStats increment error:', e.message));
      return { userId, username, firstName, lastName, verified: false, unlockedTopics: [], topicUnlockTime: {}, sentMessages: [], cleanupDueAt: null };
    }
    return { id: doc.id, ...doc.data() };
  } catch (error) {
    console.error('Error in getOrCreateUser:', error);
    return { userId, verified: false };
  }
}

async function updateUser(userId, updates) {
  try {
    const userRef = db.collection('users').doc(userId.toString());
    await userRef.update(updates);
    if (Object.prototype.hasOwnProperty.call(updates, 'verified')) invalidateAdminStatsCache();
  } catch (error) {
    console.error('Error in updateUser:', error);
  }
}

async function checkChannelMembership(ctx, channelId) {
  try {
    const chatMember = await ctx.telegram.getChatMember(channelId, ctx.from.id);
    return ['member', 'administrator', 'creator'].includes(chatMember.status);
  } catch (error) {
    console.error(`Channel check error for ${channelId}:`, error.message);
    return false;
  }
}

async function checkAllChannels(ctx) {
  for (const channel of REQUIRED_CHANNELS) {
    const isMember = await checkChannelMembership(ctx, channel);
    if (!isMember) return false;
  }
  return true;
}

async function forwardVideoToStorageChannel(ctx, fileId) {
  try {
    const forwarded = await ctx.telegram.sendVideo(STORAGE_CHANNEL, fileId);
    console.log('✅ Video forwarded to storage channel');
    return forwarded.video.file_id;
  } catch (error) {
    console.error('Error forwarding video:', error);
    throw error;
  }
}

async function forwardPhotoToStorageChannel(ctx, fileId) {
  try {
    const forwarded = await ctx.telegram.sendPhoto(STORAGE_CHANNEL, fileId);
    const picked = pickThumbPhotoSize(forwarded.photo) || forwarded.photo[forwarded.photo.length - 1];
    return picked.file_id;
  } catch (error) {
    console.error('Error forwarding photo:', error);
    throw error;
  }
}

function getDhakaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// 🕒 Post Schedule: Bangladesh (Asia/Dhaka) is UTC+6 year-round, no DST, so we
// can convert admin-entered time to a UTC epoch with simple fixed-offset math
// instead of needing a timezone library.
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

// Accepts either a full date+time ("2026-09-20 9:30 PM" / "2026-09-20 21:30")
// or just a time ("9:30 PM" / "09:30 PM" / "21:30") — when the date is left
// out, it defaults to the next upcoming occurrence of that time (today if it
// hasn't passed yet in Dhaka time, otherwise tomorrow), so the admin doesn't
// have to type the date every time for same-day/next-occurrence schedules.
function parseDhakaDateTime(text) {
  const raw = String(text || '').trim();
  const timeRe = /(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/;
  const timeMatch = raw.match(timeRe);
  if (!timeMatch) return null;

  let [, hStr, minStr, ampm] = timeMatch;
  let h = Number(hStr), min = Number(minStr);
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    ampm = ampm.toUpperCase();
    if (ampm === 'AM') h = (h === 12) ? 0 : h;
    else h = (h === 12) ? 12 : h + 12;
  } else if (h > 23) {
    return null;
  }

  const datePart = raw.slice(0, timeMatch.index).trim();
  if (datePart) {
    const dm = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dm) return null;
    const [, y, mo, d] = dm.map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const utcMs = Date.UTC(y, mo - 1, d, h, min) - DHAKA_OFFSET_MS;
    return Number.isFinite(utcMs) ? utcMs : null;
  }

  // No date given — use the next upcoming occurrence of this time, Dhaka time.
  const todayKey = getDhakaDateKey();
  const [ty, tm, td] = todayKey.split('-').map(Number);
  let utcMs = Date.UTC(ty, tm - 1, td, h, min) - DHAKA_OFFSET_MS;
  if (utcMs <= Date.now()) utcMs += 24 * 60 * 60 * 1000; // already passed today → tomorrow
  return utcMs;
}

function formatDhakaDateTime(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(ms)) + ' (Dhaka সময়)';
}

// =============================================
// 🚀 /start
// =============================================

bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await getOrCreateUser(
      userId,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name
    );

    // Mark that this user has started the bot at least once.
    // Existing users can receive unlocked videos directly without another /start.
    await updateUser(userId, { botStarted: true });

    // /start no longer forces channel join/verification.
    // If this user unlocked a topic in the Mini App before starting the bot,
    // deliver only that exact pending topic.
    const payload = String(ctx.startPayload || '').trim();
    const requestedTopicId = payload.startsWith('unlock_') ? payload.slice(7).trim() : '';
    const pendingTopicId = String(user.pendingUnlockTopicId || '').trim();

    if (requestedTopicId && (!pendingTopicId || requestedTopicId !== pendingTopicId)) {
      return ctx.reply('❌ এই unlock request আর active নেই। Mini App থেকে আবার unlock করুন।');
    }

    const pendingAt = Number(user.pendingUnlockAt || 0);
    const pendingValid = pendingTopicId && pendingAt && (Date.now() - pendingAt) < THIRTY_MINUTES;
    const topicId = pendingValid ? pendingTopicId : '';
    if (pendingTopicId && !pendingValid) {
      await updateUser(userId, {
        pendingUnlockTopicId: admin.firestore.FieldValue.delete(),
        pendingUnlockAt: admin.firestore.FieldValue.delete()
      });
      return ctx.reply('⏳ এই unlock request-এর সময় শেষ হয়ে গেছে। Mini App থেকে আবার unlock করুন।');
    }
    if (topicId) {
      try {
        await deliverUnlockedTopic(userId, topicId);
        await updateUser(userId, {
          pendingUnlockTopicId: admin.firestore.FieldValue.delete(),
          pendingUnlockAt: admin.firestore.FieldValue.delete()
        });
        return ctx.reply('🎬 আপনার unlocked video পাঠানো হয়েছে।');
      } catch (deliveryError) {
        console.error('❌ Pending topic delivery error:', deliveryError.message);
        if (deliveryError.message === 'User is blocked') {
          return ctx.reply('⛔ আপনাকে এই বট ব্যবহার থেকে ব্লক করা হয়েছে।');
        }
        return ctx.reply('❌ ভিডিও পাঠাতে সমস্যা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।');
      }
    }

    return ctx.reply(
      '👋 স্বাগতম! আপনার ভিডিও দেখতে নিচের বাটনে ক্লিক করুন।',
      Markup.inlineKeyboard([
        Markup.button.webApp('🚀 Open App', MINI_APP_URL)
      ])
    );
  } catch (error) {
    console.error('Error in start command:', error);
    await ctx.reply('❌ কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।').catch(() => {});
  }
});

bot.action('verify_join', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const user = await getOrCreateUser(
      userId,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name
    );
    if (user.verified) {
      return ctx.reply(
        '✅ আপনি ইতিমধ্যে যাচাইকৃত!',
        Markup.inlineKeyboard([
          Markup.button.webApp('🚀 Open App', MINI_APP_URL)
        ])
      );
    }
    const allJoined = await checkAllChannels(ctx);
    if (allJoined) {
      await updateUser(userId, { verified: true, verifiedAt: new Date().toISOString() });
      await ctx.reply(
        '✅ যাচাই সফল!',
        Markup.inlineKeyboard([
          Markup.button.webApp('🚀 Open App', MINI_APP_URL)
        ])
      );
      try {
        await ctx.deleteMessage();
      } catch (e) {}
    } else {
      await ctx.reply('❌ আপনি চ্যানেল জয়েন করেননি। দয়া করে জয়েন করে আবার চেষ্টা করুন।');
    }
  } catch (error) {
    console.error('Error in verify action:', error);
    await ctx.reply('❌ কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।').catch(() => {});
  }
});

// =============================================
// 📹 /addvideo, /addtopic
// =============================================

async function handleAddVideoCommand(ctx) {
  try {
    if (!ctx.from || ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    startAddVideoWorkflow(ctx.from.id);
    console.log('👑 Add Video workflow started:', ctx.from.id);
    return ctx.reply('📹 ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)।\n\n➡️ তারপর: Title → Thumbnail → Ads Count → Save');
  } catch (error) {
    console.error('❌ /addvideo error:', error);
    return ctx.reply('❌ Add Video শুরু করতে সমস্যা হয়েছে: ' + error.message).catch(() => {});
  }
}

async function handleAddTopicCommand(ctx) {
  try {
    if (!ctx.from || ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    startAddTopicWorkflow(ctx.from.id);
    console.log('👑 Add Topic workflow started:', ctx.from.id);
    return ctx.reply('📹 প্রথম ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)।\n\n➡️ আরও ভিডিও পাঠান → /done → Title → Thumbnail → Ads Count → Save');
  } catch (error) {
    console.error('❌ /addtopic error:', error);
    return ctx.reply('❌ Add Topic শুরু করতে সমস্যা হয়েছে: ' + error.message).catch(() => {});
  }
}

bot.command('addvideo', handleAddVideoCommand);
bot.command('addtopic', handleAddTopicCommand);
// Fallback for clients/updates where command middleware does not match the command entity.
bot.hears(/^\/addvideo(?:@[^\s]+)?$/i, handleAddVideoCommand);
bot.hears(/^\/addtopic(?:@[^\s]+)?$/i, handleAddTopicCommand);

bot.on('video', async (ctx) => {
  // 🐛 FIX: only the admin's workflows may ever put media into STORAGE_CHANNEL.
  // Media from normal users (photos, video files, GIF/video-sticker files …)
  // is ignored completely.
  if (!ctx.from || ctx.from.id !== ADMIN_ID) return;

  const userId = ctx.from.id;
  const video = ctx.message.video;
  const fileId = video.file_id;

  if (await handleForwardedRepostCapture(ctx)) return;

  if (broadcastData[userId] && broadcastData[userId].step === 'content') {
    broadcastData[userId].type = 'video';
    broadcastData[userId].file = fileId;
    broadcastData[userId].step = 'message';
    await ctx.reply('📝 এবার ব্রডকাস্টের ক্যাপশন/মেসেজ লিখুন (রেফার লিংক সহ):');
    return;
  }

  if (duplicateTopicData[userId] && duplicateTopicData[userId].step === 'video') {
    try {
      const storedFileId = await forwardVideoToStorageChannel(ctx, fileId);
      const data = duplicateTopicData[userId];
      data.videos.push(storedFileId);
      await ctx.reply(`✅ ভিডিও ${data.videos.length} সংরক্ষিত হয়েছে (Duplicate: ${data.title})।\nআরও ভিডিও পাঠান অথবা /done লিখুন শেষ করতে।`);
    } catch (error) {
      console.error('❌ Duplicate Topic storage error:', error);
      await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
    }
    return;
  }

  if (appendVideoData[userId] && appendVideoData[userId].step === 'video') {
    try {
      const storedFileId = await forwardVideoToStorageChannel(ctx, fileId);
      const result = await appendVideoToTopic(appendVideoData[userId].topicId, storedFileId);
      delete appendVideoData[userId];
      if (!result) return ctx.reply('❌ Topic আর পাওয়া যাচ্ছে না।');
      return ctx.reply(`✅ ভিডিও যুক্ত হয়েছে!\n\n📌 ${escapeHtml(result.title)}\n📹 এখন মোট ভিডিও: ${result.videoCount}\n🆔 <code>${escapeHtml(result.id)}</code>`, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🎬 Topic দেখুন', 'aview:' + result.id)], [Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });
    } catch (error) {
      console.error('❌ Append Video storage error:', error);
      await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
    }
    return;
  }

  if (addTopicData[userId] || addVideoData[userId]) {
    try {
      const storedFileId = await forwardVideoToStorageChannel(ctx, fileId);
      if (addTopicData[userId]) {
        const data = addTopicData[userId];
        if (data.step === 'video') {
          data.videos.push(storedFileId);
          await ctx.reply(`✅ ভিডিও ${data.videos.length} সংরক্ষিত হয়েছে।\nআরও ভিডিও পাঠান অথবা /done লিখুন শেষ করতে।`);
        }
        return;
      }
      const data = addVideoData[userId];
      if (data.step === 'video') {
        data.videoId = storedFileId;
        data.step = 'title';
        await ctx.reply('📝 এই ভিডিওর জন্য একটি টাইটেল দিন:');
      }
      return;
    } catch (error) {
      console.error('❌ Add Video/Topic storage error:', error);
      await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
      return;
    }
  }

  if (postData[userId] && postData[userId].step === 'media' && postData[userId].type === 'video') {
    postData[userId].fileId = fileId;
    postData[userId].step = 'topicId';
    await ctx.reply('🔢 এই Preview কোন Video/Topic-এর জন্য?\n\n👉 Video/Topic ID পাঠান:');
    return;
  }

});

bot.on('document', async (ctx) => {
  // 🐛 FIX: only the admin's workflows may ever put media into STORAGE_CHANNEL.
  // Media from normal users (photos, video files, GIF/video-sticker files …)
  // is ignored completely.
  if (!ctx.from || ctx.from.id !== ADMIN_ID) return;

  const userId = ctx.from.id;
  const document = ctx.message.document;
  if (!document.mime_type || !document.mime_type.startsWith('video/')) {
    return ctx.reply('❌ দয়া করে একটি ভিডিও ফাইল পাঠান।');
  }
  const fileId = document.file_id;

  // /post preview: NEVER send preview documents to STORAGE_CHANNEL.
  // Telegram may deliver a video uploaded as a file/document here instead of as a video.
  if (duplicateTopicData[userId] && duplicateTopicData[userId].step === 'video') {
    try {
      const storedFileId = await forwardVideoToStorageChannel(ctx, fileId);
      const data = duplicateTopicData[userId];
      data.videos.push(storedFileId);
      await ctx.reply(`✅ ভিডিও ${data.videos.length} সংরক্ষিত হয়েছে (Duplicate: ${data.title})।\nআরও ভিডিও পাঠান অথবা /done লিখুন শেষ করতে।`);
    } catch (error) {
      console.error('❌ Duplicate Topic document storage error:', error);
      await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
    }
    return;
  }

  if (appendVideoData[userId] && appendVideoData[userId].step === 'video') {
    try {
      const storedFileId = await forwardVideoToStorageChannel(ctx, fileId);
      const result = await appendVideoToTopic(appendVideoData[userId].topicId, storedFileId);
      delete appendVideoData[userId];
      if (!result) return ctx.reply('❌ Topic আর পাওয়া যাচ্ছে না।');
      return ctx.reply(`✅ ভিডিও যুক্ত হয়েছে!\n\n📌 ${escapeHtml(result.title)}\n📹 এখন মোট ভিডিও: ${result.videoCount}\n🆔 <code>${escapeHtml(result.id)}</code>`, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🎬 Topic দেখুন', 'aview:' + result.id)], [Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });
    } catch (error) {
      console.error('❌ Append Video document storage error:', error);
      await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
    }
    return;
  }

  if (addTopicData[userId] || addVideoData[userId]) {
    try {
      const storedFileId = await forwardVideoToStorageChannel(ctx, fileId);
      if (addTopicData[userId]) {
        const data = addTopicData[userId];
        if (data.step === 'video') {
          data.videos.push(storedFileId);
          await ctx.reply(`✅ ভিডিও ${data.videos.length} সংরক্ষিত হয়েছে।\nআরও ভিডিও পাঠান অথবা /done লিখুন শেষ করতে।`);
        }
        return;
      }
      const data = addVideoData[userId];
      if (data.step === 'video') {
        data.videoId = storedFileId;
        data.step = 'title';
        await ctx.reply('📝 এই ভিডিওর জন্য একটি টাইটেল দিন:');
      }
      return;
    } catch (error) {
      console.error('❌ Add Video/Topic document storage error:', error);
      await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
      return;
    }
  }

  if (postData[userId] && postData[userId].step === 'media' && postData[userId].type === 'video') {
    postData[userId].fileId = fileId;
    postData[userId].step = 'topicId';
    await ctx.reply('🔢 এই Preview কোন Video/Topic-এর জন্য?\n\n👉 Video/Topic ID পাঠান:');
    return;
  }

});

bot.command('done', async (ctx) => {
  const userId = ctx.from.id;

  // /done also finalizes a Duplicate Topic workflow — title/thumbnail/ads
  // are already copied from the source topic, so no extra steps needed.
  if (duplicateTopicData[userId]) {
    const data = duplicateTopicData[userId];
    if (data.videos.length === 0) {
      return ctx.reply('❌ কমপক্ষে একটি ভিডিও পাঠান।');
    }
    await saveDuplicateTopic(ctx, data);
    delete duplicateTopicData[userId];
    return;
  }

  if (!addTopicData[userId]) {
    return ctx.reply('❌ কোনো টপিক যোগ করা হচ্ছে না। /addtopic দিয়ে শুরু করুন।');
  }
  const data = addTopicData[userId];
  if (data.videos.length === 0) {
    return ctx.reply('❌ কমপক্ষে একটি ভিডিও পাঠান।');
  }
  data.step = 'title';
  await ctx.reply(`📝 এই টপিকের জন্য একটি টাইটেল দিন (${data.videos.length}টি ভিডিওর জন্য):`);
});

// =============================================
// 🛑 /cancel — বের হওয়ার সহজ উপায়। ভিডিও/টপিক Add, Post, Broadcast,
// Rename, Thumbnail, Ads, Duplicate, Append — যেকোনো কাজের মাঝপথে
// আটকে গেলে এই কমান্ড দিয়ে সব state clear করে ফেলা যাবে।
// =============================================
bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  const wasActive = !!(
    addTopicData[userId] || addVideoData[userId] || broadcastData[userId] ||
    updateAdsData[userId] || renameData[userId] || thumbnailData[userId] ||
    postData[userId] || repostData[userId] || adminChannelData[userId] ||
    adminButtonData[userId] || adminVideoData[userId] || userSearchData[userId] ||
    forwardRepostData[userId] || topicSearchData[userId] || appendVideoData[userId] ||
    duplicateTopicData[userId] || channelPickData[userId]
  );
  clearAdminWorkflow(userId);
  delete addTopicData[userId];
  delete addVideoData[userId];
  if (!wasActive) {
    return ctx.reply('ℹ️ কোনো কাজ চলছিল না, তাই বাতিল করার কিছু নেই।');
  }
  return ctx.reply('✅ চলমান কাজটি বাতিল করা হয়েছে। /admin দিয়ে আবার শুরু করতে পারেন।');
});

// =============================================
// ✅ ADMIN COMMANDS
// =============================================

// =============================================
// 📢 CHANNEL POSTING
// =============================================

bot.command('setlink', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  const directLink = args.slice(1).join(' ').trim();

  if (directLink) {
    if (!/^https?:\/\//i.test(directLink)) {
      return ctx.reply('❌ সঠিক http/https Direct Link দিন।');
    }
    try {
      await db.collection('system').doc('settings').set({
        helpAdminLink: directLink,
        updatedAt: Date.now()
      }, { merge: true });
      helpAdminLinkCache = directLink;
      helpAdminLinkCacheAt = Date.now();
      return ctx.reply('✅ Help Admin link সফলভাবে আপডেট হয়েছে।');
    } catch (error) {
      console.error('❌ /setlink save error:', error);
      return ctx.reply('❌ Link save করতে সমস্যা হয়েছে।');
    }
  }

  postData[ctx.from.id] = { step: 'setlink' };
  await ctx.reply(
    '🔗 নতুন Help Admin Direct Link পাঠান।\n\n' +
    'উদাহরণ:\nhttps://example.com/your-link'
  );
});

bot.command('post', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  if (!POST_CHANNEL) {
    return ctx.reply('❌ POST_CHANNEL সেট করা নেই। Render Environment Variables-এ POST_CHANNEL দিন।');
  }

  // Explicit /post switches to posting mode and clears Add Video/Topic.
  delete addVideoData[ctx.from.id];
  delete addTopicData[ctx.from.id];
  delete broadcastData[ctx.from.id];
  postData[ctx.from.id] = { step: 'mediaType', channels: [POST_CHANNEL] };
  await ctx.reply(
    '📢 Channel Post তৈরি করা হচ্ছে।\n\nকী পোস্ট করবেন?',
    Markup.inlineKeyboard([
      [Markup.button.callback('🎬 Video', 'post_type_video')],
      [Markup.button.callback('🖼️ Photo', 'post_type_photo')],
      [Markup.button.callback('❌ Cancel', 'post_cancel')]
    ])
  );
});

bot.action('post_type_video', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = postData[ctx.from.id];
  if (!state || state.step !== 'mediaType') return ctx.answerCbQuery('❌ /post দিয়ে আবার শুরু করুন');
  state.type = 'video';
  state.step = 'media';
  await ctx.answerCbQuery();
  await ctx.reply('🎬 এখন 2–3 সেকেন্ডের Preview Video পাঠান।\n\n⚠️ এটি Storage Channel-এ যাবে না।');
});

bot.action('post_type_photo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = postData[ctx.from.id];
  if (!state || state.step !== 'mediaType') return ctx.answerCbQuery('❌ /post দিয়ে আবার শুরু করুন');
  state.type = 'photo';
  state.step = 'media';
  await ctx.answerCbQuery();
  await ctx.reply('🖼️ এখন Channel Post-এর জন্য Photo পাঠান।\n\n⚠️ এটি Storage Channel-এ যাবে না।');
});

bot.action('post_cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  delete postData[ctx.from.id];
  await ctx.answerCbQuery('Cancelled');
  await ctx.reply('❌ Post বাতিল করা হয়েছে।');
});

async function recordTopicPost(topicId, channelId, messageId, type, caption = '', title = '') {
  if (!topicId || !channelId || !messageId) return;
  try {
    const record = {
      channelId: String(channelId),
      messageId: Number(messageId),
      type: type || 'video',
      caption: String(caption || ''),
      title: String(title || ''),
      postedAt: Date.now()
    };

    // Keep the old topic-level history for compatibility.
    const ref = db.collection('topics').doc(String(topicId));
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      const records = Array.isArray(data.postRecords) ? data.postRecords : [];
      records.push(record);
      await ref.update({ postRecords: records.slice(-50), updatedAt: new Date().toISOString() });
    }

    // Global index lets Admin -> Create Post -> Repost find posts without Topic ID.
    await db.collection('channelPosts').add({
      ...record,
      topicId: String(topicId),
      createdAt: Date.now()
    });
    invalidateTopicsCache();
    cleanupChannelPosts(channelId).catch(e => console.error('❌ channelPosts cleanup error:', e.message));
  } catch (e) {
    console.error('❌ Could not record channel post:', e.message);
  }
}

// This is a safety net against runaway/unbounded growth, not a real limit —
// at 2000 kept per channel it should never trigger in normal day-to-day use,
// so no repost history is lost. Cleanup is scoped per-channel now (not
// globally), so a channel you post to often can never crowd out or cause the
// cleanup of another channel's saved posts.
const CHANNEL_POSTS_CAP_PER_CHANNEL = 2000;
async function cleanupChannelPosts(channelId) {
  const wanted = String(channelId);
  const countSnap = await db.collection('channelPosts').where('channelId', '==', wanted).count().get();
  const total = countSnap.data().count || 0;
  if (total <= CHANNEL_POSTS_CAP_PER_CHANNEL) return;
  const excess = total - CHANNEL_POSTS_CAP_PER_CHANNEL;
  const oldSnap = await db.collection('channelPosts')
    .where('channelId', '==', wanted)
    .orderBy('postedAt', 'asc')
    .limit(excess)
    .get();
  if (oldSnap.empty) return;
  const batch = db.batch();
  oldSnap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// 📢 Repost list hygiene ---------------------------------------------------
// Messages that must NEVER show up in the Repost list: the copies the bot
// itself creates when reposting, and old posts that no longer exist in the
// channel. They're remembered per channel (one small doc, arrayUnion) so the
// list stays clean no matter which code path or old record tries to add them.
async function hideFromRepostList(channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    await db.collection('repostHidden').doc(String(channelId)).set({
      ids: admin.firestore.FieldValue.arrayUnion(Number(messageId)),
      updatedAt: Date.now()
    }, { merge: true });
  } catch (e) {
    console.error('❌ hideFromRepostList error:', e.message);
  }
}

async function getRepostHiddenIds(channelId) {
  try {
    const ref = db.collection('repostHidden').doc(String(channelId));
    const snap = await ref.get();
    let ids = snap.exists && Array.isArray(snap.data().ids) ? snap.data().ids.map(Number).filter(Number.isFinite) : [];
    if (ids.length > 6000) {
      // Keep the list from growing forever: message IDs only ever increase, so
      // the highest ones are the ones that can still appear in the list.
      ids = ids.sort((a, b) => a - b).slice(-3000);
      ref.set({ ids, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    }
    return new Set(ids);
  } catch (e) {
    console.warn('⚠️ Could not read repost hidden ids:', e.message);
    return new Set();
  }
}

function repostSignature(p) {
  const hasTopic = p.topicId && p.topicId !== 'repost';
  const cap = String(p.caption || p.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!hasTopic && !cap) return `msg:${p.messageId}`; // nothing to compare → keep separate
  return `${hasTopic ? p.topicId : ''}|${p.type || ''}|${cap}`;
}

async function getRepostPostsForChannel(channelId) {
  const wanted = String(channelId || '');
  const map = new Map();

  // New global records: caption + exact message metadata are available.
  // Filtered by channelId *in the query itself* — not fetched-then-filtered —
  // so a channel you post to less often never gets crowded out of the most
  // recent 300 posts by a channel you post to constantly.
  try {
    const snap = await db.collection('channelPosts')
      .where('channelId', '==', wanted)
      .orderBy('postedAt', 'desc')
      .limit(300)
      .get();
    snap.docs.forEach(doc => {
      const d = doc.data() || {};
      const key = `${d.channelId}:${d.messageId}`;
      if (!map.has(key)) map.set(key, { id: doc.id, ...d, legacy: false });
    });
  } catch (e) {
    console.warn('⚠️ channelPosts index unavailable:', e.message);
  }

  // Legacy topic-level records: posts saved by older versions of the bot,
  // before the channelPosts index existed. Always merged in (not just when
  // the new index is empty) so a channel's oldest posts never silently
  // disappear from the Repost list just because it also has newer posts.
  const topics = await getTopicsCached();
  topics.forEach(t => {
      const records = Array.isArray(t.postRecords) ? t.postRecords : [];
      records.forEach(r => {
        if (String(r.channelId) !== wanted || !r.messageId) return;
        const key = `${r.channelId}:${r.messageId}`;
        if (!map.has(key)) {
          map.set(key, {
            channelId: String(r.channelId),
            messageId: Number(r.messageId),
            type: r.type || 'video',
            caption: String(r.caption || ''),
            title: String(r.title || t.title || ''),
            topicId: t.id,
            postedAt: Number(r.postedAt) || 0,
            legacy: true
          });
        }
      });
    });

  // 1) Drop copies made by Repost itself + posts known to be gone.
  const hidden = await getRepostHiddenIds(wanted);
  const sorted = Array.from(map.values())
    .filter(p => !hidden.has(Number(p.messageId)))
    .sort((a,b) => (Number(b.postedAt)||0) - (Number(a.postedAt)||0));

  // 2) One button per piece of content. The same topic + caption + media type
  // can be recorded several times (scheduled repeats, posting again, records
  // left over from older versions) — that's what showed up as duplicate
  // buttons. Keep the NEWEST as the button and remember the older message IDs
  // as fallbacks in case the newest was deleted from the channel.
  const groups = new Map();
  for (const p of sorted) {
    const sig = repostSignature(p);
    const g = groups.get(sig);
    if (!g) groups.set(sig, { ...p, fallbackIds: [], duplicateCount: 1 });
    else { g.fallbackIds.push(Number(p.messageId)); g.duplicateCount++; }
  }
  return Array.from(groups.values());
}

bot.action(/^sched_repeat:(none|daily|weekly)$/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const userId = ctx.from.id;
  const state = postData[userId];
  if (!state || state.step !== 'schedule_repeat' || !state.scheduleTime) {
    return ctx.answerCbQuery('❌ Schedule data পাওয়া যায়নি। /post দিয়ে আবার শুরু করুন');
  }
  const recurrence = ctx.match[1] === 'none' ? null : ctx.match[1];
  const parsed = state.scheduleTime;
  try { await ctx.answerCbQuery(); } catch (e) {}
  try {
    const docRef = await db.collection('scheduledPosts').add({
      channels: (state.channels && state.channels.length) ? state.channels : (POST_CHANNEL ? [POST_CHANNEL] : []),
      type: state.type,
      fileId: state.fileId,
      caption: state.caption || '',
      topicId: state.topicId,
      // 🐛 FIX: the topic's title used to be shown wherever this schedule
      // shows up later (the Scheduled Posts list, the "sent" notification),
      // making it easy to tell at a glance which content a schedule was
      // for. It was being tracked in `state` the whole time (set back when
      // the topic ID was first entered) but never actually saved onto the
      // scheduledPosts doc itself — so every list/notification downstream
      // could only ever show the raw Topic ID, which isn't readable. Saving
      // it here (once, at schedule time) means it survives even if the
      // topic is later renamed or deleted.
      title: state.title || 'নামবিহীন ভিডিও',
      scheduledAt: parsed,
      recurrence, // null | 'daily' | 'weekly'
      status: 'pending',
      createdBy: userId,
      createdAt: Date.now()
    });
    delete postData[userId];
    schedulePostTimer(docRef.id, parsed - Date.now());
    const repeatLabel = recurrence === 'daily' ? '\n🔁 প্রতিদিন এই সময়ে repeat হবে (বাতিল না করা পর্যন্ত)।'
      : recurrence === 'weekly' ? '\n🔁 প্রতি সপ্তাহে এই সময়ে repeat হবে (বাতিল না করা পর্যন্ত)।'
      : '';
    return ctx.reply(
      `✅ Post Schedule হয়েছে!\n\n📌 Title: ${state.title || 'নামবিহীন ভিডিও'}\n🆔 Schedule ID: <code>${docRef.id}</code>\n📅 সময়: ${formatDhakaDateTime(parsed)}${repeatLabel}\n\nনির্ধারিত সময়ে এটা নিজে থেকেই Channel-এ Post হয়ে যাবে।`,
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup }
    );
  } catch (error) {
    console.error('❌ Schedule save error:', error.message);
    return ctx.reply('❌ Schedule সেভ করতে সমস্যা হয়েছে: ' + error.message);
  }
});

bot.action('post_schedule', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const userId = ctx.from.id;
  const state = postData[userId];
  if (!state || state.step !== 'confirm' || !state.fileId || !state.topicId) {
    return ctx.answerCbQuery('❌ Post data পাওয়া যায়নি। /post দিয়ে আবার শুরু করুন');
  }
  state.step = 'schedule_time';
  try { await ctx.answerCbQuery(); } catch (e) {}
  return ctx.reply(
    `🕒 কখন Post হবে লিখুন (ঢাকা সময়):\n\nশুধু সময় দিলেই হবে (আজ/আগামীকাল automatic বুঝে নেবে):\n<code>9:30 PM</code>\n\nঅথবা নির্দিষ্ট তারিখসহ:\n<code>2026-09-20 9:30 PM</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.action('post_confirm', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const userId = ctx.from.id;
  const state = postData[userId];

  if (!state || state.step !== 'confirm' || !state.fileId || !state.topicId) {
    return ctx.answerCbQuery('❌ Post data পাওয়া যায়নি। /post দিয়ে আবার শুরু করুন');
  }
  const postingChannels = (state.channels && state.channels.length) ? state.channels : (POST_CHANNEL ? [POST_CHANNEL] : []);
  if (!postingChannels.length) return ctx.answerCbQuery('❌ Posting Channel সেট করা নেই');

  const helpLink = await getHelpAdminLink();
  if (!helpLink) return ctx.answerCbQuery('❌ /setlink দিয়ে Help Admin link সেট করুন');

  await ctx.answerCbQuery('Posting...');
  try {
    const keyboard = await buildConfiguredPostKeyboard(state.topicId);
    const lines = [];

    for (const postingChannel of postingChannels) {
      try {
        let sent;
        if (state.type === 'video') {
          sent = await bot.telegram.sendVideo(postingChannel, state.fileId, {
            caption: state.caption || undefined,
            reply_markup: keyboard.reply_markup
          });
        } else {
          sent = await bot.telegram.sendPhoto(postingChannel, state.fileId, {
            caption: state.caption || undefined,
            reply_markup: keyboard.reply_markup
          });
        }
        await recordTopicPost(state.topicId, postingChannel, sent.message_id, state.type, state.caption || '', state.topicId);
        lines.push(`✅ ${postingChannel} — Message ID: ${sent.message_id}`);
      } catch (chErr) {
        console.error(`❌ /post publish error [${postingChannel}]:`, chErr.message);
        lines.push(`❌ ${postingChannel} — ${chErr.message}`);
      }
    }

    delete postData[userId];
    await ctx.reply(
      `📤 Post সম্পন্ন হয়েছে (${postingChannels.length}টি Channel):\n\n` +
      `🆔 Video/Topic ID: <code>${escapeHtml(state.topicId)}</code>\n\n` +
      escapeHtml(lines.join('\n')),
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup }
    );
  } catch (error) {
    console.error('❌ /post publish error:', error);
    await ctx.reply(
      '❌ Channel-এ Post করা যায়নি।\n\n' +
      'চেক করুন:\n' +
      '• Bot-কে Posting Channel-এর Admin করা হয়েছে কিনা\n' +
      '• Bot-এর Post Messages permission আছে কিনা\n' +
      '• POST_CHANNEL ঠিক আছে কিনা'
    );
  }
});

bot.command('rename', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  renameData[ctx.from.id] = { step: 'id' };
  await ctx.reply('✏️ Video/Topic ID পাঠান:');
});

bot.command('thumbnail', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  thumbnailData[ctx.from.id] = { step: 'id' };
  await ctx.reply('🖼️ Video/Topic ID পাঠান:');
});

bot.command('limit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  if (args[1]) {
    const value = Number(args[1]);
    if (!Number.isInteger(value) || value < 1 || value > 1000) return ctx.reply('❌ Limit 1-1000 এর মধ্যে হতে হবে।');
    await db.collection('system').doc('settings').set({ dailyAdLimit: value }, { merge: true });
    dailyLimitCache = value; invalidateDailyLimitCache(); dailyLimitCacheAt = Date.now();
    return ctx.reply(`✅ Daily Ad Limit এখন ${value}টি।`);
  }
  const current = await getDailyAdLimit();
  delete renameData[ctx.from.id];
  await ctx.reply(`📊 বর্তমান Daily Ad Limit: ${current}টি\n\nনতুন limit লিখুন। উদাহরণ: 20`);
  updateAdsData[ctx.from.id] = { step: 'dailyLimit' };
});

bot.command('ads', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    updateAdsData[ctx.from.id] = { step: 'topicId' };
    await ctx.reply(
      '🎬 কোন ভিডিও/টপিকের Ads count পরিবর্তন করতে চান?\n\n' +
      '👉 এখন শুধু Video/Topic ID পাঠান।\n\n' +
      'উদাহরণ: abc123'
    );
  } catch (error) {
    console.error('❌ Error starting /ads:', error);
    await ctx.reply('❌ /ads শুরু করতে সমস্যা হয়েছে: ' + error.message);
  }
});

async function moveTopic(topicId, direction) {
  const topics = await getTopicsCached();
  if (!topics.length) throw new Error('NO_TOPICS');
  const index = topics.findIndex(t => t.id === topicId);
  if (index === -1) throw new Error('NOT_FOUND');
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= topics.length) return { edge: true, topic: topics[index] };

  const a = topics[index];
  const b = topics[targetIndex];
  const aOrder = Number(a.sortOrder);
  const bOrder = Number(b.sortOrder);

  if (Number.isFinite(aOrder) && Number.isFinite(bOrder) && aOrder !== bOrder) {
    const batch = db.batch();
    batch.update(db.collection('topics').doc(a.id), { sortOrder: bOrder });
    batch.update(db.collection('topics').doc(b.id), { sortOrder: aOrder });
    await batch.commit();
  } else {
    const reordered = topics.slice();
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    const batch = db.batch();
    reordered.forEach((topic, i) => batch.update(db.collection('topics').doc(topic.id), { sortOrder: reordered.length - i }));
    await batch.commit();
  }
  invalidateTopicsCache();
  return { edge: false, topic: b, swappedWith: a };
}

bot.command('up', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  const topicId = args[1];
  if (!topicId) return ctx.reply('⬆️ ব্যবহার: /up VIDEO_ID\n\nউদাহরণ: /up abc123');
  try {
    const result = await moveTopic(topicId, 'up');
    if (result.edge) return ctx.reply('⬆️ এই ভিডিওটি ইতোমধ্যে সবার উপরে আছে।');
    await ctx.reply(`✅ ভিডিওটি ১ ধাপ উপরে নেওয়া হয়েছে।\n\n📌 ${result.topic.title || 'নামবিহীন টপিক'}\n🆔 <code>${topicId}</code>`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি।');
    console.error('❌ /up error:', error);
    return ctx.reply('❌ ভিডিও উপরে নিতে সমস্যা হয়েছে।');
  }
});

bot.command('down', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  const topicId = args[1];
  if (!topicId) return ctx.reply('⬇️ ব্যবহার: /down VIDEO_ID\n\nউদাহরণ: /down abc123');
  try {
    const result = await moveTopic(topicId, 'down');
    if (result.edge) return ctx.reply('⬇️ এই ভিডিওটি ইতোমধ্যে সবার নিচে আছে।');
    await ctx.reply(`✅ ভিডিওটি ১ ধাপ নিচে নেওয়া হয়েছে।\n\n📌 ${result.topic.title || 'নামবিহীন টপিক'}\n🆔 <code>${topicId}</code>`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি।');
    console.error('❌ /down error:', error);
    return ctx.reply('❌ ভিডিও নিচে নিতে সমস্যা হয়েছে।');
  }
});

bot.command('list', async (ctx) => {
  try {
    console.log('📋 /list command by:', ctx.from.id);
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    await ctx.reply('⏳ তালিকা তৈরি হচ্ছে...');

    const topics = await getTopicsCached();
    if (!topics.length) {
      return ctx.reply('📭 এখনো কোনো টপিক যোগ করা হয়নি।');
    }

    const entries = topics.map((data) => {
      const id = escapeHtml(data.id);
      const title = escapeHtml(data.title || 'নামবিহীন');
      const videoCount = Number(data.videoCount || (Array.isArray(data.videos) ? data.videos.length : 0)) || 0;
      const views = Number(data.unlockCount || data.unlocks || data.views) || 0;
      const ads = Number(data.adsRequired || 0) || 0;
      return `📌 ${title}\n   🆔 <code>${id}</code>\n   📹 ${videoCount}টি ভিডিও\n   👁️ ${views} ভিউ\n   🔢 ${ads}টি অ্যাড\n\n`;
    });
    await sendHtmlChunks(ctx, '📋 সব টপিক:\n\n', entries);
  } catch (error) {
    console.error('❌ Error in /list:', error);
    await ctx.reply('❌ তালিকা দেখাতে সমস্যা: ' + error.message);
  }
});

async function getUserCountsCached() {
  const now = Date.now();
  if (adminStatsCache && (now - adminStatsCacheAt) < 60 * 1000) return adminStatsCache;
  try {
    const [totalSnap, verifiedSnap] = await Promise.all([
      db.collection('users').count().get(),
      db.collection('users').where('verified', '==', true).count().get()
    ]);
    adminStatsCache = { totalUsers: totalSnap.data().count || 0, verifiedUsers: verifiedSnap.data().count || 0 };
  } catch (e) {
    const snap = await db.collection('users').get();
    adminStatsCache = { totalUsers: snap.size, verifiedUsers: snap.docs.reduce((n, d) => n + (d.data().verified === true ? 1 : 0), 0) };
  }
  adminStatsCacheAt = now;
  return adminStatsCache;
}

bot.command('admin', async (ctx) => {
  try {
    if (!adminOnly(ctx)) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    return sendAdminPanel(ctx);
  } catch (error) {
    console.error('❌ Error in /admin:', error);
    return ctx.reply('❌ Admin panel load করতে সমস্যা হয়েছে: ' + error.message);
  }
});

// =============================================
// 👑 BUTTON-BASED ADMIN PANEL
// =============================================
async function renderBulkTopicsPanel(ctx) {
  const topics = await getTopicsCached();
  if (!topics.length) {
    return ctx.editMessageText('📭 এখনো কোনো টপিক যোগ করা হয়নি।', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_videos')]]));
  }
  const totalPages = Math.max(1, Math.ceil(topics.length / BULK_PAGE_SIZE));
  if (bulkSelect.page >= totalPages) bulkSelect.page = totalPages - 1;
  if (bulkSelect.page < 0) bulkSelect.page = 0;
  const start = bulkSelect.page * BULK_PAGE_SIZE;
  const pageTopics = topics.slice(start, start + BULK_PAGE_SIZE);

  const rows = pageTopics.map(t => {
    const checked = bulkSelect.ids.has(t.id) ? '✅' : '⬜';
    const title = safeTruncate(t.title || 'নামবিহীন', 30);
    const ads = Number(t.adsRequired || 0) || 0;
    return [Markup.button.callback(`${checked} ${title} (${ads} ads)`, `blk:${t.id}`)];
  });

  const navRow = [];
  if (bulkSelect.page > 0) navRow.push(Markup.button.callback('◀️ Prev', 'blkpage:prev'));
  navRow.push(Markup.button.callback(`পাতা ${bulkSelect.page + 1}/${totalPages}`, 'adm_bulk_topics'));
  if (bulkSelect.page < totalPages - 1) navRow.push(Markup.button.callback('Next ▶️', 'blkpage:next'));
  rows.push(navRow);

  const n = bulkSelect.ids.size;
  rows.push([
    Markup.button.callback(`🗑️ Delete Selected (${n})`, 'adm_bulk_delete_prompt'),
    Markup.button.callback(`🔢 Set Ads (${n})`, 'adm_bulk_ads_prompt')
  ]);
  rows.push([Markup.button.callback('❌ Cancel / Clear', 'adm_bulk_cancel')]);

  const text = `🗂️ BULK SELECT TOPICS\n\nট্যাপ করে টপিক select/unselect করুন, তারপর নিচের বাটন দিয়ে Delete বা Ads Count বদলান।\n\nমোট টপিক: ${topics.length} | Selected: ${n}`;
  return ctx.editMessageText(text, Markup.inlineKeyboard(rows));
}

bot.action(/^adm_(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const action = ctx.match[1];
  console.log('👑 Admin button:', action, 'by', ctx.from && ctx.from.id);
  try { await ctx.answerCbQuery(); } catch (e) {}
  try {
  if (action === 'home') return sendAdminPanel(ctx, true);
  if (action === 'videos') {
    return ctx.editMessageText('🎬 VIDEO MANAGEMENT\n\nএখানে শুধু Video/Topic-এর নিজস্ব management থাকবে।\nPost ও Ads আলাদা Admin menu থেকে করা যাবে।', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Video', 'adm_add_video'), Markup.button.callback('📚 Add Topic', 'adm_add_topic')],
      [Markup.button.callback('📼 Existing Topic-এ Video যুক্ত করুন', 'adm_append_video')],
      [Markup.button.callback('🔍 Topic Search', 'adm_topic_search')],
      [Markup.button.callback('🆔 Video IDs', 'adm_video_ids')],
      [Markup.button.callback('✏️ Rename / Title', 'adm_video_rename')],
      [Markup.button.callback('🖼️ Thumbnail Edit', 'adm_video_thumb')],
      [Markup.button.callback('🗑️ Delete Video', 'adm_video_delete')],
      [Markup.button.callback('🗂️ Bulk Select (Delete/Ads)', 'adm_bulk_topics')],
      [Markup.button.callback('⬅️ Back', 'adm_home')]
    ]));
  }
  if (action === 'add_video') { startAddVideoWorkflow(ctx.from.id); return ctx.reply('📹 ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)।\n\n⚠️ এটি Channel Post নয়। আগে ভিডিও, তারপর Title → Thumbnail → Ads Count দিন।'); }
  if (action === 'add_topic') { startAddTopicWorkflow(ctx.from.id); return ctx.reply('📹 প্রথম ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)।\n\n⚠️ এটি Channel Post নয়। ভিডিওগুলো শেষে /done দিন, তারপর Title → Thumbnail → Ads Count।'); }
  if (action === 'append_video') {
    clearAdminWorkflow(ctx.from.id);
    appendVideoData[ctx.from.id] = { step: 'topicId' };
    return ctx.reply('📼 কোন Topic-এ ভিডিও যুক্ত করবেন?\n\n👉 Topic ID পাঠান, বা 🔍 Topic Search ব্যবহার করে সেখান থেকে "➕ Video যুক্ত করুন" চাপুন।');
  }
  if (action === 'topic_search') {
    clearAdminWorkflow(ctx.from.id);
    topicSearchData[ctx.from.id] = { step: 'query' };
    return ctx.reply('🔍 Topic-এর নাম বা ID লিখে পাঠান:');
  }
  if (action === 'list') {
    const topics = await getTopicsCached();
    if (!topics.length) return ctx.reply('📭 এখনো কোনো Video/Topic নেই।');
    const lines = topics.map((t, i) => {
      const count = Array.isArray(t.videos) ? t.videos.length : (t.videoId ? 1 : 0);
      return `${i + 1}. ${escapeHtml(t.title || 'নামবিহীন')}\n🆔 <code>${escapeHtml(t.id)}</code>\n📹 Videos: ${count} | 🎯 Ads: ${Number(t.adsRequired || 1)}`;
    });
    const text = `📋 ALL VIDEOS / TOPICS\n\n${lines.join('\n\n')}`;
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_videos')]]).reply_markup });
  }
  if (action === 'video_ids') {
    const topics = await getTopicsCached();
    if (!topics.length) return ctx.reply('📭 কোনো Video/Topic নেই।');

    const entries = topics.map((t, i) =>
      `${i + 1}. 📌 ${escapeHtml(t.title || 'নামবিহীন')}\n   🆔 <code>${escapeHtml(t.id)}</code>\n\n`
    );
    return sendHtmlChunks(ctx, '🆔 VIDEO/TOPIC IDS\n\n', entries);
  }
  if (action === 'video_rename') {
    renameData[ctx.from.id] = { step: 'id' };
    return ctx.reply('✏️ যে Video/Topic rename করতে চান তার ID পাঠান:');
  }
  if (action === 'video_thumb') {
    thumbnailData[ctx.from.id] = { step: 'id' };
    return ctx.reply('🖼️ যে Video/Topic-এর thumbnail বদলাবেন তার ID পাঠান:');
  }
  if (action === 'video_ads') {
    updateAdsData[ctx.from.id] = { step: 'topicId' };
    return ctx.reply('🎯 যে Video/Topic-এর Ads count বদলাবেন তার ID পাঠান:');
  }
  if (action === 'video_post') {
    clearAdminWorkflow(ctx.from.id);
    adminVideoData[ctx.from.id] = { step: 'post_id' };
    return ctx.reply('📤 যে Video/Topic Post করতে চান তার ID পাঠান:');
  }
  if (action === 'video_delete') {
    clearAdminWorkflow(ctx.from.id);
    adminVideoData[ctx.from.id] = { step: 'delete_id' };
    return ctx.reply('🗑️ যে Video/Topic delete করতে চান তার ID পাঠান:');
  }
  if (action === 'trending' || action === 'new' || action === 'popular') {
    return ctx.editMessageText('ℹ️ এই Admin Panel-এ Trending/New/Popular দরকার নেই। Mini App থেকেই এগুলো দেখুন।', Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Videos', 'adm_list')],
      [Markup.button.callback('⬅️ Back', 'adm_videos')]
    ]));
  }
  if (action === 'channels') {
    const channels = await getChannels();
    const rows = channels.map(ch => [Markup.button.callback(`${ch.active === false ? '🔴' : '🟢'} ${safeTruncate(ch.name||ch.channelId, 35)}`, `ach_view:${ch.id || ch.channelId}`)]);
    rows.push([Markup.button.callback('➕ Add Channel', 'ach_add')]);
    rows.push([Markup.button.callback('⬅️ Back', 'adm_home')]);
    return ctx.editMessageText('📢 CHANNEL MANAGER\n\nএকটি Channel নির্বাচন করুন:', Markup.inlineKeyboard(rows));
  }
  if (action === 'create_post') {
    return ctx.editMessageText('📤 CREATE POST', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Create New Post', 'adm_new_post')],
      [Markup.button.callback('📢 Repost Post', 'adm_repost')],
      [Markup.button.callback('⬅️ Back', 'adm_home')]
    ]));
  }
  if (action === 'new_post') {
    clearAdminWorkflow(ctx.from.id);
    channelPickData[ctx.from.id] = { mode: 'new_post', selected: new Set() };
    return renderChannelPicker(ctx);
  }
  if (action === 'repost') {
    clearAdminWorkflow(ctx.from.id);
    repostData[ctx.from.id] = { step: 'channel' };
    const channels = await getChannels();
    // Index must match the FULL channels array (that's what the handler below
    // looks up by), not the filtered/active-only list — otherwise once any
    // channel is inactive, every button after it points at the wrong channel.
    const rows = channels
      .map((ch, i) => (ch.active === false ? null : [Markup.button.callback(`📢 ${safeTruncate(ch.name||ch.channelId, 35)}`, `repost_channel:${i}`)]))
      .filter(Boolean);
    if (!rows.length && POST_CHANNEL) rows.push([Markup.button.callback('📢 Posting Channel', `repost_channel:default`)]);
    rows.push([Markup.button.callback('📥 Forward করে যোগ করুন', 'adm_repost_forward')]);
    rows.push([Markup.button.callback('⬅️ Back', 'adm_create_post')]);
    return ctx.editMessageText('📢 REPOST POST\n\nকোন Channel-এর পুরোনো Post repost করতে চান?', Markup.inlineKeyboard(rows));
  }
  if (action === 'repost_forward') {
    clearAdminWorkflow(ctx.from.id);
    forwardRepostData[ctx.from.id] = { step: 'awaiting_forward' };
    return ctx.editMessageText(
      '📥 FORWARD করে Repost list-এ যোগ করুন\n\nযে Channel Post-টা list-এ যোগ করতে চান, সেটা এখানে Forward করুন।\n\n⚠️ Channel-টা অবশ্যই আগে Channel Manager-এ add করা থাকতে হবে।',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_repost')]])
    );
  }
  if (action === 'analytics' || action === 'dashboard') {
    const counts = await getUserCountsCached(); const topics = await getTopicsCached();
    const totalViews = topics.reduce((n,t)=>n+(Number(t.unlockCount)||0),0); const today=getDhakaDateKey(); const todayViews=topics.reduce((n,t)=>n+(t.dailyUnlockDate===today?(Number(t.dailyUnlockCount)||0):0),0);
    return ctx.editMessageText(`📊 ${action==='dashboard'?'DASHBOARD':'ANALYTICS'}\n\n👥 Users: ${counts.totalUsers}\n🎬 Videos/Topics: ${topics.length}\n👁️ Total Views: ${totalViews.toLocaleString('en-US')}\n📅 Today: ${todayViews.toLocaleString('en-US')}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back','adm_home')]]));
  }
  if (action === 'users') return ctx.reply('👥 User Management\n\nপুরোনো /user command-এর একই user data ব্যবহার করা হবে।', Markup.inlineKeyboard([[Markup.button.callback('📋 User List','adm_userlist'), Markup.button.callback('🔍 Search User','adm_user_search')],[Markup.button.callback('⬅️ Back','adm_home')]]));
  if (action === 'user_search') { userSearchData[ctx.from.id] = { step: 'query' }; return ctx.reply('🔍 নাম, Username অথবা User ID লিখে পাঠান:'); }
  if (action === 'userlist') { adminUserCursor=null; adminUserPage=1; const snap=await db.collection('users').orderBy('createdAt','desc').limit(25).get(); if(snap.empty) return ctx.reply('📭 কোনো user নেই।'); adminUserCursor=snap.docs[snap.docs.length-1]; return sendUserPage(ctx,snap.docs,1); }
  if (action === 'ads') return ctx.reply('📺 Ads Management', Markup.inlineKeyboard([[Markup.button.callback('🎯 Set Video Ads','adm_set_ads')],[Markup.button.callback('🎯 Daily Limit','adm_daily_limit')],[Markup.button.callback('⬅️ Back','adm_home')]]));
  if (action === 'set_ads') { updateAdsData[ctx.from.id]={step:'topicId'}; return ctx.reply('🎯 Video/Topic ID পাঠান:'); }
  if (action === 'daily_limit') { const current=await getDailyAdLimit(); updateAdsData[ctx.from.id]={step:'dailyLimit'}; return ctx.reply(`📊 বর্তমান Daily Ad Limit: ${current}টি\n\nনতুন limit লিখুন:`); }
  if (action === 'revenue') {
    const [stats, cpm] = await Promise.all([getAdStats(), getAdCpm()]);
    const estTotalRevenue = (stats.totalAdViews / 1000) * cpm;
    const estTodayRevenue = (stats.todayAdViews / 1000) * cpm;
    let text = `💰 REVENUE\n\n` +
      `📺 মোট Ad Views: ${stats.totalAdViews.toLocaleString('en-US')}\n` +
      `📅 আজকের Ad Views: ${stats.todayAdViews.toLocaleString('en-US')}\n\n` +
      `⚙️ CPM (প্রতি ১০০০ view): ${cpm} ৳\n` +
      `💵 আনুমানিক মোট আয় (estimate): ${estTotalRevenue.toFixed(2)} ৳\n` +
      `💵 আনুমানিক আজকের আয় (estimate): ${estTodayRevenue.toFixed(2)} ৳\n`;
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...{ reply_markup: Markup.inlineKeyboard([[Markup.button.callback('⚙️ CPM সেট করুন', 'adm_set_cpm')], [Markup.button.callback('⬅️ Back', 'adm_home')]]).reply_markup } });
  }
  if (action === 'set_cpm') {
    const current = await getAdCpm();
    updateAdsData[ctx.from.id] = { step: 'adCpm' };
    return ctx.reply(`⚙️ বর্তমান CPM: ${current} ৳ (প্রতি ১০০০ ad view)\n\nনতুন CPM সংখ্যা লিখুন (উদাহরণ: 40):`);
  }
  if (action === 'export') {
    try {
      const [topicsSnap, counts] = await Promise.all([
        db.collection('topics').get(),
        getUserCountsCached()
      ]);
      const topics = topicsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const payload = {
        exportedAt: new Date().toISOString(),
        summary: { totalUsers: counts.totalUsers, verifiedUsers: counts.verifiedUsers, totalTopics: topics.length },
        topics
      };
      const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
      const filename = `backup-${getDhakaDateKey()}.json`;
      await ctx.replyWithDocument({ source: buffer, filename }, { caption: `📦 Backup তৈরি হয়েছে — ${topics.length}টি topic, ${counts.totalUsers} users।` });
      return;
    } catch (error) {
      console.error('❌ Export error:', error.message);
      return ctx.reply('❌ Export করতে সমস্যা হয়েছে: ' + error.message);
    }
  }
  if (action === 'scheduled') {
    return renderScheduledPostsList(ctx);
  }
  if (action === 'bulk_topics') { return renderBulkTopicsPanel(ctx); }
  if (action === 'bulk_cancel') {
    bulkSelect = { ids: new Set(), page: 0 };
    return ctx.editMessageText('🗂️ Bulk selection clear করা হয়েছে।', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_videos')]]));
  }
  if (action === 'bulk_delete_prompt') {
    if (!bulkSelect.ids.size) { return renderBulkTopicsPanel(ctx); }
    return ctx.editMessageText(`⚠️ আপনি ${bulkSelect.ids.size}টি টপিক স্থায়ীভাবে DELETE করতে চলেছেন। এটা Undo করা যাবে না।\n\nনিশ্চিত?`, Markup.inlineKeyboard([
      [Markup.button.callback('✅ হ্যাঁ, Delete করো', 'adm_bulk_delete_yes'), Markup.button.callback('❌ না, Cancel', 'adm_bulk_delete_no')]
    ]));
  }
  if (action === 'bulk_delete_yes') {
    const ids = Array.from(bulkSelect.ids);
    let deleted = 0;
    for (const id of ids) {
      try { await db.collection('topics').doc(id).delete(); deleted++; } catch (e) { console.error('❌ bulk delete error for', id, e.message); }
    }
    invalidateTopicsCache();
    bulkSelect = { ids: new Set(), page: 0 };
    return ctx.editMessageText(`✅ ${deleted}টি টপিক delete করা হয়েছে।`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_videos')]]));
  }
  if (action === 'bulk_delete_no') { return renderBulkTopicsPanel(ctx); }
  if (action === 'bulk_ads_prompt') {
    if (!bulkSelect.ids.size) { return renderBulkTopicsPanel(ctx); }
    updateAdsData[ctx.from.id] = { step: 'bulkAdsCount', ids: Array.from(bulkSelect.ids) };
    return ctx.reply(`🔢 ${bulkSelect.ids.size}টি selected টপিকের জন্য নতুন Ads Required সংখ্যা লিখুন:`);
  }
  if (action === 'broadcast') { broadcastData[ctx.from.id]={step:'content'}; return ctx.reply('📣 Broadcast content পাঠান।\n🖼️ Photo / 🎬 Video / ✏️ Text'); }
  if (action === 'buttons') {
    const bs=await getPostButtons();
    const rows=bs.map((b,i)=>[
      Markup.button.callback(`${i+1}. ${safeTruncate(b.name, 20)}`,'ab_edit:'+i),
      Markup.button.callback(i===0?'　':'⬆️','ab_up:'+i),
      Markup.button.callback(i===bs.length-1?'　':'⬇️','ab_down:'+i),
      Markup.button.callback('🗑️','ab_del:'+i)
    ]);
    rows.push([Markup.button.callback('➕ Add Button','ab_add')]);
  rows.push([Markup.button.callback('⬅️ Back','adm_home')]);
    return ctx.editMessageText('🔘 POST BUTTON MANAGER\n\nএই saved buttons নতুন post-এ automatic থাকবে। ⬆️⬇️ দিয়ে ক্রম বদলাতে পারবেন।',Markup.inlineKeyboard(rows));
  }
  } catch (error) {
    console.error('❌ Admin button error [' + action + ']:', error);
    try { await ctx.answerCbQuery('❌ কাজটি করা যায়নি'); } catch (e) {}
    return ctx.reply('❌ Admin action-এ সমস্যা হয়েছে।\n\n' + (error.message || 'Unknown error'));
  }
});



// Video detail/actions
bot.action(/^aview:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const id=ctx.match[1]; const doc=await db.collection('topics').doc(id).get();
  if(!doc.exists) return ctx.answerCbQuery('❌ Video পাওয়া যায়নি');
  const t=doc.data(); await ctx.answerCbQuery();
  return ctx.editMessageText(`🎬 VIDEO DETAILS\n\n📌 ${escapeHtml(t.title||'নামবিহীন')}\n🆔 <code>${escapeHtml(id)}</code>\n📹 Videos: ${t.videoCount||0}\n🎯 Ads: ${t.adsRequired||1}\n👁️ Views: ${Number(t.unlockCount||0)}`,{ parse_mode: 'HTML', ...Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Rename','av_rename:'+id),Markup.button.callback('🖼️ Thumbnail','av_thumb:'+id)],
    [Markup.button.callback('🎯 Ads','av_ads:'+id),Markup.button.callback('📤 Post','apost_topic:'+id)],
    [Markup.button.callback('📼 Video যুক্ত করুন','av_append:'+id),Markup.button.callback('🧬 Duplicate','av_duplicate:'+id)],
    [Markup.button.callback('🗑️ Delete','av_delete:'+id)],
    [Markup.button.callback('⬅️ Back','adm_list')]
  ])});
});
bot.action(/^av_rename:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); renameData[ctx.from.id]={step:'title',topicId:ctx.match[1]}; const d=await db.collection('topics').doc(ctx.match[1]).get(); return ctx.reply(`✏️ Current: ${d.exists?(d.data().title||'নামবিহীন'):'নেই'}\n\nনতুন Title পাঠান:`); });
bot.action(/^av_thumb:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); thumbnailData[ctx.from.id]={step:'photo',topicId:ctx.match[1]}; return ctx.reply('🖼️ নতুন Thumbnail Photo পাঠান:'); });
bot.action(/^av_ads:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); updateAdsData[ctx.from.id]={step:'count',topicId:ctx.match[1]}; const d=await db.collection('topics').doc(ctx.match[1]).get(); return ctx.reply(`🎯 Current Ads: ${d.exists?(d.data().adsRequired||1):1}\n\nনতুন Ads count পাঠান:`); });
bot.action(/^av_append:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const id = ctx.match[1];
  const d = await db.collection('topics').doc(id).get();
  if (!d.exists) return ctx.answerCbQuery('❌ Topic পাওয়া যায়নি');
  await ctx.answerCbQuery();
  startAppendVideoWorkflow(ctx.from.id, id);
  const t = d.data();
  return ctx.reply(`📼 নতুন ভিডিওটি পাঠান, এটি এই Topic-এই যুক্ত হবে:\n\n📌 ${t.title||'নামবিহীন'}\n📹 বর্তমান ভিডিও: ${t.videoCount||0}`);
});
bot.action(/^av_duplicate:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const id = ctx.match[1];
  const d = await db.collection('topics').doc(id).get();
  if (!d.exists) return ctx.answerCbQuery('❌ Topic পাওয়া যায়নি');
  await ctx.answerCbQuery();
  const t = d.data();
  startDuplicateTopicWorkflow(ctx.from.id, { id, title: t.title, thumbnail: t.thumbnail, adsRequired: t.adsRequired });
  return ctx.reply(`🧬 Duplicate করা হচ্ছে: ${t.title||'নামবিহীন'}\n\nটাইটেল, থাম্বনেইল ও অ্যাড কাউন্ট একই থাকবে — শুধু নতুন ভিডিও(গুলো) পাঠান।\n\nএক বা একাধিক ভিডিও পাঠান, শেষ হলে /done লিখুন।`);
});
bot.action(/^av_delete:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const id = ctx.match[1];
  const d = await db.collection('topics').doc(id).get();
  await ctx.answerCbQuery();
  const title = d.exists ? (d.data().title || 'নামবিহীন') : 'নামবিহীন';
  return ctx.editMessageText(
    `⚠️ আপনি কি নিশ্চিত?\n\n📌 ${escapeHtml(title)}\n🆔 <code>${escapeHtml(id)}</code>\n\nএকবার Delete করলে এটি আর ফেরত আনা যাবে না।`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ হ্যাঁ, Delete করুন', 'av_delete_confirm:'+id), Markup.button.callback('❌ বাতিল', 'aview:'+id)]
    ]) }
  );
});
bot.action(/^av_delete_confirm:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  await db.collection('topics').doc(ctx.match[1]).delete();
  invalidateTopicsCache();
  await ctx.answerCbQuery('Deleted');
  return ctx.editMessageText('✅ Video/Topic delete হয়েছে।', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_list')]]));
});
bot.action(/^apost_topic:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const topicId=ctx.match[1]; channelPickData[ctx.from.id]={mode:'topic_post',topicId,selected:new Set()}; await ctx.answerCbQuery(); return renderChannelPicker(ctx); });
bot.action(/^apostch_topic:([^:]+):(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); delete adminVideoData[ctx.from.id]; let ch=ctx.match[1]; const doc=await db.collection('channels').doc(ch).get(); if(doc.exists)ch=doc.data().channelId; const topicId=ctx.match[2]; const td=await db.collection('topics').doc(topicId).get(); if(!td.exists)return ctx.answerCbQuery('❌ Video নেই'); const t=td.data(); const fileId=(t.videos&&t.videos[0])||t.videoId||''; if(!fileId)return ctx.answerCbQuery('❌ Video file পাওয়া যায়নি'); const kb=await buildConfiguredPostKeyboard(topicId); await ctx.answerCbQuery('Posting...'); try{const sent=await bot.telegram.sendVideo(ch,fileId,{caption:t.title||'',reply_markup:kb.reply_markup}); await recordTopicPost(topicId,ch,sent.message_id,'video',t.title||'',t.title||''); return ctx.reply(`✅ Post হয়েছে\n📢 ${ch}\n🆔 Message ID: ${sent.message_id}`, { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });}catch(e){return ctx.reply('❌ Channel-এ post করা যায়নি: '+e.message);} });

// =============================================
// 📢 REPOST: Channel -> saved captions -> instant copy
// =============================================
bot.action(/^repost_channel:(\d+|default)$/, async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const key = ctx.match[1];
  const channels = await getChannels();
  let channel = key === 'default'
    ? { channelId: POST_CHANNEL, name: 'Posting Channel' }
    : channels[Number(key)];

  if (!channel || !channel.channelId) return ctx.answerCbQuery('❌ Channel পাওয়া যায়নি');
  const channelId = String(channel.channelId);
  await ctx.answerCbQuery();

  const posts = await getRepostPostsForChannel(channelId);
  if (!posts.length) {
    return ctx.editMessageText(
      `📢 ${channel.name || channelId}\n\n📭 এই Channel-এর কোনো saved Post পাওয়া যায়নি।\n\nনতুন Post করলে পরের বার Repost list-এ থাকবে।`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_repost')]])
    );
  }

  repostData[ctx.from.id] = { step: 'post', channelId, channelName: channel.name || channelId, posts, page: 1 };
  return renderRepostPage(ctx, ctx.from.id, 1);
});

const REPOST_PAGE_SIZE = 10;
// Prevent double-click / Telegram retry races from copying the same source
// post multiple times concurrently. The lock is per admin + source message,
// so different posts can still be reposted normally.
const repostInFlight = new Map();
function repostLockKey(userId, rec) {
  return `${String(userId)}:${String(rec.channelId)}:${String(rec.messageId)}`;
}
function renderRepostPage(ctx, userId, page) {
  const state = repostData[userId];
  if (!state || !state.posts) return ctx.answerCbQuery('❌ Repost data পাওয়া যায়নি');
  const posts = state.posts;
  const totalPages = Math.max(1, Math.ceil(posts.length / REPOST_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);
  state.page = page;
  const start = (page - 1) * REPOST_PAGE_SIZE;
  const slice = posts.slice(start, start + REPOST_PAGE_SIZE);

  const rows = slice.map((p, i) => {
    const globalIndex = start + i;
    const caption = String(p.caption || p.title || '(Caption নেই)').replace(/\s+/g, ' ').trim();
    const media = p.type === 'photo' ? '🖼️' : '🎬';
    const date = p.postedAt ? new Date(Number(p.postedAt)).toLocaleDateString('en-GB') : '';
    return [Markup.button.callback(`${media} ${safeTruncate(caption, 48)}${date ? ` • ${date}` : ''}`, `repost_post:${globalIndex}`)];
  });

  const navRow = [];
  if (page > 1) navRow.push(Markup.button.callback('⬅️ আগের পেজ', 'repost_page:'+(page-1)));
  if (page < totalPages) navRow.push(Markup.button.callback('পরের পেজ ➡️', 'repost_page:'+(page+1)));
  if (navRow.length) rows.push(navRow);
  rows.push([Markup.button.callback('⬅️ Channel Select', 'adm_repost')]);

  const text = `📢 ${state.channelName || state.channelId}\n\nযে Caption-এর Post Repost করতে চান সেটিতে চাপুন:\n📄 পেজ ${page}/${totalPages} (মোট ${posts.length}টি)`;
  return ctx.editMessageText(text, Markup.inlineKeyboard(rows)).catch(() => ctx.reply(text, Markup.inlineKeyboard(rows)));
}

bot.action(/^repost_page:(\d+)$/, async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  await ctx.answerCbQuery();
  return renderRepostPage(ctx, ctx.from.id, Number(ctx.match[1]));
});

bot.action(/^repost_post:(\d+)$/, async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = repostData[ctx.from.id];
  const index = Number(ctx.match[1]);
  if (!state || state.step !== 'post' || !state.posts || !state.posts[index]) {
    return ctx.answerCbQuery('❌ Repost data পাওয়া যায়নি');
  }
  const rec = state.posts[index];
  await ctx.answerCbQuery();
  const date = rec.postedAt ? new Date(Number(rec.postedAt)).toLocaleDateString('en-GB') : 'অজানা';
  const media = rec.type === 'photo' ? '🖼️ Photo' : '🎬 Video';
  return ctx.editMessageText(
    `⚠️ Repost Preview — ঠিক আছে তো?\n\n📢 Channel: ${rec.channelId}\n📦 Type: ${media}\n📅 আগে posted: ${date}\n📝 Caption:\n${String(rec.caption || rec.title || '(Caption নেই)').slice(0, 400)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ হ্যাঁ, Repost করুন', 'repost_confirm:'+index), Markup.button.callback('❌ বাতিল', 'adm_repost')]
    ])
  );
});

bot.action(/^repost_confirm:(\d+)$/, async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = repostData[ctx.from.id];
  const index = Number(ctx.match[1]);
  if (!state || state.step !== 'post' || !state.posts || !state.posts[index]) {
    return ctx.answerCbQuery('❌ Repost data পাওয়া যায়নি');
  }
  const rec = state.posts[index];
  const lockKey = repostLockKey(ctx.from.id, rec);
  if (repostInFlight.has(lockKey)) {
    return ctx.answerCbQuery('⏳ এই Post-এর Repost ইতিমধ্যে চলছে। একটু অপেক্ষা করুন।');
  }
  repostInFlight.set(lockKey, Date.now());
  await ctx.answerCbQuery('Reposting...');

  // Immediately replace the confirmation keyboard so a fast second tap cannot
  // start another copy before the first Telegram API call finishes.
  try {
    await ctx.editMessageText(
      `⏳ Repost করা হচ্ছে...\n\n📢 Channel: ${rec.channelId}\n🆔 Source Message ID: ${rec.messageId}`
    );
  } catch (_) {}

  try {
    // NOTE: Telegram's copyMessage does NOT carry over the original inline
    // keyboard unless it is passed explicitly via reply_markup. That was the
    // cause of reposts losing their buttons. We rebuild the same configured
    // keyboard here using the post's saved topicId, like a fresh post gets.
    const copyOptions = {};
    if (rec.topicId && rec.topicId !== 'repost') {
      const kb = await buildConfiguredPostKeyboard(rec.topicId);
      if (kb.reply_markup && Array.isArray(kb.reply_markup.inline_keyboard) && kb.reply_markup.inline_keyboard.length) {
        copyOptions.reply_markup = kb.reply_markup;
      }
    }

    // Try the newest saved message first; if it was deleted from the channel,
    // fall back to older copies of the same post and forget the dead ones.
    const candidates = [Number(rec.messageId), ...(Array.isArray(rec.fallbackIds) ? rec.fallbackIds : [])];
    const goneRe = /message to copy not found|message not found|MESSAGE_ID_INVALID|message can't be copied/i;
    let copied = null;
    let lastError = null;
    for (const sourceMessageId of candidates) {
      try {
        copied = await bot.telegram.copyMessage(rec.channelId, rec.channelId, sourceMessageId, copyOptions);
        break;
      } catch (copyErr) {
        lastError = copyErr;
        if (goneRe.test(copyErr.message || '')) {
          hideFromRepostList(rec.channelId, sourceMessageId); // dead post — never list it again
          continue;
        }
        throw copyErr; // a real error (permissions, rate limit …) — don't hammer the other IDs
      }
    }
    if (!copied) throw (lastError || new Error('Post পাওয়া যায়নি'));

    // IMPORTANT: A reposted message must NOT be added back to the Repost source
    // list. The new copy's ID is remembered as "hidden" so that even if some
    // other path (an old record, a forward, a channel update) tries to add it,
    // it can never appear as a duplicate button.
    await hideFromRepostList(rec.channelId, copied.message_id);
    delete repostData[ctx.from.id];
    return ctx.reply(`✅ Post আবার Repost হয়েছে (বাটনসহ)।\n\n📢 ${rec.channelId}\n📝 ${String(rec.caption || rec.title || '(Caption নেই)').slice(0, 300)}\n🆔 নতুন Message ID: ${copied.message_id}`, { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });
  } catch (e) {
    console.error('❌ Repost error:', e.message);
    return ctx.reply(`❌ Repost করা যায়নি।\n\n📢 ${rec.channelId}\n🆔 Message ID: ${rec.messageId}\n\n${e.message}`);
  } finally {
    repostInFlight.delete(lockKey);
  }
});


// Channel manager actions
bot.action('ach_add', async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); postData[ctx.from.id]={step:'channel_name'}; return ctx.reply('📢 নতুন Channel-এর নাম লিখুন:'); });
bot.action(/^ach_view:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const id=ctx.match[1]; await ctx.answerCbQuery(); const channels=await getChannels(); const c=channels.find(x=>x.id===id || x.channelId===id); if(!c)return ctx.reply('❌ Channel পাওয়া যায়নি।'); return ctx.reply(`📢 ${c.name||'Posting Channel'}\n🆔 ${c.channelId}\n🔗 ${c.link||'(none)'}\n🟢 Active: ${c.active!==false}` ,Markup.inlineKeyboard([[Markup.button.callback('📤 Post Here','apostch:'+id),Markup.button.callback(c.active===false?'🟢 Enable':'🔴 Disable','ach_toggle:'+id)],[Markup.button.callback('✏️ Rename / Edit','ach_edit:'+id),Markup.button.callback('🗑️ Delete','ach_del:'+id)],[Markup.button.callback('⬅️ Back','adm_channels')]])); });
bot.action(/^ach_edit:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const id=ctx.match[1]; const channels=await getChannels(); const c=channels.find(x=>x.id===id || x.channelId===id); if(!c)return ctx.answerCbQuery('❌ নেই'); await ctx.answerCbQuery(); const docId=id.startsWith('env_') ? id : id; if(id.startsWith('env_')) { await db.collection('channels').doc(docId).set({name:c.name||'Posting Channel',channelId:c.channelId,link:c.link||'',active:c.active!==false,createdAt:Date.now(),updatedAt:Date.now(),legacyOverride:true},{merge:true}); invalidateChannelsCache(); } postData[ctx.from.id]={step:'channel_edit_name',channelDocId:docId,channel:c}; return ctx.reply(`✏️ Current Channel Name: ${c.name||''}\n\nনতুন Channel Name পাঠান:`); });

bot.action(/^ach_toggle:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const id=ctx.match[1]; const ref=db.collection('channels').doc(id); const d=await ref.get(); if(!d.exists)return ctx.answerCbQuery('❌ নেই'); await ref.update({active:d.data().active===false,updatedAt:Date.now()}); invalidateChannelsCache(); await ctx.answerCbQuery('Updated'); return ctx.reply('✅ Channel status updated.'); });
bot.action(/^ach_del:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const id = ctx.match[1];
  const channels = await getChannels();
  const c = channels.find(x => x.id === id || x.channelId === id);
  await ctx.answerCbQuery();
  const name = c ? (c.name || c.channelId) : id;
  return ctx.editMessageText(
    `⚠️ আপনি কি নিশ্চিত?\n\n📢 ${name}\n\nএই Channel delete করলে সাথে এর পুরোনো Repost history-ও মুছে যাবে। ফেরত আনা যাবে না।`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ হ্যাঁ, Delete করুন', 'ach_del_confirm:'+id), Markup.button.callback('❌ বাতিল', 'ach_view:'+id)]
    ])
  );
});
bot.action(/^ach_del_confirm:(.+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const id = ctx.match[1];
  const channels = await getChannels();
  const c = channels.find(x => x.id === id || x.channelId === id);
  const channelIdToClean = c ? String(c.channelId) : String(id);

  try { await db.collection('channels').doc(id).delete(); } catch (e) { console.error('❌ Channel delete error:', e.message); }
  invalidateChannelsCache();

  // Clean up orphaned repost records for this channel so old history doesn't linger.
  try {
    const snap = await db.collection('channelPosts').where('channelId', '==', channelIdToClean).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (e) {
    console.error('❌ channelPosts cleanup error:', e.message);
  }

  await ctx.answerCbQuery('Deleted');
  return sendAdminPanel(ctx);
});

// Admin posting: select channel then reuse the existing /post media/topic/caption flow
bot.action(/^apostch:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); delete addVideoData[ctx.from.id]; delete addTopicData[ctx.from.id]; delete broadcastData[ctx.from.id]; const key=ctx.match[1]; let channelId=key; const doc=await db.collection('channels').doc(key).get(); if(doc.exists)channelId=doc.data().channelId; postData[ctx.from.id]={step:'mediaType',channels:[channelId]}; await ctx.answerCbQuery(); return ctx.reply('📤 Channel selected।\n\nকী পোস্ট করবেন?',Markup.inlineKeyboard([[Markup.button.callback('🎬 Video','post_type_video'),Markup.button.callback('🖼️ Photo','post_type_photo')],[Markup.button.callback('❌ Cancel','post_cancel')]])); });

// Saved post buttons manager
bot.action('ab_add', async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); postData[ctx.from.id]={step:'button_name'}; return ctx.reply('🔘 Button-এর নাম লিখুন:'); });
bot.action(/^ab_edit:(\d+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const i=Number(ctx.match[1]); const bs=await getPostButtons(); if(!bs[i])return ctx.answerCbQuery('❌ নেই'); await ctx.answerCbQuery(); postData[ctx.from.id]={step:'button_edit_name',buttonIndex:i}; return ctx.reply(`✏️ বর্তমান নাম: ${bs[i].name}\n\nনতুন Button Name লিখুন (না বদলালে একই নাম আবার লিখুন):`); });
bot.action(/^ab_del:(\d+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const i=Number(ctx.match[1]); const bs=await getPostButtons(); if(!bs[i])return ctx.answerCbQuery('❌ নেই'); bs.splice(i,1); if(!bs.length)bs.push(...DEFAULT_POST_BUTTONS); await savePostButtons(bs); await ctx.answerCbQuery('Deleted'); return ctx.reply('✅ Button delete হয়েছে।'); });
async function renderButtonManager(ctx) {
  const bs = await getPostButtons();
  const rows = bs.map((b, i) => [
    Markup.button.callback(`${i + 1}. ${safeTruncate(b.name, 20)}`, 'ab_edit:' + i),
    Markup.button.callback(i === 0 ? '　' : '⬆️', 'ab_up:' + i),
    Markup.button.callback(i === bs.length - 1 ? '　' : '⬇️', 'ab_down:' + i),
    Markup.button.callback('🗑️', 'ab_del:' + i)
  ]);
  rows.push([Markup.button.callback('➕ Add Button', 'ab_add')]);
  rows.push([Markup.button.callback('⬅️ Back', 'adm_home')]);
  return ctx.editMessageText('🔘 POST BUTTON MANAGER\n\nএই saved buttons নতুন post-এ automatic থাকবে। ⬆️⬇️ দিয়ে ক্রম বদলাতে পারবেন।', Markup.inlineKeyboard(rows));
}
bot.action(/^ab_up:(\d+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const i = Number(ctx.match[1]);
  const bs = await getPostButtons();
  if (i <= 0 || i >= bs.length) return ctx.answerCbQuery('❌');
  [bs[i-1], bs[i]] = [bs[i], bs[i-1]];
  await savePostButtons(bs);
  await ctx.answerCbQuery('⬆️');
  return renderButtonManager(ctx);
});
bot.action(/^ab_down:(\d+)$/, async ctx=>{
  if(!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const i = Number(ctx.match[1]);
  const bs = await getPostButtons();
  if (i < 0 || i >= bs.length - 1) return ctx.answerCbQuery('❌');
  [bs[i], bs[i+1]] = [bs[i+1], bs[i]];
  await savePostButtons(bs);
  await ctx.answerCbQuery('⬇️');
  return renderButtonManager(ctx);
});


bot.command('views', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    await ctx.reply('⏳ ভিউ রিপোর্ট তৈরি করা হচ্ছে...');

    const topics = await getTopicsCached();
    const today = getDhakaDateKey();
    let totalViews = 0;
    let todayViews = 0;

    const todayRanking = topics.map(topic => {
      const total = Number(topic.unlockCount || topic.unlocks || topic.views) || 0;
      const todayCount = topic.dailyUnlockDate === today
        ? (Number(topic.dailyUnlockCount) || 0)
        : 0;
      totalViews += total;
      todayViews += todayCount;
      return { title: String(topic.title || 'নামবিহীন').replace(/\n/g, ' ').trim(), views: todayCount };
    })
    .filter(item => item.views > 0)
    .sort((a, b) => b.views - a.views || a.title.localeCompare(b.title));

    let message =
      `📊 VIEW REPORT\n\n` +
      `👁️ Total Views: ${totalViews.toLocaleString('en-US')}\n` +
      `📅 Today: ${todayViews.toLocaleString('en-US')}\n\n` +
      `🔥 Top 5 Today\n`;

    if (todayRanking.length === 0) {
      message += `আজ এখনো কোনো ভিডিও Unlock হয়নি।`;
    } else {
      todayRanking.slice(0, 5).forEach((item, index) => {
        const safeTitle = item.title.slice(0, 70) || 'নামবিহীন';
        message += `${index + 1}. ${safeTitle} — ${item.views.toLocaleString('en-US')}\n`;
      });
    }

    await ctx.reply(message);
  } catch (error) {
    console.error('❌ Error in /views:', error);
    await ctx.reply('❌ ভিউ রিপোর্ট তৈরি করতে সমস্যা হয়েছে: ' + error.message);
  }
});

bot.command('stats', async (ctx) => {
  try {
    console.log('📊 /stats command by:', ctx.from.id);
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    await ctx.reply('⏳ পরিসংখ্যান লোড হচ্ছে...');

    const counts = await getUserCountsCached();
    const topics = await getTopicsCached();
    topics.sort((a, b) => {
      const viewsA = Number(a.unlockCount || a.unlocks || a.views) || 0;
      const viewsB = Number(b.unlockCount || b.unlocks || b.views) || 0;
      const timeA = new Date(a.createdAt || 0).getTime() || 0;
      const timeB = new Date(b.createdAt || 0).getTime() || 0;
      return viewsB - viewsA || timeB - timeA;
    });

    const totalViews = topics.reduce((sum, topic) => {
      return sum + (Number(topic.unlockCount || topic.unlocks || topic.views) || 0);
    }, 0);
    const todayKey = getDhakaDateKey();
    const todayViews = topics.reduce((sum, topic) => {
      return sum + (topic.dailyUnlockDate === todayKey ? (Number(topic.dailyUnlockCount) || 0) : 0);
    }, 0);

    let message =
      `📊 স্ট্যাটিসটিক্স\n\n` +
      `👥 মোট ইউজার: ${counts.totalUsers} জন\n` +
      `✅ যাচাইকৃত ইউজার: ${counts.verifiedUsers} জন\n` +
      `📁 মোট ভিডিও/টপিক: ${topics.length}টি\n` +
      `👁️ মোট ভিউ: ${totalViews}\n` +
      `📅 আজকের ভিউ: ${todayViews}\n\n` +
      `🏆 ভিডিও অনুযায়ী ভিউ:\n\n`;

    if (topics.length === 0) {
      message += '📭 এখনো কোনো ভিডিও/টপিক নেই।';
    } else {
      topics.slice(0, 30).forEach((topic, index) => {
        const views = Number(topic.unlockCount || topic.unlocks || topic.views) || 0;
        const title = String(topic.title || 'নামবিহীন').replace(/\n/g, ' ').slice(0, 70);
        message += `${index + 1}. ${title}\n`;
        message += `   👁️ ${views} ভিউ\n`;
        message += `   🆔 <code>${topic.id}</code>\n\n`;
      });
      if (topics.length > 30) {
        message += `আরও ${topics.length - 30}টি ভিডিও আছে।`;
      }
    }
    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('❌ Error in /stats:', error);
    await ctx.reply('❌ পরিসংখ্যান দেখাতে সমস্যা হয়েছে: ' + error.message);
  }
});

bot.command('block', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  const targetId = args[1];
  if (!targetId) return ctx.reply('ব্যবহার: /block <userId>');
  await db.collection('users').doc(targetId).set({ blocked: true }, { merge: true });
  return ctx.reply(`🚫 Blocked: ${targetId}`);
});

bot.command('unblock', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  const targetId = args[1];
  if (!targetId) return ctx.reply('ব্যবহার: /unblock <userId>');
  await db.collection('users').doc(targetId).set({ blocked: false }, { merge: true });
  return ctx.reply(`✅ Unblocked: ${targetId}`);
});

bot.command('user', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    adminUserCursor = null;
    adminUserPage = 1;
    const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(25).get();
    if (snap.empty) return ctx.reply('📭 এখনো কোনো ইউজার পাওয়া যায়নি।');
    adminUserCursor = snap.docs[snap.docs.length - 1];
    await sendUserPage(ctx, snap.docs, adminUserPage);
  } catch (error) {
    console.error('❌ Error in /user:', error);
    await ctx.reply('❌ ইউজার তালিকা দেখাতে সমস্যা হয়েছে: ' + error.message);
  }
});

async function searchUsers(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  // Numeric-looking query: try an exact User ID lookup first (fast, single doc read).
  if (/^\d+$/.test(q)) {
    const doc = await db.collection('users').doc(q).get();
    if (doc.exists) return [doc.data()];
  }

  // Otherwise scan and match name/username case-insensitively (bounded to avoid huge reads).
  const needle = q.toLowerCase().replace(/^@/, '');
  const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(1000).get();
  const results = [];
  for (const doc of snap.docs) {
    const u = doc.data();
    const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ').toLowerCase();
    const username = String(u.username || '').toLowerCase();
    const userId = String(u.userId || doc.id);
    if (fullName.includes(needle) || username.includes(needle) || userId.includes(q)) {
      results.push(u);
      if (results.length >= 20) break;
    }
  }
  return results;
}

// 🔍 Topic Search — search cached topics by title (case-insensitive
// substring) or exact/partial Topic ID, so the admin doesn't have to
// scroll through every topic to find one.
async function searchTopics(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const topics = await getTopicsCached();
  const needle = q.toLowerCase();
  const results = topics.filter(t => {
    const title = String(t.title || '').toLowerCase();
    const id = String(t.id || '').toLowerCase();
    return title.includes(needle) || id.includes(needle);
  });
  return results.slice(0, 20);
}

async function sendUserPage(ctx, docs, page) {
  let message = `👥 ইউজার তালিকা (${page})\n\n`;
  docs.forEach((doc, index) => {
    const user = doc.data();
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    const displayName = escapeHtml(fullName || 'নাম পাওয়া যায়নি');
    const username = user.username ? `@${escapeHtml(String(user.username).replace(/^@/, ''))}` : 'Username নেই';
    const status = user.verified === true ? '✅' : '❌';
    const blockedTag = user.blocked === true ? ' 🚫' : '';
    const userId = escapeHtml(user.userId || doc.id);
    message += `${(page - 1) * 25 + index + 1}. ${displayName}${blockedTag}\n`;
    message += `   👤 ${username}\n   🆔 <code>${userId}</code> ${status}\n\n`;
  });
  const buttons = adminUserCursor ? Markup.inlineKeyboard([[Markup.button.callback('➡️ পরের ২৫ জন', 'admin_users_next')]]) : undefined;
  await ctx.reply(message, { parse_mode: 'HTML', ...(buttons ? { reply_markup: buttons.reply_markup } : {}) });
}

bot.action(/^blk:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const id = ctx.match[1];
  if (bulkSelect.ids.has(id)) bulkSelect.ids.delete(id); else bulkSelect.ids.add(id);
  try { await ctx.answerCbQuery(); } catch (e) {}
  return renderBulkTopicsPanel(ctx);
});

bot.action(/^blkpage:(prev|next)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  bulkSelect.page += ctx.match[1] === 'next' ? 1 : -1;
  try { await ctx.answerCbQuery(); } catch (e) {}
  return renderBulkTopicsPanel(ctx);
});

// Shows the pending Scheduled Posts list, each with its own Cancel button
// labelled with the topic's TITLE (not just a bare, meaningless #N) — see
// post_schedule save above for where the title gets stored. Tapping Cancel
// asks for confirmation (schedcancel_ask below) instead of cancelling
// immediately, so an admin can't lose a schedule to a stray tap.
async function renderScheduledPostsList(ctx) {
  try {
    const snap = await db.collection('scheduledPosts')
      .where('status', '==', 'pending')
      .orderBy('scheduledAt', 'asc')
      .limit(20)
      .get();
    if (snap.empty) {
      return ctx.editMessageText('📭 কোনো Scheduled Post নেই।', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_home')]]));
    }
    // Older schedules saved before `title` was stored on the doc won't have
    // it — look those specific few up from the topics collection so the
    // list (and its buttons) are still readable instead of showing a bare,
    // meaningless Topic ID.
    const missingTitleIds = [...new Set(
      snap.docs.map(d => d.data()).filter(sp => !sp.title && sp.topicId).map(sp => sp.topicId)
    )];
    const fallbackTitles = {};
    if (missingTitleIds.length) {
      await Promise.all(missingTitleIds.map(async id => {
        try {
          const t = await db.collection('topics').doc(id).get();
          fallbackTitles[id] = t.exists ? (t.data().title || 'নামবিহীন ভিডিও') : '❓ Topic পাওয়া যায়নি';
        } catch (e) { fallbackTitles[id] = '❓ Topic পাওয়া যায়নি'; }
      }));
    }

    const rows = [];
    let text = '🕒 SCHEDULED POSTS\n\n';
    snap.docs.forEach((d, i) => {
      const sp = d.data();
      const repeatTag = sp.recurrence === 'daily' ? ' 🔁Daily' : sp.recurrence === 'weekly' ? ' 🔁Weekly' : '';
      const title = sp.title || fallbackTitles[sp.topicId] || 'নামবিহীন ভিডিও';
      text += `${i + 1}. 📌 ${escapeHtml(title)} (🆔 <code>${escapeHtml(sp.topicId)}</code>) | 📅 ${formatDhakaDateTime(sp.scheduledAt)}${repeatTag} | 📢 ${(sp.channels || []).length}টি Channel\n`;
      const shortTitle = safeTruncate(title, 26) + (Array.from(title).length > 26 ? '…' : '');
      rows.push([Markup.button.callback(`❌ Cancel: ${shortTitle}`, `schedcancel_ask:${d.id}`)]);
    });
    rows.push([Markup.button.callback('⬅️ Back', 'adm_home')]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  } catch (error) {
    console.error('❌ Scheduled list error:', error.message);
    return ctx.reply('❌ তালিকা আনতে সমস্যা হয়েছে: ' + error.message + '\n\n(Firestore-এ একটা composite index লাগতে পারে — Render/console log-এ যে link আসবে সেটায় ক্লিক করলেই index তৈরি হয়ে যাবে।)');
  }
}

// Step 1: show what's about to be cancelled and ask for a real Yes/No
// confirmation, instead of cancelling on the very first tap.
bot.action(/^schedcancel_ask:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const id = ctx.match[1];
  try { await ctx.answerCbQuery(); } catch (e) {}
  try {
    const doc = await db.collection('scheduledPosts').doc(id).get();
    if (!doc.exists || doc.data().status !== 'pending') {
      try { await ctx.answerCbQuery('❌ এই Schedule আর active নেই।'); } catch (e) {}
      return renderScheduledPostsList(ctx);
    }
    const sp = doc.data();
    const repeatTag = sp.recurrence === 'daily' ? '\n🔁 প্রতিদিন repeat হচ্ছিল' : sp.recurrence === 'weekly' ? '\n🔁 প্রতি সপ্তাহে repeat হচ্ছিল' : '';
    return ctx.editMessageText(
      `⚠️ আপনি কি নিশ্চিত এই Scheduled Post বাতিল করতে চান?\n\n` +
      `📌 Title: ${escapeHtml(sp.title || 'নামবিহীন ভিডিও')}\n` +
      `🆔 Topic ID: <code>${escapeHtml(sp.topicId)}</code>\n` +
      `📅 সময়: ${formatDhakaDateTime(sp.scheduledAt)}${repeatTag}\n` +
      `📢 Channel: ${(sp.channels || []).length}টি`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ হ্যাঁ, বাতিল করুন', `schedcancel_yes:${id}`)],
        [Markup.button.callback('⬅️ না, ফিরে যান', 'adm_scheduled')]
      ]) }
    );
  } catch (error) {
    console.error('❌ schedcancel_ask error:', error.message);
    return ctx.reply('❌ সমস্যা হয়েছে: ' + error.message);
  }
});

// Step 2: only actually cancels after the admin has confirmed above.
bot.action(/^schedcancel_yes:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const id = ctx.match[1];
  try {
    await db.collection('scheduledPosts').doc(id).set({ status: 'cancelled' }, { merge: true });
    const timer = scheduledTimers.get(id);
    if (timer) { clearTimeout(timer); scheduledTimers.delete(id); }
    try { await ctx.answerCbQuery('✅ বাতিল হয়েছে'); } catch (e) {}
  } catch (error) {
    console.error('❌ schedcancel_yes error:', error.message);
    try { await ctx.answerCbQuery('❌ সমস্যা হয়েছে'); } catch (e) {}
    return;
  }
  return renderScheduledPostsList(ctx);
});

// Kept for backward compatibility with any Scheduled Posts list message
// that was already sent/opened before this confirmation step was added
// (its buttons still carry the old callback data) — it still cancels
// directly with no confirmation. Every list rendered from now on uses
// schedcancel_ask/schedcancel_yes above instead.
bot.action(/^schedcancel:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const id = ctx.match[1];
  try {
    await db.collection('scheduledPosts').doc(id).set({ status: 'cancelled' }, { merge: true });
    const timer = scheduledTimers.get(id);
    if (timer) { clearTimeout(timer); scheduledTimers.delete(id); }
    try { await ctx.answerCbQuery('✅ বাতিল হয়েছে'); } catch (e) {}
  } catch (error) {
    console.error('❌ schedcancel error:', error.message);
    try { await ctx.answerCbQuery('❌ সমস্যা হয়েছে'); } catch (e) {}
    return;
  }
  return sendAdminPanel(ctx, false);
});

bot.action(/^ublk:(.+)$/, async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const targetId = ctx.match[1];
  try {
    const userRef = db.collection('users').doc(String(targetId));
    const doc = await userRef.get();
    if (!doc.exists) { await ctx.answerCbQuery('❌ User পাওয়া যায়নি'); return; }
    const currentlyBlocked = doc.data().blocked === true;
    await userRef.set({ blocked: !currentlyBlocked }, { merge: true });
    await ctx.answerCbQuery(currentlyBlocked ? '✅ Unblocked' : '🚫 Blocked');
    return ctx.reply(`${currentlyBlocked ? '✅ Unblocked' : '🚫 Blocked'}: <code>${escapeHtml(targetId)}</code>`, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('❌ Block toggle error:', error.message);
    try { await ctx.answerCbQuery('❌ সমস্যা হয়েছে'); } catch (e) {}
  }
});

bot.action('admin_users_next', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID || !adminUserCursor) return ctx.answerCbQuery('❌ অনুমতি নেই');
  await ctx.answerCbQuery();
  const snap = await db.collection('users').orderBy('createdAt', 'desc').startAfter(adminUserCursor).limit(25).get();
  if (snap.empty) { adminUserCursor = null; return ctx.reply('📭 আর কোনো ইউজার নেই।'); }
  adminUserCursor = snap.docs[snap.docs.length - 1];
  adminUserPage += 1;
  await sendUserPage(ctx, snap.docs, adminUserPage);
});

bot.command('delete', async (ctx) => {
  try {
    console.log('🗑️ /delete command by:', ctx.from.id);
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('⚠️ টপিক আইডি দিন:\n/delete <টপিক_আইডি>');
    }
    await ctx.reply(`⏳ টপিক ${args[1]} ডিলিট করা হচ্ছে...`);
    await db.collection('topics').doc(args[1]).delete();
    invalidateTopicsCache();
    await ctx.reply(`✅ টপিক ${args[1]} ডিলিট করা হয়েছে।`);
  } catch (error) {
    console.error('❌ Error in /delete:', error);
    await ctx.reply('❌ ডিলিট করতে সমস্যা: ' + error.message);
  }
});

bot.command('broadcast', async (ctx) => {
  try {
    console.log('📢 /broadcast command by:', ctx.from.id);
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    broadcastData[ctx.from.id] = { step: 'content' };
    await ctx.reply(
      '📢 কী পাঠাতে চান, নিচের যেকোনো একটি করুন:\n\n' +
      '🖼️ ছবি পাঠান\n' +
      '🎬 ভিডিও পাঠান\n' +
      '🎞️ GIF পাঠান\n' +
      '📊 পোল বানাতে "poll" লিখুন\n' +
      '✏️ শুধু টেক্সট পাঠাতে "skip" লিখুন'
    );
  } catch (error) {
    console.error('❌ Error in /broadcast:', error);
    await ctx.reply('❌ ব্রডকাস্ট শুরু করতে সমস্যা: ' + error.message);
  }
});

async function showBroadcastPreview(ctx, data) {
  const typeLabel = { photo: '🖼️ Photo', video: '🎬 Video', animation: '🎞️ GIF', poll: '📊 Poll', text: '✏️ Text' }[data.type] || data.type;
  let preview = `⚠️ ব্রডকাস্ট Preview — সব verified ইউজারকে যাবে!\n\n📦 Type: ${typeLabel}\n`;
  if (data.type === 'poll') {
    preview += `❓ প্রশ্ন: ${data.question}\n🔘 অপশন: ${data.options.join(' | ')}`;
  } else {
    preview += `📝 Message:\n${String(data.message || '(কোনো মেসেজ নেই)').slice(0, 500)}`;
  }
  preview += `\n\nএটা সব ইউজারকে পাঠাতে "✅ Confirm" চাপুন, নাহলে "❌ Cancel" চাপুন।`;
  return ctx.reply(preview, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm & Send', 'bcast_confirm'), Markup.button.callback('❌ Cancel', 'bcast_cancel')]
  ]));
}

bot.action('bcast_confirm', async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  const userId = ctx.from.id;
  const data = broadcastData[userId];
  if (!data || data.step !== 'confirm') return ctx.answerCbQuery('❌ Broadcast data পাওয়া যায়নি');
  await ctx.answerCbQuery('Sending...');
  await runBroadcast(ctx, data);
  delete broadcastData[userId];
});

bot.action('bcast_cancel', async (ctx) => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌');
  delete broadcastData[ctx.from.id];
  await ctx.answerCbQuery('বাতিল হয়েছে');
  return ctx.editMessageText('❌ Broadcast বাতিল করা হয়েছে।');
});

async function runBroadcast(ctx, data) {
  try {
    await ctx.reply('⏳ ব্রডকাস্ট শুরু হচ্ছে...');
    const snapshot = await db.collection('users').where('verified', '==', true).get();
    const users = snapshot.docs.map(doc => doc.data());

    if (users.length === 0) {
      return ctx.reply('📭 কোনো যাচাইকৃত ইউজার নেই।');
    }

    let success = 0, failed = 0, blocked = 0;
    for (const user of users) {
      try {
        if (data.type === 'photo') {
          const res = await safeSendPhoto(user.userId, data.file, { caption: data.message || '' });
          if (res) success++; else blocked++;
        } else if (data.type === 'video') {
          const res = await safeSendVideo(user.userId, data.file, { caption: data.message || '' });
          if (res) success++; else blocked++;
        } else if (data.type === 'animation') {
          const res = await safeSendAnimation(user.userId, data.file, { caption: data.message || '' });
          if (res) success++; else blocked++;
        } else if (data.type === 'poll') {
          const res = await safeSendPoll(user.userId, data.question, data.options, {
            is_anonymous: true,
            allows_multiple_answers: false
          });
          if (res) success++; else blocked++;
        } else {
          const res = await safeSendMessage(user.userId, data.message);
          if (res) success++; else blocked++;
        }
      } catch (error) {
        failed++;
        console.error(`❌ Failed to send to ${user.userId}:`, error.message);
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }

    await ctx.reply(`✅ ব্রডকাস্ট শেষ!\n✅ সফল: ${success}\n🚫 Blocked/সরানো: ${blocked}\n❌ ব্যর্থ: ${failed}`);
  } catch (error) {
    console.error('❌ Error in broadcast run:', error);
    await ctx.reply('❌ ব্রডকাস্ট করতে সমস্যা: ' + error.message);
  }
}

// =============================================
// 🩺 DIAGNOSTIC
// =============================================

bot.command('checkdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ শুধুমাত্র অ্যাডমিনের জন্য।');
  try {
    const [topics, users] = await Promise.all([getTopicsCached(), getUserCountsCached()]);
    await ctx.reply(`📊 ডেটাবেস রিপোর্ট:\n\n📁 টপিক: ${topics.length}টি\n👥 ইউজার: ${users.totalUsers}টি`);
  } catch (error) { await ctx.reply('❌ ডেটাবেস চেক করতে সমস্যা: ' + error.message); }
});

bot.command('testdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ শুধুমাত্র অ্যাডমিনের জন্য।');
  try {
    const [topics, users] = await Promise.all([getTopicsCached(), getUserCountsCached()]);
    let reply = `📊 ডেটাবেস রিপোর্ট:\n\n👥 ইউজার: ${users.totalUsers}টি\n📁 টপিক: ${topics.length}টি\n\n`;
    reply += topics.length ? `📌 প্রথম 20টি টপিক:\n${topics.slice(0,20).map((t,i)=>`${i+1}. ${t.title || 'নামবিহীন'} (${t.id})`).join('\n')}` : '📭 কোনো টপিক নেই।';
    await ctx.reply(reply);
  } catch (error) { console.error('❌ testdb error:', error); await ctx.reply('❌ ডেটাবেস চেক করতে সমস্যা: ' + error.message); }
});

bot.command('ping', async (ctx) => {
  // Health check command — যেকোনো user দিতে পারে
  await ctx.reply(`🏓 Pong!\n\n⏱️ Uptime: ${Math.floor(process.uptime())}s\n📍 Server time: ${new Date().toISOString()}`);
});

// =============================================
// ✉️ TEXT HANDLER
// =============================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (await handleForwardedRepostCapture(ctx)) return;

  if (forwardRepostData[userId] && forwardRepostData[userId].step === 'topicId') {
    const pending = forwardRepostData[userId];
    delete forwardRepostData[userId];
    let topicId = '';
    let title = '';
    if (text.toLowerCase() !== 'skip') {
      const d = await db.collection('topics').doc(text).get();
      if (!d.exists) {
        await ctx.reply(`⚠️ "${escapeHtml(text)}" নামে কোনো Video/Topic পাওয়া যায়নি, তাই বাটন ছাড়াই যোগ করা হচ্ছে।`, { parse_mode: 'HTML' });
      } else {
        topicId = text;
        title = d.data().title || '';
      }
    }
    await recordTopicPost(topicId || 'repost', pending.channelId, pending.messageId, pending.type, pending.caption, title);
    return ctx.reply(
      `✅ Repost list-এ যোগ হয়েছে।\n\n📢 ${escapeHtml(String(pending.channelId))}\n🆔 Message ID: <code>${escapeHtml(String(pending.messageId))}</code>${topicId ? `\n🔗 Video/Topic: <code>${escapeHtml(topicId)}</code>` : ''}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📢 Repost Menu', 'adm_repost')]]) }
    );
  }

  // Add Video/Topic text steps have priority over every other admin state.
  if (addTopicData[userId]) {
    const data = addTopicData[userId];
    if (data.step === 'title') {
      data.title = text;
      data.step = 'thumbnail';
      return ctx.reply('🖼️ এই টপিকের জন্য একটি থাম্বনেইল ইমেজ পাঠান:');
    }
    if (data.step === 'ads') {
      const ads = Number.parseInt(text, 10);
      if (!Number.isInteger(ads) || ads < 1) return ctx.reply('❌ দয়া করে ১ বা তার বেশি একটি সংখ্যা দিন:');
      data.adsRequired = ads;
      await saveTopic(ctx, data);
      delete addTopicData[userId];
      return;
    }
  }
  if (addVideoData[userId]) {
    const data = addVideoData[userId];
    if (data.step === 'title') {
      data.title = text;
      data.step = 'thumbnail';
      return ctx.reply('🖼️ এই ভিডিওর জন্য একটি থাম্বনেইল ইমেজ পাঠান:');
    }
    if (data.step === 'ads') {
      const ads = Number.parseInt(text, 10);
      if (!Number.isInteger(ads) || ads < 1) return ctx.reply('❌ দয়া করে ১ বা তার বেশি একটি সংখ্যা দিন:');
      data.adsRequired = ads;
      await saveVideo(ctx, data);
      delete addVideoData[userId];
      return;
    }
  }

  if (postData[userId]) {
    const state = postData[userId];

    if (state.step === 'channel_name') { state.name=safeTruncate(text,80); state.step='channel_id'; return ctx.reply('🆔 Channel ID দিন (উদাহরণ: -1001234567890):'); }
    if (state.step === 'channel_id') { state.channelId=text; state.step='channel_link'; return ctx.reply('🔗 Channel link/username দিন (না থাকলে skip লিখুন):'); }
    if (state.step === 'channel_link') {
      state.link = text.toLowerCase() === 'skip' ? '' : text;
      await ctx.reply('⏳ Channel-এ Bot Admin কিনা চেক করা হচ্ছে...');
      try {
        const me = await bot.telegram.getMe();
        const member = await bot.telegram.getChatMember(state.channelId, me.id);
        if (!member || (member.status !== 'administrator' && member.status !== 'creator')) {
          return ctx.reply(
            `❌ Bot এই Channel-এ Admin নয়।\n\nআগে Bot-কে "${state.channelId}" Channel-এ Admin (Post Messages permission সহ) বানান, তারপর আবার /channel_add দিয়ে চেষ্টা করুন।`
          );
        }
      } catch (e) {
        return ctx.reply(
          `❌ Channel access verify করা যায়নি: ${e.message}\n\nChannel ID ঠিক আছে কিনা এবং Bot ওই Channel-এ Admin হিসেবে যোগ করা আছে কিনা চেক করুন।`
        );
      }
      const c = await addChannelRecord(state);
      delete postData[userId];
      return ctx.reply(`✅ Channel Added (Bot Admin verified)\n\n📢 ${c.name}\n🆔 ${c.channelId}`, Markup.inlineKeyboard([[Markup.button.callback('📤 Post Here', 'apostch:' + c.id)], [Markup.button.callback('📢 Channel Manager', 'adm_channels')]]));
    }
    if (state.step === 'channel_edit_name') { state.name=safeTruncate(text,80); state.step='channel_edit_id'; return ctx.reply(`🆔 Current ID: ${state.channel.channelId||''}\n\nনতুন Channel ID দিন (না বদলালে আগেরটাই লিখুন):`); }
    if (state.step === 'channel_edit_id') { state.channelId=text; state.step='channel_edit_link'; return ctx.reply(`🔗 Current Link: ${state.channel.link||'(none)'}\n\nনতুন link দিন, না থাকলে skip:`); }
    if (state.step === 'channel_edit_link') { state.link=text.toLowerCase()==='skip'?'':text; await db.collection('channels').doc(state.channelDocId).update({name:state.name,channelId:state.channelId,link:state.link,updatedAt:Date.now()}); invalidateChannelsCache(); delete postData[userId]; return ctx.reply('✅ Channel updated.',Markup.inlineKeyboard([[Markup.button.callback('📢 Channel Manager','adm_channels')]])); }
    if (state.step === 'button_name') { state.name=safeTruncate(text,60); state.step='button_url'; return ctx.reply('🔗 Button Link দিন।\n\nVideo button হলে: {VIDEO_LINK}\nHelp Admin হলে: {HELP_LINK}\nঅন্য link হলে সরাসরি https://... দিন।'); }
    if (state.step === 'button_url') { if(text!=='{VIDEO_LINK}'&&text!=='{HELP_LINK}'&&!/^https?:\/\//i.test(text)) return ctx.reply('❌ সঠিক https:// link বা {VIDEO_LINK}/{HELP_LINK} দিন।'); const bs=await getPostButtons(); bs.push({name:state.name,url:text}); await savePostButtons(bs); delete postData[userId]; return ctx.reply('✅ Button saved. নতুন post-এ automatic থাকবে।'); }
    if (state.step === 'button_edit_name') { state.name=safeTruncate(text,60); state.step='button_edit_url'; return ctx.reply('🔗 নতুন Button Link দিন।\n{VIDEO_LINK}, {HELP_LINK} অথবা https://...'); }
    if (state.step === 'button_edit_url') { if(text!=='{VIDEO_LINK}'&&text!=='{HELP_LINK}'&&!/^https?:\/\//i.test(text)) return ctx.reply('❌ সঠিক link দিন।'); const bs=await getPostButtons(); if(!bs[state.buttonIndex]) return ctx.reply('❌ Button পাওয়া যায়নি।'); bs[state.buttonIndex]={name:state.name,url:text}; await savePostButtons(bs); delete postData[userId]; return ctx.reply('✅ Button updated.'); }

    if (state.step === 'setlink') {
      if (!/^https?:\/\//i.test(text)) {
        return ctx.reply('❌ সঠিক http/https Direct Link দিন।');
      }
      try {
        await db.collection('system').doc('settings').set({
          helpAdminLink: text,
          updatedAt: Date.now()
        }, { merge: true });
        helpAdminLinkCache = text;
        helpAdminLinkCacheAt = Date.now();
        delete postData[userId];
        return ctx.reply('✅ Help Admin link সফলভাবে আপডেট হয়েছে।');
      } catch (error) {
        console.error('❌ /setlink save error:', error);
        return ctx.reply('❌ Link save করতে সমস্যা হয়েছে।');
      }
    }

    if (state.step === 'topicId') {
      const topicId = text;
      if (!topicId || topicId.startsWith('/')) {
        return ctx.reply('❌ সঠিক Video/Topic ID পাঠান।');
      }

      try {
        const topicDoc = await db.collection('topics').doc(topicId).get();
        if (!topicDoc.exists) {
          return ctx.reply(`❌ এই Video/Topic ID পাওয়া যায়নি:\n${topicId}\n\nআবার সঠিক ID দিন।`);
        }

        const topic = topicDoc.data() || {};
        state.topicId = topicId;
        state.title = topic.title || 'নামবিহীন ভিডিও';
        state.step = 'caption';

        return ctx.reply(
          `✅ Video/Topic পাওয়া গেছে।\n\n` +
          `📌 Title: ${escapeHtml(state.title)}\n` +
          `🆔 ID: <code>${escapeHtml(topicId)}</code>\n\n` +
          `✍️ এখন Channel Post-এর Caption লিখুন।\n` +
          `Caption না চাইলে "skip" লিখুন।`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('❌ /post topic lookup error:', error);
        return ctx.reply('❌ Video/Topic খুঁজতে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
      }
    }

    if (state.step === 'caption') {
      state.caption = text.toLowerCase() === 'skip' ? '' : text;
      state.step = 'confirm';

      return ctx.reply(
        `👀 Post Preview\n\n` +
        `🎬 Type: ${state.type === 'video' ? 'Video' : 'Photo'}\n` +
        `📌 Title: ${escapeHtml(state.title || 'নামবিহীন ভিডিও')}\n` +
        `🆔 Video/Topic ID: <code>${escapeHtml(state.topicId)}</code>\n` +
        `📝 Caption: ${escapeHtml(state.caption || '(কোনো caption নেই)')}\n\n` +
        `Buttons:\n▶️ ভিডিও দেখুন\nHelp Admin\n\n` +
        `সব ঠিক থাকলে Post চাপুন, অথবা পরে নির্দিষ্ট সময়ে Post করতে Schedule বাটন চাপুন।`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Post Now', 'post_confirm')],
          [Markup.button.callback('🕒 Schedule করুন', 'post_schedule')],
          [Markup.button.callback('❌ Cancel', 'post_cancel')]
        ]) }
      );
    }

    if (state.step === 'schedule_time') {
      const parsed = parseDhakaDateTime(text);
      if (!parsed) {
        return ctx.reply('❌ সময়ের ফরম্যাট বোঝা যায়নি।\n\nএভাবে লিখুন:\n<code>9:30 PM</code> (আজ/আগামীকাল automatic)\nঅথবা\n<code>2026-09-20 9:30 PM</code>', { parse_mode: 'HTML' });
      }
      if (parsed <= Date.now() + 60 * 1000) {
        return ctx.reply('❌ সময়টা এখন থেকে অন্তত ১ মিনিট পরে হতে হবে। আবার লিখুন:');
      }
      state.scheduleTime = parsed;
      state.step = 'schedule_repeat';
      return ctx.reply(
        `📅 সময়: ${formatDhakaDateTime(parsed)}\n\n🔁 এটা কি বারবার (repeat) post হবে, নাকি একবারই?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('একবারই (No Repeat)', 'sched_repeat:none')],
          [Markup.button.callback('🔁 প্রতিদিন (Daily)', 'sched_repeat:daily')],
          [Markup.button.callback('🔁 প্রতি সপ্তাহে (Weekly)', 'sched_repeat:weekly')]
        ])
      );
    }
  }

  if (adminVideoData[userId]) {
    const state = adminVideoData[userId];
    const topicId = text.trim();
    if (state.step === 'post_id') {
      const td = await db.collection('topics').doc(topicId).get();
      if (!td.exists) return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি। আবার ID পাঠান।');
      delete adminVideoData[userId];
      channelPickData[userId] = { mode: 'topic_post', topicId, selected: new Set() };
      return renderChannelPicker(ctx);
    }
    if (state.step === 'delete_id') {
      const td = await db.collection('topics').doc(topicId).get();
      if (!td.exists) return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি। আবার ID পাঠান।');
      await db.collection('topics').doc(topicId).delete();
      delete adminVideoData[userId];
      invalidateTopicsCache();
      return ctx.reply(`✅ Video/Topic delete হয়েছে।\n🆔 <code>${escapeHtml(topicId)}</code>`, { parse_mode: 'HTML' });
    }
  }

  if (renameData[userId]) {
    const state = renameData[userId];
    if (state.step === 'id') {
      const doc = await db.collection('topics').doc(text).get();
      if (!doc.exists) return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি। আবার ID পাঠান।');
      state.topicId = text; state.step = 'title';
      return ctx.reply(`📌 বর্তমান Title: ${doc.data().title || 'নামবিহীন'}\n\n✏️ নতুন Title পাঠান:`);
    }
    if (state.step === 'title') {
      if (!text || text.length > 200) return ctx.reply('❌ Title 1-200 অক্ষরের মধ্যে দিন।');
      await db.collection('topics').doc(state.topicId).update({ title: text, updatedAt: new Date().toISOString() });
      delete renameData[userId]; invalidateTopicsCache();
      return ctx.reply(`✅ Title পরিবর্তন হয়েছে।\n🆔 <code>${escapeHtml(state.topicId)}</code>\n📌 ${escapeHtml(text)}`, { parse_mode: 'HTML' });
    }
  }

  if (thumbnailData[userId]) {
    const state = thumbnailData[userId];
    if (state.step === 'id') {
      const doc = await db.collection('topics').doc(text).get();
      if (!doc.exists) return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি। আবার ID পাঠান।');
      state.topicId = text; state.step = 'photo';
      return ctx.reply('🖼️ এখন নতুন thumbnail হিসেবে একটি Photo পাঠান।');
    }
  }

  if (updateAdsData[userId] && updateAdsData[userId].step === 'dailyLimit') {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > 1000) return ctx.reply('❌ Limit 1-1000 এর মধ্যে হতে হবে।');
    await db.collection('system').doc('settings').set({ dailyAdLimit: value }, { merge: true });
    dailyLimitCache = value; dailyLimitCacheAt = Date.now();
    delete updateAdsData[userId];
    return ctx.reply(`✅ Daily Ad Limit এখন ${value}টি।`);
  }

  if (updateAdsData[userId] && updateAdsData[userId].step === 'adCpm') {
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 100000) return ctx.reply('❌ সঠিক CPM সংখ্যা লিখুন (০ বা তার বেশি)।');
    await db.collection('system').doc('settings').set({ adCpm: value }, { merge: true });
    adCpmCache = value; adCpmCacheAt = Date.now();
    delete updateAdsData[userId];
    return ctx.reply(`✅ CPM এখন ${value} ৳ (প্রতি ১০০০ ad view)।`);
  }

  if (updateAdsData[userId] && updateAdsData[userId].step === 'bulkAdsCount') {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > 999) return ctx.reply('❌ Ads count 1-999 এর মধ্যে একটা সংখ্যা হতে হবে।');
    const ids = updateAdsData[userId].ids || [];
    delete updateAdsData[userId];
    try {
      const batch = db.batch();
      ids.forEach(id => batch.update(db.collection('topics').doc(id), { adsRequired: value }));
      await batch.commit();
      invalidateTopicsCache();
      return ctx.reply(`✅ ${ids.length}টি টপিকের Ads Required এখন ${value}টি।`, { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });
    } catch (error) {
      console.error('❌ Bulk ads update error:', error.message);
      return ctx.reply('❌ আপডেট করতে সমস্যা হয়েছে: ' + error.message);
    }
  }

  if (updateAdsData[userId]) {
    const state = updateAdsData[userId];

    if (state.step === 'topicId') {
      const topicId = text;
      if (!topicId || topicId.startsWith('/')) {
        return ctx.reply('❌ সঠিক Video/Topic ID পাঠান।');
      }
      try {
        const topicRef = db.collection('topics').doc(topicId);
        const topicDoc = await topicRef.get();
        if (!topicDoc.exists) {
          return ctx.reply(`❌ এই Video/Topic ID পাওয়া যায়নি:\n${topicId}\n\nআবার সঠিক ID পাঠান।`);
        }
        const currentAds = Math.max(1, Number(topicDoc.data().adsRequired) || 1);
        state.topicId = topicId;
        state.currentAds = currentAds;
        state.step = 'count';
        return ctx.reply(
          `📌 এই ভিডিও/টপিকের বর্তমান Ads count: ${currentAds}টি\n\n` +
          '👉 এখন বলুন, কয়টি Ads রাখতে চান?\n' +
          'শুধু সংখ্যা পাঠান।\n\n' +
          'উদাহরণ: 6'
        );
      } catch (error) {
        console.error('❌ Error finding topic for /ads:', error);
        return ctx.reply('❌ Video/Topic খুঁজতে সমস্যা হয়েছে। আবার ID পাঠান।');
      }
    }

    if (state.step === 'count') {
      const ads = Number(text);
      if (!Number.isInteger(ads) || ads < 1) {
        return ctx.reply('❌ Ads count 1 বা তার বেশি একটি পূর্ণ সংখ্যা হতে হবে। আবার সংখ্যা পাঠান।');
      }
      try {
        const topicRef = db.collection('topics').doc(state.topicId);
        const topicDoc = await topicRef.get();
        if (!topicDoc.exists) {
          delete updateAdsData[userId];
          return ctx.reply('❌ Video/Topic আর পাওয়া যাচ্ছে না। /ads দিয়ে আবার শুরু করুন।');
        }
        const oldAds = Math.max(1, Number(topicDoc.data().adsRequired) || 1);
        await topicRef.update({ adsRequired: ads, updatedAt: new Date().toISOString() });
        invalidateTopicsCache();
        delete updateAdsData[userId];
        return ctx.reply(
          `✅ Ads count সফলভাবে আপডেট হয়েছে!\n\n` +
          `🆔 Video/Topic ID: <code>${escapeHtml(state.topicId)}</code>\n` +
          `আগে ছিল: ${oldAds}টি Ads\n` +
          `এখন হবে: ${ads}টি Ads`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('❌ Error updating ads count:', error);
        return ctx.reply('❌ Ads count আপডেট করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
      }
    }
  }

  if (text.startsWith('/')) return;

  if (userSearchData[userId] && userSearchData[userId].step === 'query') {
    delete userSearchData[userId];
    await ctx.reply('🔍 খোঁজা হচ্ছে...');
    try {
      const results = await searchUsers(text.trim());
      if (!results.length) return ctx.reply('📭 এই নামে/ID-তে কোনো user পাওয়া যায়নি।');
      let message = `🔍 ফলাফল (${results.length}টি):\n\n`;
      const blockRows = [];
      results.forEach((user, index) => {
        const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        const displayName = escapeHtml(fullName || 'নাম পাওয়া যায়নি');
        const username = user.username ? `@${escapeHtml(String(user.username).replace(/^@/, ''))}` : 'Username নেই';
        const status = user.verified === true ? '✅' : '❌';
        const isBlocked = user.blocked === true;
        message += `${index + 1}. ${displayName}${isBlocked ? ' 🚫' : ''}\n   👤 ${username}\n   🆔 <code>${escapeHtml(user.userId)}</code> ${status}\n\n`;
        blockRows.push([Markup.button.callback(
          safeTruncate(`${isBlocked ? '✅ Unblock' : '🚫 Block'} ${(fullName || user.userId)}`, 40),
          `ublk:${user.userId}`
        )]);
      });
      return ctx.reply(message, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(blockRows).reply_markup });
    } catch (error) {
      console.error('❌ User search error:', error.message);
      return ctx.reply('❌ খুঁজতে সমস্যা হয়েছে: ' + error.message);
    }
  }

  if (topicSearchData[userId] && topicSearchData[userId].step === 'query') {
    delete topicSearchData[userId];
    await ctx.reply('🔍 খোঁজা হচ্ছে...');
    try {
      const results = await searchTopics(text);
      if (!results.length) return ctx.reply('📭 এই নামে/ID-তে কোনো Topic পাওয়া যায়নি।');
      const rows = results.map(t => {
        const label = `📌 ${safeTruncate(t.title || 'নামবিহীন', 40)} (${Number(t.videoCount || (Array.isArray(t.videos) ? t.videos.length : 0)) || 0} 📹)`;
        return [Markup.button.callback(label, 'aview:' + t.id)];
      });
      return ctx.reply(`🔍 ফলাফল (${results.length}টি):`, Markup.inlineKeyboard(rows));
    } catch (error) {
      console.error('❌ Topic search error:', error.message);
      return ctx.reply('❌ খুঁজতে সমস্যা হয়েছে: ' + error.message);
    }
  }

  if (appendVideoData[userId] && appendVideoData[userId].step === 'topicId') {
    const topicId = text.trim();
    const doc = await db.collection('topics').doc(topicId).get();
    if (!doc.exists) {
      return ctx.reply('❌ এই Topic ID পাওয়া যায়নি। আবার ID পাঠান, বা Topic Search ব্যবহার করুন।');
    }
    const t = doc.data();
    appendVideoData[userId] = { step: 'video', topicId };
    return ctx.reply(
      `📌 Topic পাওয়া গেছে: ${t.title || 'নামবিহীন'}\n📹 বর্তমান ভিডিও: ${t.videoCount || 0}\n\nএখন নতুন ভিডিওটি পাঠান, এটি এই Topic-এই যুক্ত হবে (Title/Thumbnail একই থাকবে):`
    );
  }

  if (broadcastData[userId]) {
    const data = broadcastData[userId];

    if (data.step === 'content') {
      const choice = text.toLowerCase();
      if (choice === 'skip') {
        data.type = 'text';
        data.step = 'message';
        await ctx.reply('📝 ব্রডকাস্টের মেসেজ লিখুন (রেফার লিংক সহ):');
      } else if (choice === 'poll') {
        data.type = 'poll';
        data.step = 'poll_question';
        await ctx.reply('❓ পোলের প্রশ্নটি লিখুন:');
      } else {
        await ctx.reply('⚠️ ছবি/ভিডিও/GIF পাঠান, "poll" লিখুন, অথবা "skip" লিখে শুধু টেক্সট পাঠান।');
      }
      return;
    }

    if (data.step === 'poll_question') {
      data.question = text;
      data.step = 'poll_options';
      await ctx.reply('📊 অপশনগুলো কমা (,) দিয়ে আলাদা করে লিখুন (কমপক্ষে ২টি, সর্বোচ্চ ১০টি):\nউদাহরণ: হ্যাঁ, না, জানি না');
      return;
    }

    if (data.step === 'poll_options') {
      const options = text.split(',').map(o => o.trim()).filter(o => o.length > 0);
      if (options.length < 2) {
        await ctx.reply('⚠️ কমপক্ষে ২টি অপশন দিন, কমা (,) দিয়ে আলাদা করে।');
        return;
      }
      if (options.length > 10) {
        await ctx.reply('⚠️ সর্বোচ্চ ১০টি অপশন দেওয়া যাবে।');
        return;
      }
      data.options = options;
      data.step = 'confirm';
      await showBroadcastPreview(ctx, data);
      return;
    }

    if (data.step === 'message') {
      data.message = text;
      data.step = 'confirm';
      await showBroadcastPreview(ctx, data);
      return;
    }
  }

  
});

bot.on('animation', async (ctx) => {
  const userId = ctx.from.id;
  if (await handleForwardedRepostCapture(ctx)) return;
  if (broadcastData[userId] && broadcastData[userId].step === 'content') {
    broadcastData[userId].type = 'animation';
    broadcastData[userId].file = ctx.message.animation.file_id;
    broadcastData[userId].step = 'message';
    await ctx.reply('📝 এবার ব্রডকাস্টের ক্যাপশন/মেসেজ লিখুন (রেফার লিংক সহ):');
  }
});

bot.on('photo', async (ctx) => {
  // 🐛 FIX: only the admin's workflows may ever put media into STORAGE_CHANNEL.
  // Media from normal users (photos, video files, GIF/video-sticker files …)
  // is ignored completely.
  if (!ctx.from || ctx.from.id !== ADMIN_ID) return;

  const userId = ctx.from.id;
  const photo = ctx.message.photo;
  const fileId = photo[photo.length - 1].file_id;

  if (await handleForwardedRepostCapture(ctx)) return;

  if (broadcastData[userId] && broadcastData[userId].step === 'content') {
    broadcastData[userId].type = 'photo';
    broadcastData[userId].file = fileId;
    broadcastData[userId].step = 'message';
    await ctx.reply('📝 এবার ব্রডকাস্টের ক্যাপশন/মেসেজ লিখুন (রেফার লিংক সহ):');
    return;
  }

  if (addTopicData[userId] && addTopicData[userId].step === 'thumbnail') {
    try {
      const storedFileId = await forwardPhotoToStorageChannel(ctx, fileId);
      const data = addTopicData[userId];
      data.thumbnail = storedFileId;
      data.step = 'ads';
      await ctx.reply('🔢 এই টপিক আনলক করতে কতগুলো অ্যাড দেখতে হবে? (শুধু সংখ্যা দিন):');
    } catch (error) {
      console.error('❌ Add Topic thumbnail error:', error);
      await ctx.reply('❌ থাম্বনেইল স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।');
    }
    return;
  }
  if (addVideoData[userId] && addVideoData[userId].step === 'thumbnail') {
    try {
      const storedFileId = await forwardPhotoToStorageChannel(ctx, fileId);
      const data = addVideoData[userId];
      data.thumbnail = storedFileId;
      data.step = 'ads';
      await ctx.reply('🔢 এই ভিডিও আনলক করতে কতগুলো অ্যাড দেখতে হবে? (শুধু সংখ্যা দিন):');
    } catch (error) {
      console.error('❌ Add Video thumbnail error:', error);
      await ctx.reply('❌ থাম্বনেইল স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।');
    }
    return;
  }

  if (postData[userId] && postData[userId].step === 'media' && postData[userId].type === 'photo') {
    postData[userId].fileId = fileId;
    postData[userId].step = 'topicId';
    await ctx.reply('🔢 এই Photo কোন Video/Topic-এর জন্য?\n\n👉 Video/Topic ID পাঠান:');
    return;
  }

  if (thumbnailData[userId] && thumbnailData[userId].step === 'photo') {
    try {
      const storedFileId = await forwardPhotoToStorageChannel(ctx, fileId);
      await db.collection('topics').doc(thumbnailData[userId].topicId).update({ thumbnail: storedFileId, updatedAt: new Date().toISOString() });
      const id = thumbnailData[userId].topicId;
      delete thumbnailData[userId]; invalidateTopicsCache();
      return ctx.reply(`✅ Thumbnail আপডেট হয়েছে।\n🆔 <code>${escapeHtml(id)}</code>`, { parse_mode: 'HTML' });
    } catch (e) { return ctx.reply('❌ Thumbnail আপডেট করতে সমস্যা হয়েছে।'); }
  }
});

// =============================================
// 💾 SAVE HELPERS
// =============================================

async function saveTopic(ctx, data) {
  try {
    const topicRef = db.collection('topics').doc();
    await topicRef.set({
      title: data.title,
      thumbnail: data.thumbnail,
      videos: data.videos,
      adsRequired: data.adsRequired,
      type: 'multi',
      videoCount: data.videos.length,
      unlockCount: 0,
      postRecords: [],
      sortOrder: Date.now(),
      createdAt: new Date().toISOString()
    });
    invalidateTopicsCache();
    await ctx.reply(`✅ টপিক "${data.title}" তৈরি হয়েছে!\n📹 ভিডিও সংখ্যা: ${data.videos.length}\n🔢 অ্যাড প্রয়োজন: ${data.adsRequired}\n🆔 টপিক আইডি: <code>${topicRef.id}</code>`, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });
  } catch (error) {
    console.error('Error saving topic:', error);
    await ctx.reply('❌ টপিক সেভ করতে সমস্যা হয়েছে।');
  }
}

async function saveVideo(ctx, data) {
  try {
    const topicRef = db.collection('topics').doc();
    await topicRef.set({
      title: data.title,
      thumbnail: data.thumbnail,
      videos: [data.videoId],
      adsRequired: data.adsRequired,
      type: 'single',
      videoCount: 1,
      unlockCount: 0,
      postRecords: [],
      sortOrder: Date.now(),
      createdAt: new Date().toISOString()
    });
    invalidateTopicsCache();
    await ctx.reply(`✅ ভিডিও "${data.title}" যোগ হয়েছে!\n🆔 টপিক আইডি: <code>${topicRef.id}</code>`, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup });
  } catch (error) {
    console.error('Error saving video:', error);
    await ctx.reply('❌ ভিডিও সেভ করতে সমস্যা হয়েছে।');
  }
}

// 🧬 Duplicate Topic — copies title/thumbnail/adsRequired from the source
// topic so the admin only has to send the new video(s), instead of typing
// everything again.
async function saveDuplicateTopic(ctx, data) {
  try {
    const topicRef = db.collection('topics').doc();
    await topicRef.set({
      title: data.title,
      thumbnail: data.thumbnail,
      videos: data.videos,
      adsRequired: data.adsRequired,
      type: data.videos.length > 1 ? 'multi' : 'single',
      videoCount: data.videos.length,
      unlockCount: 0,
      postRecords: [],
      sortOrder: Date.now(),
      createdAt: new Date().toISOString(),
      duplicatedFrom: data.sourceId || null
    });
    invalidateTopicsCache();
    await ctx.reply(
      `✅ Topic Duplicate হয়ে গেছে!\n\n📌 ${data.title}\n📹 ভিডিও সংখ্যা: ${data.videos.length}\n🔢 অ্যাড প্রয়োজন: ${data.adsRequired}\n🆔 নতুন টপিক আইডি: <code>${topicRef.id}</code>\n\n(Title/Thumbnail/Ads পুরোনো টপিক থেকে কপি করা হয়েছে।)`,
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup }
    );
  } catch (error) {
    console.error('Error saving duplicated topic:', error);
    await ctx.reply('❌ Duplicate Topic সেভ করতে সমস্যা হয়েছে।');
  }
}

// ➕ Append Video to an existing Topic — keeps the same title/thumbnail/ads,
// just grows the videos array (and flips type to 'multi' once there's more
// than one video).
async function appendVideoToTopic(topicId, storedFileId) {
  const ref = db.collection('topics').doc(String(topicId));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const videos = Array.isArray(data.videos) ? data.videos.slice() : [];
  videos.push(storedFileId);
  const update = {
    videos,
    videoCount: videos.length,
    type: videos.length > 1 ? 'multi' : (data.type || 'single'),
    updatedAt: new Date().toISOString()
  };
  await ref.update(update);
  invalidateTopicsCache();
  return { id: topicId, title: data.title || 'নামবিহীন', videoCount: videos.length };
}

// ============ API ENDPOINTS ============

// 🐛 FIX (duplicate reads on every single Mini App open): both this endpoint
// and /api/user-unlocked/:userId read the SAME user document, and the
// front-end was calling them back-to-back on load, on every resume, AND from
// the old app.js (loadTopics -> loadUserStatus). If two calls for the exact
// same user land within the same instant (double-invoke on load, a resume
// firing at the same time as the 5-min safety poll, etc.), they used to
// trigger two separate Firestore reads for data that hadn't changed at all
// in that instant. This in-flight coalescer (same pattern as
// getSingleTopicCached above) makes truly-concurrent calls for the same user
// share ONE read instead of one each. It never serves stale data across
// separate calls — only calls that are already overlapping in time share the
// result — so it can't hide a just-completed unlock or a fresh /block.
const userDocInflight = new Map(); // userId -> Promise<DocumentSnapshot>
function getUserDocCoalesced(userId) {
  const id = String(userId);
  const pending = userDocInflight.get(id);
  if (pending) return pending;
  const promise = db.collection('users').doc(id).get()
    .finally(() => userDocInflight.delete(id));
  userDocInflight.set(id, promise);
  return promise;
}

app.get('/api/users/verify/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const doc = await getUserDocCoalesced(userId);
    if (!doc.exists) {
      return res.json({ verified: false, exists: false });
    }
    const data = doc.data();
    res.json({
      verified: data.verified || false,
      exists: true,
      username: data.username,
      firstName: data.firstName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/topic/:topicId', async (req, res) => {
  try {
    const topicId = String(req.params.topicId || '').trim();
    if (!topicId) return res.status(400).json({ error: 'Topic ID required' });

    // Hot-topic cache + request coalescing: many users opening the same post at once
    // share one Firestore read instead of creating hundreds/thousands of reads.
    const topic = await getSingleTopicCached(topicId);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    // 🔒 The cache entry now also carries `videos` (raw Telegram file_ids) so
    // the delivery path can reuse it instead of a second Firestore read —
    // but those file_ids must NEVER reach a public client response, or
    // anyone could fetch the "locked" video directly from Telegram without
    // ever watching an ad. Strip it here, right before it leaves the server.
    const { videos, ...publicTopic } = topic;

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json(publicTopic);
  } catch (error) {
    console.error('❌ Single topic API error:', error);
    res.status(500).json({ error: 'Could not load video' });
  }
});

app.get('/api/topics', async (req, res) => {
  try {
    const topics = await getTopicsCached();
    const cards = topics.map(({ videos, ...topic }) => ({
      ...topic,
      videoCount: topic.videoCount || (Array.isArray(videos) ? videos.length : 0)
    }));
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json(cards);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/thumbnail/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  try {
    // Already have the actual image bytes cached in memory — serve instantly,
    // no round trip to Telegram at all. This is the common case after the
    // first user has ever opened a given thumbnail.
    const cached = getThumbBytesCached(fileId);
    if (cached) {
      res.set('Content-Type', cached.type);
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      res.set('ETag', fileId);
      return res.end(cached.buf);
    }

    const now = Date.now();
    let entry = fileLinkCache.get(fileId);
    if (!entry || entry.expiresAt <= now) {
      entry = { promise: bot.telegram.getFileLink(fileId), expiresAt: now + FILE_LINK_CACHE_TTL };
      fileLinkCache.set(fileId, entry);
      capFileLinkCache();
      entry.url = await entry.promise;
      entry.promise = null;
    } else if (entry.promise) {
      entry.url = await entry.promise;
      entry.promise = null;
    }

    // Fetch the bytes ourselves (instead of redirecting the browser to
    // Telegram) so we can cache them for every future request, and so the
    // user's device only ever talks to our own server.
    const upstream = await fetch(entry.url.toString());
    if (!upstream.ok) throw new Error('upstream ' + upstream.status);
    const type = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await upstream.arrayBuffer());
    cacheThumbBytes(fileId, buf, type);

    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('ETag', fileId);
    return res.end(buf);
  } catch (error) {
    fileLinkCache.delete(fileId);
    res.status(404).json({ error: 'Thumbnail not found' });
  }
});

app.get('/api/user-unlocked/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const doc = await getUserDocCoalesced(userId);
    if (!doc.exists) {
      return res.json({ topics: [] });
    }
    const data = doc.data();
    const unlockedTopics = data.unlockedTopics || [];
    const topicUnlockTime = data.topicUnlockTime || {};
    const now = Date.now();
    const activeUnlocked = unlockedTopics.filter(topicId => {
      const time = topicUnlockTime[topicId];
      return time && (now - time) < THIRTY_MINUTES;
    });
    const expiresAt = {};
    activeUnlocked.forEach(topicId => {
      expiresAt[topicId] = Number(topicUnlockTime[topicId]) + THIRTY_MINUTES;
    });
    const today = getDhakaDateKey();
    const dailyUsed = data.dailyAdDate === today ? (Number(data.dailyAdsUsed) || 0) : 0;
    const dailyLimit = await getDailyAdLimit();
    // `unlockedTopics` only holds the last 30 minutes, so the permanent watch
    // history (watchedTopicIds) is merged in for the Mini App suggestions.
    const watchedIds = Array.isArray(data.watchedTopicIds) ? data.watchedTopicIds : [];
    const history = Array.from(new Set([...watchedIds, ...unlockedTopics]));
    res.json({
      topics: activeUnlocked,
      history,
      expiresAt,
      adProgress: data.adProgress || {},
      dailyLimit,
      dailyUsed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function deliverUnlockedTopic(userId, topicId, userStateHint) {
  inflightDeliveries++;
  try {
    return await deliverUnlockedTopicInner(userId, topicId, userStateHint);
  } finally {
    inflightDeliveries--;
  }
}

// `userStateHint` (optional): { blocked, unlockedTopics, topicUnlockTime,
// sentMessages, watchedTopicIds }. When the caller (currently only
// /api/ad-complete) has JUST read this exact user doc inside its own
// transaction a moment ago, it passes that state here so this function can
// skip re-reading the same document — see the fix note below.
async function deliverUnlockedTopicInner(userId, topicId, userStateHint) {
  const userRef = db.collection('users').doc(userId.toString());

  let data;
  if (userStateHint) {
    // 🐛 FIX (extra Firestore read on every single unlock): this used to
    // ALWAYS do its own `userRef.get()`, even when called immediately after
    // /api/ad-complete's own transaction had just read the very same user
    // document. Reusing that already-known state removes one full read per
    // unlock from the hottest path in the app.
    data = userStateHint;
  } else {
    const doc = await userRef.get();
    data = doc.exists ? doc.data() : {};
  }

  // 🚫 Single choke point for all delivery paths (/api/ad-complete AND the
  // /start pending-unlock flow) — a blocked user never gets a video, no
  // matter which route triggered this call.
  if (data.blocked === true) {
    throw new Error('User is blocked');
  }

  const unlockedTopics = Array.isArray(data.unlockedTopics) ? data.unlockedTopics.slice() : [];
  const topicUnlockTime = { ...(data.topicUnlockTime || {}) };
  const priorSent = Array.isArray(data.sentMessages) ? data.sentMessages : [];

  const now = Date.now();
  // 🐛 FIX (extra Firestore read on every single unlock): this used to do
  // its own raw `topicRef.get()` just to fetch `videos`, even though
  // /api/ad-complete had already fetched (and cached) this exact topic
  // moments earlier via getSingleTopicCached(). The cache now carries
  // `videos` too (see getSingleTopicCached), so reuse it here instead of a
  // second read — this call will almost always be a cache hit.
  const topic = await getSingleTopicCached(topicId);
  if (!topic) throw new Error('Topic not found');

  const firstUnlock = !unlockedTopics.includes(topicId);
  if (firstUnlock) {
    unlockedTopics.push(topicId);
    topicUnlockTime[topicId] = now;

    // Permanent watch history (used by the Mini App suggestions). The
    // `unlockedTopics` list above is wiped after 30 minutes, so it can't be
    // used as "what has this user already watched".
    const watched = (Array.isArray(data.watchedTopicIds) ? data.watchedTopicIds : []).filter(x => x !== topicId);
    watched.push(topicId);

    // Save the unlock BEFORE sending, so a restart mid-delivery can't lose it.
    await userRef.set({
      unlockedTopics,
      topicUnlockTime,
      watchedTopicIds: watched.slice(-300)
    }, { merge: true });

    // 🐛 FIX (1 extra read + 1 extra write on every single unlock): this
    // used to run its own `db.runTransaction(tx.get(topicRef) → tx.set(...))`
    // right here, synchronously, for every unlock. Now just record it in
    // memory — see recordUnlock()/flushUnlockStats() above — and it's
    // batched into one read+write per topic every ~30s instead of one pair
    // per unlock.
    recordUnlock(topicId);
  }

  const videos = topic.videos || [];
  // 🐛 FIX (regression: unlocks were redirecting through the channel-post
  // /start deep-link even for users who opened the Mini App straight from
  // the bot's own Menu Button): the caller used to decide "can I DM this
  // user directly?" purely from the `botStarted` Firestore flag, which is
  // ONLY ever set inside the /start handler. Since the old forced
  // join/verification flow (which guaranteed everyone pressed /start at
  // least once) was removed, most real users never run /start at all — they
  // just tap the Menu Button — so `botStarted` stayed false for them
  // forever, and every one of their unlocks got routed through the
  // "brand-new user" deep-link path meant for channel-post visitors.
  // Track whether we actually managed to deliver (or had already delivered)
  // at least one video here, and whether every attempt instead hit
  // Telegram's "chat not found" (the real, authoritative signal that this
  // user's chat with the bot doesn't exist yet) — so the caller can fall
  // back to the deep-link flow ONLY when that's genuinely true, instead of
  // trusting a flag that most users never set.
  let anyDelivered = false;
  let anyNotStarted = false;
  const newlySent = []; // collected here, written to Firestore ONCE after the loop
  for (const videoId of videos) {
    try {
      const alreadySent = priorSent.some(m => m && m.videoId === videoId && m.topicId === topicId && (now - sentAtOf(m)) < THIRTY_MINUTES);
      if (alreadySent) { anyDelivered = true; continue; }
      // safeSendVideo uses 403-tolerant wrapper
      const sentMsg = await safeSendVideo(userId, videoId, {
        protect_content: true,
        caption: '⏳ এই ভিডিও ৩০ মিনিট পর ডিলিট হয়ে যাবে।'
      });
      if (sentMsg) {
        anyDelivered = true;
        // Collected in memory, not written per-video anymore — see
        // trackSentMessages() below the delivery loop for why.
        newlySent.push({ messageId: sentMsg.message_id, chatId: userId, videoId, topicId, sentAt: Date.now() });
      } else {
        // safeSendVideo swallowed a "blocked"/"chat not found"/"deactivated"
        // error and returned null instead of throwing.
        anyNotStarted = true;
      }
    } catch (sendError) {
      console.error(`❌ Error sending video:`, sendError.message);
    }
  }

  // One read + one write for the whole batch, no matter how many videos this
  // topic just sent (see trackSentMessages fix note above).
  if (newlySent.length) await trackSentMessages(userRef, newlySent);

  if (!anyDelivered && anyNotStarted) {
    // Nothing could be sent, specifically because this user has no open
    // chat with the bot yet — genuinely needs the /start deep-link, not a
    // silent "delivered" response.
    throw new Error('NOT_STARTED');
  }

  // Do not invalidate the public topics cache for every unlock. Unlock counts
  // are analytics and can safely appear after the normal cache TTL.
  return { success: true, videosDelivered: videos.length };
}

// Issue a short-lived token right before showing the ad. The frontend must
// send this back with /api/ad-complete — this is what makes it hard for a
// script to skip the ad and call ad-complete directly.
// 🔁 Ad-network rotation counter — GLOBAL (not per-topic), because most
// topics only require 1 ad to unlock (adsRequired=1): if the rotation were
// keyed off each topic's own progress (adCount, which is always 0 at the
// start of a 1-ad topic), Monetag would win literally every single time and
// OnClickA would never get picked. A single global, atomically-incremented
// counter guarantees a genuine 1st→Monetag, 2nd→OnClickA, 3rd→Monetag...
// alternation across every ad watched by every user, regardless of how many
// ads any individual topic needs.
// 🔁 Ad-network rotation counter — plain in-memory (NOT Firestore).
//
// ⚠️ Earlier version of this used a Firestore transaction (1 read + 1
// write) on EVERY /api/ad-start call to keep the counter durable across
// restarts. That directly fought the caching strategy the rest of this file
// uses everywhere else (topicsCache, fileLinkCache, dailyLimitCache, etc. —
// all exist specifically to keep Firestore usage low) and was the reason
// Firestore usage spiked toward the daily quota: ad-start is a hot path
// (fires on every single ad watch), so it was doubling/tripling Firestore
// ops for zero real benefit.
//
// The counter's ONLY job is to alternate Monetag/OnClickA — it doesn't need
// to survive a server restart or be shared across multiple server
// instances. A plain JS variable does that with ZERO Firestore cost. A
// restart just resets it to `0` (→ starts again at Monetag), which is
// completely harmless for a rotation.
let adNetworkRotationCounter = 0;
function nextAdNetwork() {
  const current = adNetworkRotationCounter++;
  return (current % 2 === 0) ? 'monetag' : 'onclicka';
}

app.post('/api/ad-start', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const topicId = String(req.body.topicId || '').trim();
    if (!userId || !topicId) return res.status(400).json({ error: 'userId and topicId are required' });

    // Do not read Firestore here. /api/ad-complete performs the authoritative
    // blocked-user check inside its transaction. This endpoint only issues a
    // short-lived, single-use session token, so one ad watch needs one user
    // read instead of two.
    cleanupAdTokens();
    const token = crypto.randomBytes(16).toString('hex');
    adTokens.set(token, { userId, topicId, createdAt: Date.now() });
    const network = await nextAdNetwork();
    return res.json({ success: true, token, network });
  } catch (error) {
    console.error('❌ /api/ad-start error:', error.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/ad-complete', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const topicId = String(req.body.topicId || '').trim();
    const token = String(req.body.token || '').trim();
    if (!userId || !topicId) return res.status(400).json({ error: 'userId and topicId are required' });

    // 🛡️ Require a valid, matching, not-yet-used ad-start token that's old
    // enough to correspond to a real ad view (see AD_TOKEN_TTL_MS / MIN_AD_DURATION_MS).
    const tokenData = adTokens.get(token);
    if (!tokenData || tokenData.userId !== userId || tokenData.topicId !== topicId) {
      return res.status(400).json({ success: false, error: '❌ Ad session verify করা যায়নি। আবার Ad দেখুন।' });
    }
    if ((Date.now() - tokenData.createdAt) < MIN_AD_DURATION_MS) {
      return res.status(400).json({ success: false, error: '❌ Ad সম্পূর্ণ না দেখেই সম্পন্ন দেখানো হয়েছে বলে মনে হচ্ছে। আবার চেষ্টা করুন।' });
    }
    adTokens.delete(token); // single-use

    // Use the shared topic cache/request coalescer. This removes a hot-path
    // Firestore read for every completed ad while keeping topic settings fresh
    // through the normal cache invalidation used by admin updates.
    const cachedTopic = await getSingleTopicCached(topicId);
    if (!cachedTopic) return res.status(404).json({ error: 'Topic not found' });
    const required = Math.max(1, Number(cachedTopic.adsRequired) || 1);

    const userRef = db.collection('users').doc(userId);

    // The transaction below performs the authoritative user read/check.
    // Avoid an extra Firestore read on every ad completion.
    const dailyLimit = await getDailyAdLimit();
    const today = getDhakaDateKey();
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      const isNewUser = !snap.exists;
      const data = snap.exists ? snap.data() : {};
      if (data.blocked === true) {
        return { blocked: true };
      }
      const progress = { ...(data.adProgress || {}) };
      let unlockedTopics = data.unlockedTopics || [];
      const topicUnlockTime = { ...(data.topicUnlockTime || {}) };
      const nowTx = Date.now();

      // 🐛 FIX (repeat-unlock bug, live version): unlockedTopics is only
      // pruned of expired entries by the background cleanup cron (every 2
      // min) — and that cron can lag (Render free-tier sleep, or simply not
      // having reached this user yet). If a topic's 30-min window has
      // already elapsed but the cron hasn't caught up, `unlockedTopics`
      // still lists it as active even though the Mini App itself (which
      // checks topicUnlockTime directly in /api/user-unlocked) already shows
      // it as locked again. Trusting stale array membership here let anyone
      // re-unlock an actually-expired topic with just the ONE ad they'd
      // just watched. Now we check the real timestamp ourselves instead of
      // relying on the cron having already run.
      //
      // 🐛 FIX #2 (orphaned adProgress, root cause of "1 ad instead of 3"
      // still happening even with the fix above): the self-heal below used
      // to run ONLY when `unlockedTopics.includes(topicId)` was true. But a
      // record can end up with `unlockedTopics`/`topicUnlockTime` already
      // cleared (by an older cron run, or any earlier partial write) while
      // `adProgress[topicId]` is still sitting at `required` from that same
      // old unlock — nothing left to trigger cleanup on. On the user's very
      // next ad watch, `unlockedTopics.includes(topicId)` was false, so the
      // block never ran, `progress[topicId]` was never deleted, and the
      // transaction saw `current === required` immediately: one ad watch
      // and `next >= required` was true again. Now we check `progress`,
      // `topicUnlockTime`, and `unlockedTopics` independently — any one of
      // them lingering for a topic that isn't currently active is enough to
      // trigger the cleanup, regardless of what the other two say.
      const unlockTime = Number(topicUnlockTime[topicId]) || 0;
      const stillActive = unlockTime > 0 && (nowTx - unlockTime) < THIRTY_MINUTES;
      // 🐛 FIX (regression from the previous pass — this is what just broke
      // "never unlocks, stuck showing ads"): checking bare
      // `hasOwnProperty(progress, topicId)` treated ANY existing progress —
      // including a completely normal, legitimate in-progress count like 1
      // or 2 out of 3 — as "stale", and wiped it back to 0 on every single
      // watch. A topic is never "stillActive" until it's FULLY unlocked, so
      // that condition fired on watch #2, #3, every time, and the count
      // could never climb past 1. The actual orphan signature (leftover
      // from a completed unlock whose unlockedTopics/topicUnlockTime entries
      // got lost) is progress sitting AT OR ABOVE `required` — that can only
      // happen after a topic was already fully earned once. A genuine
      // in-progress count is always below `required`, so checking `>=
      // required` here catches real orphans without touching normal counting.
      const hasOrphanedFullProgress = !stillActive && Number(progress[topicId]) >= required;
      const hasStaleData = !stillActive && (
        unlockedTopics.includes(topicId) ||
        Object.prototype.hasOwnProperty.call(topicUnlockTime, topicId) ||
        hasOrphanedFullProgress
      );
      let expiredCleanup = false;
      if (hasStaleData) {
        // Expired (or orphaned) but not yet cleaned up — do it right now so
        // this watch actually has to earn the full ad count again, instead
        // of short-circuiting as "already unlocked".
        unlockedTopics = unlockedTopics.filter(t => t !== topicId);
        delete topicUnlockTime[topicId];
        delete progress[topicId];
        expiredCleanup = true;
      }
      // 🐛 FIX (root cause of "after a video re-locks, every ad only ever counts
      // as 1 — the counter never goes past 1/N"): the cleanup above only
      // changes these values IN MEMORY. Persisting them with
      // `set(..., { merge: true })` does NOT remove a key from a Firestore
      // map (nested maps are merged, a missing key is simply left alone), so
      // the expired `topicUnlockTime[topicId]` stayed in the database forever.
      // On the very next ad, `hasStaleData` saw that leftover timestamp again,
      // wiped the progress back to 0, and the count was reset to 1 — every
      // single time. Only topics the user had unlocked before were affected,
      // which is exactly why only already-watched videos got stuck. Real
      // deletions need FieldValue.delete().
      const staleDeletes = expiredCleanup ? {
        topicUnlockTime: { [topicId]: admin.firestore.FieldValue.delete() },
        adProgress: { [topicId]: admin.firestore.FieldValue.delete() }
      } : null;
      const current = Number(progress[topicId]) || 0;
      if (stillActive) return { count: required, required, unlocked: true, limitReached: false, dailyUsed: Number(data.dailyAdsUsed) || 0, adViewCounted: false, userState: { blocked: false, unlockedTopics, topicUnlockTime, sentMessages: data.sentMessages, watchedTopicIds: data.watchedTopicIds } };

      const dailyUsed = data.dailyAdDate === today ? (Number(data.dailyAdsUsed) || 0) : 0;
      if (dailyUsed >= dailyLimit) {
        // Still persist the just-discovered expiry cleanup even though this
        // particular watch doesn't count (daily limit reached) — otherwise
        // the next attempt would redo the same stale-array check for nothing.
        if (expiredCleanup) tx.set(userRef, { adProgress: staleDeletes.adProgress, unlockedTopics, topicUnlockTime: staleDeletes.topicUnlockTime }, { merge: true });
        return { count: current, required, unlocked: false, limitReached: true, dailyUsed, adViewCounted: false };
      }

      const next = Math.min(current + 1, required);
      progress[topicId] = next;

      const userWrite = { adProgress: progress, dailyAdDate: today, dailyAdsUsed: dailyUsed + 1 };
      if (expiredCleanup) Object.assign(userWrite, { unlockedTopics, topicUnlockTime: staleDeletes.topicUnlockTime });
      if (isNewUser) {
        // 🐛 FIX: this is the FIRST-EVER Firestore doc for this user in many
        // cases (anyone who opens the Mini App and watches an ad before ever
        // hitting /start). Previously this created a bare-bones doc here
        // with none of the usual default fields, and — critically — never
        // told the Daily Summary a new user had shown up, since only
        // getOrCreateUser() (called from /start) used to do that counting.
        // By the time /start ran later, the doc already existed, so it was
        // never counted as "new" there either. Net effect: the Daily
        // Summary's new-user number was silently wrong for most real users,
        // since this bot's primary entry point is the Mini App, not /start.
        Object.assign(userWrite, {
          userId,
          verified: false,
          verifiedAt: null,
          createdAt: new Date().toISOString(),
          unlockedTopics: [],
          topicUnlockTime: {},
          sentMessages: [],
          cleanupDueAt: null
        });
        tx.set(db.collection('system').doc('dailyStats'), {
          newUsersByDate: { [today]: admin.firestore.FieldValue.increment(1) }
        }, { merge: true });
      }
      tx.set(userRef, userWrite, { merge: true });
      return { count: next, required, unlocked: next >= required, limitReached: false, dailyUsed: dailyUsed + 1, adViewCounted: true, userState: { blocked: false, unlockedTopics, topicUnlockTime, sentMessages: data.sentMessages, watchedTopicIds: data.watchedTopicIds } };
    });

    if (result.blocked) {
      return res.status(403).json({ success: false, blocked: true, error: 'আপনাকে ব্যবহার থেকে ব্লক করা হয়েছে।' });
    }

    // Count this as a real ad impression for the revenue estimate — but only
    // when it was an actual fresh ad watch, not the "already unlocked" or
    // "daily limit reached" short-circuits above.
    if (result.adViewCounted) recordAdView();

    if (result.limitReached) {
      return res.status(429).json({ success: false, limitReached: true, dailyLimit, dailyUsed: result.dailyUsed, error: 'আজকের Ad Limit শেষ' });
    }

    if (result.unlocked) {
      // 🐛 FIX (was redirecting through the channel-post-style /start
      // deep-link for basically everyone): this used to branch on the
      // `botStarted` Firestore flag, which is ONLY ever set inside the
      // /start command handler. Since the old forced join/verification flow
      // (which guaranteed every user pressed /start at least once) was
      // removed, most real users now open the Mini App straight from the
      // bot's Menu Button and never run /start — so `botStarted` stayed
      // false for them forever, and EVERY one of their unlocks got routed
      // through the "brand-new user" deep-link path meant for channel-post
      // visitors, instead of delivering straight into the bot chat like
      // before.
      //
      // Always attempt direct delivery first, regardless of `botStarted`.
      // deliverUnlockedTopic() now throws a specific 'NOT_STARTED' error
      // only when Telegram itself confirms this user has no open chat with
      // the bot yet (a real "chat not found" from the API) — that's the
      // one case that genuinely needs the /start deep-link fallback below.
      try {
        await deliverUnlockedTopic(userId, topicId, result.userState);
        const directStartUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null;
        return res.json({
          success: true,
          count: result.count,
          required: result.required,
          unlocked: true,
          directDelivered: true,
          // Every unlock (not just the first) should take the user into the
          // bot chat so they actually see the video land, instead of the
          // delivery happening silently in the background.
          requiresStart: !!directStartUrl,
          startUrl: directStartUrl || undefined
        });
      } catch (deliveryError) {
        if (deliveryError.message === 'NOT_STARTED') {
          // Genuinely a brand-new/never-chatted user: fall back to the
          // /start deep-link so Telegram can establish the bot chat.
          if (!BOT_USERNAME) {
            return res.status(500).json({
              success: false,
              error: 'BOT_USERNAME is not configured on the server.'
            });
          }

          await userRef.set({
            pendingUnlockTopicId: topicId,
            pendingUnlockAt: Date.now()
          }, { merge: true });

          const startUrl = `https://t.me/${BOT_USERNAME}?start=unlock_${encodeURIComponent(topicId)}`;
          return res.json({
            success: true,
            count: result.count,
            required: result.required,
            unlocked: true,
            requiresStart: true,
            startUrl
          });
        }

        console.error('❌ Direct topic delivery error:', deliveryError.message);
        // 🐛 FIX (root cause of "3/3 ads watched but 'unlocked' never
        // shows"): the ad count was already validated and committed inside
        // the transaction above BEFORE we ever got here — the user has
        // genuinely earned the unlock. Previously, if sending the video to
        // Telegram failed for any reason (rate limit, bot blocked, network
        // hiccup, etc.), this returned success:false with a 500 status.
        // The Mini App treated that as "the ad didn't count" and reset the
        // button back to its original "Xটি অ্যাড দেখে আনলক করুন" text —
        // even though the topic WAS unlocked in the database. The user
        // then had to re-watch all the ads for nothing. Never let a
        // delivery hiccup undo an already-earned unlock in the UI: report
        // success/unlocked normally, and let the user pull up the bot chat
        // themselves (or the next successful delivery attempt) to actually
        // receive the video.
        const directStartUrl = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null;
        return res.json({
          success: true,
          count: result.count,
          required: result.required,
          unlocked: true,
          directDelivered: false,
          deliveryError: true,
          requiresStart: !!directStartUrl,
          startUrl: directStartUrl || undefined
        });
      }
    }

    res.json({ success: true, count: result.count, required: result.required, unlocked: false });
  } catch (error) {
    console.error('❌ Ad completion error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/unlock-topic', async (req, res) => {
  return res.status(403).json({ error: 'Complete the required rewarded ads first.' });
});

// =============================================
// 🩺 HEALTH CHECK + SELF-PING (Render Free-এর জন্য critical)
// =============================================

app.get('/health', (req, res) => {
  const botRunning = !!(bot && bot.telegram);
  res.json({
    ok: true,
    botRunning,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString(),
    memory: process.memoryUsage().rss
  });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'telegram-bot', time: new Date().toISOString() });
});

// Render Free service sleep এড়ানোর জন্য self-ping (প্রতি ১০ মিনিট)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || null;
if (SELF_URL) {
  setInterval(() => {
    // Node 18+ এ global fetch built-in
    if (typeof fetch === 'function') {
      fetch(`${SELF_URL}/health`).catch(() => {});
    }
  }, 10 * 60 * 1000);
  console.log(`🔁 Self-ping enabled for ${SELF_URL}/health`);
}

// =============================================
// 🕒 SCHEDULED POSTS — fires exactly on time via an in-memory timer set the
// moment a post is scheduled (no repeated Firestore polling/reads). A very
// infrequent safety-net cron below only exists to catch posts that were due
// while the server happened to be restarting (timers don't survive that).
// =============================================
const scheduledTimers = new Map(); // docId -> Node timeout handle
const MAX_TIMEOUT_MS = 20 * 24 * 60 * 60 * 1000; // Node setTimeout overflows past ~24.8 days

async function firePostSchedule(docId) {
  scheduledTimers.delete(docId);
  const ref = db.collection('scheduledPosts').doc(docId);

  // 🐛 FIX: this used to be a plain read-then-act (get() → check status →
  // publish → set 'sent'), which is NOT atomic. If the server restarted
  // (e.g. Render waking back up) while a post was due, both the startup
  // recovery pass and the 30-min safety-net cron could read status:'pending'
  // before either had a chance to write 'sent' — so both proceeded to
  // actually publish, sending the same post to the channel twice. Claiming
  // it inside a transaction (flip 'pending' → 'sending' atomically) means
  // only one caller can ever win the race.
  let sp = null;
  try {
    sp = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().status !== 'pending') return null;
      const data = doc.data();
      tx.set(ref, { status: 'sending', claimedAt: Date.now() }, { merge: true });
      return data;
    });
  } catch (e) {
    console.error('❌ firePostSchedule claim error:', e.message);
    return;
  }
  if (!sp) return; // already claimed by another call, cancelled, or already sent

  const now = Date.now();
  const channels = Array.isArray(sp.channels) && sp.channels.length ? sp.channels : (POST_CHANNEL ? [POST_CHANNEL] : []);
  const lines = [];
  try {
    const keyboard = await buildConfiguredPostKeyboard(sp.topicId);
    for (const channelId of channels) {
      try {
        let sent;
        if (sp.type === 'video') {
          sent = await bot.telegram.sendVideo(channelId, sp.fileId, { caption: sp.caption || undefined, reply_markup: keyboard.reply_markup });
        } else {
          sent = await bot.telegram.sendPhoto(channelId, sp.fileId, { caption: sp.caption || undefined, reply_markup: keyboard.reply_markup });
        }
        await recordTopicPost(sp.topicId, channelId, sent.message_id, sp.type, sp.caption || '', sp.topicId);
        lines.push(`✅ ${channelId} — Message ID: ${sent.message_id}`);
      } catch (chErr) {
        console.error(`❌ Scheduled post error [${channelId}]:`, chErr.message);
        lines.push(`❌ ${channelId} — ${chErr.message}`);
      }
    }
    await ref.set({ status: 'sent', sentAt: now, result: lines }, { merge: true });
  } catch (err) {
    console.error('❌ Scheduled post failed:', docId, err.message);
    await ref.set({ status: 'failed', error: err.message, sentAt: now }, { merge: true }).catch(() => {});
    lines.push(`❌ সম্পূর্ণ ব্যর্থ: ${err.message}`);
  }

  // 🔁 Recurring posts: re-arm for the next occurrence instead of leaving
  // status as a terminal 'sent'/'failed'. Cancelling (schedcancel:) sets
  // status to 'cancelled', which the exists-check at the top of this
  // function already catches before we'd ever get here again.
  if (sp.recurrence === 'daily' || sp.recurrence === 'weekly') {
    const intervalMs = (sp.recurrence === 'daily' ? 1 : 7) * 24 * 60 * 60 * 1000;
    let nextAt = sp.scheduledAt + intervalMs;
    while (nextAt <= now) nextAt += intervalMs; // catch up if the server was down past one cycle
    await ref.set({ status: 'pending', scheduledAt: nextAt, lastFiredAt: now }, { merge: true });
    schedulePostTimer(docId, nextAt - now);
  }

  if (ADMIN_ID) {
    await safeSendMessage(
      ADMIN_ID,
      `🕒 Scheduled Post সম্পন্ন হয়েছে\n\n📌 Title: ${escapeHtml(sp.title || 'নামবিহীন ভিডিও')}\n🆔 Video/Topic ID: <code>${escapeHtml(sp.topicId)}</code>\n\n${escapeHtml(lines.join('\n'))}`,
      { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Admin Panel', 'adm_home')]]).reply_markup }
    ).catch(() => {});
  }
}

// Arms (or re-arms, in MAX_TIMEOUT_MS-sized chunks for far-future posts) an
// in-memory timer for one scheduled post. Safe to call multiple times for
// the same docId — it always clears any existing timer first.
function schedulePostTimer(docId, delayMs) {
  const existing = scheduledTimers.get(docId);
  if (existing) clearTimeout(existing);
  const chunk = Math.min(Math.max(delayMs, 0), MAX_TIMEOUT_MS);
  const remaining = delayMs - chunk;
  const handle = setTimeout(() => {
    if (remaining > 0) schedulePostTimer(docId, remaining);
    else firePostSchedule(docId).catch(e => console.error('❌ firePostSchedule error:', e.message));
  }, chunk);
  scheduledTimers.set(docId, handle);
}

// On boot: pick up anything still pending (covers posts that were due while
// the server was restarting, and re-arms timers for future ones) — this is
// the ONLY bulk Firestore read this feature does under normal operation.
(async function recoverScheduledPosts() {
  try {
    const snap = await db.collection('scheduledPosts').where('status', '==', 'pending').get();
    const now = Date.now();
    snap.docs.forEach(doc => {
      const scheduledAt = Number(doc.data().scheduledAt) || 0;
      if (scheduledAt <= now) firePostSchedule(doc.id).catch(e => console.error('❌ firePostSchedule error:', e.message));
      else schedulePostTimer(doc.id, scheduledAt - now);
    });
  } catch (error) {
    console.error('❌ recoverScheduledPosts error:', error.message);
  }
})();

// Safety net only — catches the rare case of a lost in-memory timer without
// a full restart. Runs once every 30 minutes, not every minute, to keep
// Firestore reads minimal (this is a deliberate trade-off: worst case a
// missed post fires up to ~30 minutes late instead of never).
cron.schedule('*/30 * * * *', async () => {
  if (!botLaunched) return; // not the live poller in this overlap window — skip
  try {
    const now = Date.now();
    const dueSnap = await db.collection('scheduledPosts')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', now)
      .limit(20)
      .get();
    for (const doc of dueSnap.docs) {
      if (!scheduledTimers.has(doc.id)) {
        await firePostSchedule(doc.id);
      }
    }

    // Recover posts stuck mid-send (the process crashed between claiming
    // and finishing — extremely rare, but without this they'd stay
    // 'sending' forever and never retry).
    const stuckCutoff = now - 10 * 60 * 1000;
    const stuckSnap = await db.collection('scheduledPosts')
      .where('status', '==', 'sending')
      .where('claimedAt', '<=', stuckCutoff)
      .limit(20)
      .get();
    for (const doc of stuckSnap.docs) {
      await doc.ref.set({ status: 'pending' }, { merge: true });
      firePostSchedule(doc.id).catch(e => console.error('❌ firePostSchedule retry error:', e.message));
    }
  } catch (error) {
    console.error('❌ Scheduled post safety-net cron error:', error.message);
  }
});

// =============================================
// 📊 DAILY SUMMARY AUTO-MESSAGE — every night at 00:00 (Asia/Dhaka),
// the bot itself sends the admin a recap of the day that just ended:
// new users, ad views, and topic unlocks. No manual checking needed.
// =============================================
cron.schedule('0 0 * * *', async () => {
  try {
    if (!botLaunched) return; // not the live poller in this overlap window — skip
    if (!ADMIN_ID) return;

    // The cron fires right as the Dhaka date rolls over, so "today" per
    // getDhakaDateKey() is already the NEW day — we want the day that just
    // finished, i.e. yesterday in Dhaka time.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateKey = getDhakaDateKey(yesterday);

    const [dailyStatsDoc, adStatsDoc, topics] = await Promise.all([
      db.collection('system').doc('dailyStats').get(),
      db.collection('system').doc('adStats').get(),
      getTopicsCached()
    ]);

    const newUsers = Number((dailyStatsDoc.exists && dailyStatsDoc.data().newUsersByDate || {})[dateKey]) || 0;
    const adViews = Number((adStatsDoc.exists && adStatsDoc.data().adViewsByDate || {})[dateKey]) || 0;
    const unlocks = topics.reduce((sum, t) => sum + (t.dailyUnlockDate === dateKey ? (Number(t.dailyUnlockCount) || 0) : 0), 0);

    const cpm = await getAdCpm();
    const estRevenue = (adViews / 1000) * cpm;

    const text =
      `📊 DAILY SUMMARY — ${dateKey}\n\n` +
      `👥 নতুন User: ${newUsers}\n` +
      `📺 Ad Views: ${adViews.toLocaleString('en-US')}\n` +
      `🔓 Topic Unlock: ${unlocks.toLocaleString('en-US')}\n` +
      `💵 আনুমানিক আয়: ${estRevenue.toFixed(2)} ৳`;

    await safeSendMessage(ADMIN_ID, text, {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('📊 Full Analytics', 'adm_dashboard')]]).reply_markup
    });
    console.log(`📊 Daily summary sent for ${dateKey}`);
  } catch (error) {
    console.error('❌ Daily summary cron error:', error.message);
  }
}, { timezone: 'Asia/Dhaka' });

// =============================================
// 🧹 CLEANUP CRON (light: every 2 minutes)
// =============================================

// 🐛 FIX (repeat-unlock bug): a topic's ad-watch progress (adProgress[topicId])
// used to stay pinned at `adsRequired` forever once a user first unlocked it —
// cleanup only ever cleared `unlockedTopics`/`topicUnlockTime`, never the
// progress counter. So the very next time that user "unlocked" the same
// topic (even after the 30-min access window had fully expired), the
// transaction in /api/ad-complete saw progress already sitting at
// `adsRequired`, and unlocked them again after just the ONE ad they'd just
// watched to make that call — instead of requiring the full ad count again.
// Now, whenever cleanup expires a topic out of unlockedTopics, we also wipe
// its adProgress entry so a future watch has to earn the full unlock again.
// Deletes every due video of ONE user, then updates that user's document in a
// transaction that re-reads the fresh data — so a video delivered while this
// was running is never overwritten/forgotten.
async function cleanupOneUser(docRef, data, now) {
  const sentMessages = Array.isArray(data.sentMessages) ? data.sentMessages : [];
  const finished = new Set(); // deleted, or can never be deleted → safe to forget
  let deleted = 0;
  let retryNeeded = false;

  for (const msg of sentMessages) {
    if (!msg || !msg.chatId || !msg.messageId) continue; // unusable entry, dropped below
    if (dueAtOf(msg) > now) continue; // still inside its 30 minutes
    const result = await safeDeleteMessage(msg.chatId, msg.messageId);
    if (result.ok) { deleted++; finished.add(msgKey(msg)); }
    else if (result.retryable) retryNeeded = true; // temporary failure → keep it, try again soon
    else finished.add(msgKey(msg));                // already gone / can't be deleted → nothing to retry
  }

  let updated = false;
  await db.runTransaction(async tx => {
    const fresh = await tx.get(docRef);
    if (!fresh.exists) return;
    const d = fresh.data() || {};

    const remaining = (Array.isArray(d.sentMessages) ? d.sentMessages : [])
      .filter(m => m && m.chatId && m.messageId && !finished.has(msgKey(m)));

    const unlockedTopics = Array.isArray(d.unlockedTopics) ? d.unlockedTopics : [];
    const topicUnlockTime = d.topicUnlockTime || {};
    const stillUnlocked = unlockedTopics.filter(topicId => {
      const time = Number(topicUnlockTime[topicId]) || 0;
      return time && (now - time) < THIRTY_MINUTES;
    });
    const expiredTopics = unlockedTopics.filter(t => !stillUnlocked.includes(t));

    const updates = {
      sentMessages: remaining,
      cleanupDueAt: retryNeeded ? now + 2 * 60 * 1000 : getCleanupDueAt(remaining)
    };
    if (expiredTopics.length) {
      updates.unlockedTopics = stillUnlocked;
      // 🐛 FIX: set(..., { merge: true }) MERGES nested maps, so leaving a key
      // out of the map does NOT remove it from Firestore — the expired
      // topic's unlock time and (more importantly) its ad progress stayed
      // pinned at "all ads watched", which is exactly what let a topic be
      // re-unlocked with a single ad. Deleting keys needs FieldValue.delete().
      updates.topicUnlockTime = {};
      updates.adProgress = {};
      for (const t of expiredTopics) {
        updates.topicUnlockTime[t] = admin.firestore.FieldValue.delete();
        updates.adProgress[t] = admin.firestore.FieldValue.delete();
      }
    }
    tx.set(docRef, updates, { merge: true });
    updated = true;
  });

  return { deleted, updated };
}

async function runCleanupPass() {
  if (cleanupRunning) {
    console.log('⏭️ Cleanup already running; skipping this cycle.');
    return;
  }
  cleanupRunning = true;
  try {
    const now = Date.now();
    console.log('🔄 Running cleanup check...');

    let totalDeleted = 0;
    let totalUpdated = 0;
    let totalDue = 0;
    // Loop in pages: if the server was asleep/down for a while (a redeploy, or
    // Render's free tier spinning the dyno down), many users pile up past
    // their cleanupDueAt. Keep paging until we're caught up, with a sane
    // upper bound so one run can't loop forever.
    for (let page = 0; page < 25; page++) {
      const snapshot = await db.collection('users')
        .where('cleanupDueAt', '<=', now)
        .limit(200)
        .get();

      if (snapshot.empty) break;
      totalDue += snapshot.size;

      for (const doc of snapshot.docs) {
        try {
          const r = await cleanupOneUser(doc.ref, doc.data(), now);
          totalDeleted += r.deleted;
          if (r.updated) totalUpdated++;
        } catch (userError) {
          console.error(`❌ Cleanup failed for user ${doc.id}:`, userError.message);
        }
      }

      if (snapshot.size < 200) break; // caught up
    }

    if (totalDeleted > 0 || totalUpdated > 0 || totalDue > 0) {
      console.log(`✅ Cleanup: ${totalDeleted} videos deleted, ${totalUpdated} users processed, ${totalDue} due users`);
    }
  } catch (error) {
    console.error('❌ Cron error:', error);
  } finally {
    cleanupRunning = false;
  }
}

// Every 20 minutes (was every 5, then every 2 before that) — this cron's own
// query (`.where('cleanupDueAt','<=',now)`) costs at least 1 Firestore read
// on every single run whether or not anything is actually due, so widening
// the interval directly cuts that recurring cost (288/day at 5min → 72/day
// at 20min). Safe to widen further: the 30-minute unlock-access window is
// already enforced LIVE, per-request, in /api/user-unlocked (it filters by
// elapsed time on every call) AND self-heals in /api/ad-complete's own
// transaction (see hasStaleData above) — so a user's app never shows an
// expired unlock as active even if this cron hasn't caught up yet. This cron
// is now genuinely just background housekeeping: deleting the old Telegram
// video messages a bit later, and clearing stale adProgress a bit later.
// Neither of those being ~15-20 minutes late has any user-visible effect.
// 🐛 FIX (videos stayed in users' chats for far longer than 30 minutes): this
// used to run every 20 minutes, so a video could live up to ~50 minutes. Back
// to every 5 minutes (~288 tiny reads/day when nothing is due) so videos are
// removed within ~5 minutes of their 30-minute mark.
cron.schedule('*/5 * * * *', () => {
  if (!botLaunched) return; // not the live poller in this overlap window — skip
  runCleanupPass().catch(e => console.error('❌ Cleanup pass error:', e.message));
});

// =============================================
// 🛠️ One-time cleanup migration (only once)
// =============================================

async function migrateCleanupSchedule() {
  const markerRef = db.collection('system').doc('cleanup');
  try {
    const marker = await markerRef.get();
    // 🐛 FIX: bumped to v4 so the schedule is rebuilt ONE more time. Users whose
    // `cleanupDueAt` was missing/null (only possible to miss because the startup
    // tasks below never ran — see markBotLaunched) were invisible to the
    // cleanup query, so their old videos were never deleted. This rebuild finds
    // every user who still has tracked videos and marks them due, so the very
    // next cleanup pass deletes all the old ones too.
    if (marker.exists && Number(marker.data().version) >= 4) {
      console.log('⏭️ Cleanup migration already done.');
      return;
    }

    // v3: rebuild cleanupDueAt for EVERY user, not only the first 500 users.
    // This also picks up users/messages created before cleanupDueAt existed.
    console.log('🛠️ Rebuilding video cleanup schedule for all users...');
    let lastDoc = null;
    let changed = 0;
    let scanned = 0;

    for (let page = 0; page < 100; page++) { // up to 50,000 users per migration
      let q = db.collection('users')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(500);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      lastDoc = snap.docs[snap.docs.length - 1];
      scanned += snap.size;

      let batch = db.batch();
      let batchCount = 0;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const sentMessages = Array.isArray(data.sentMessages) ? data.sentMessages : [];
        const dueAt = getCleanupDueAt(sentMessages);
        const oldDue = Number(data.cleanupDueAt) || null;
        const newDue = dueAt || null;
        if (oldDue !== newDue) {
          batch.set(doc.ref, { cleanupDueAt: newDue }, { merge: true });
          batchCount++;
          changed++;
        }
        if (batchCount >= 450) {
          await batch.commit();
          batch = db.batch();
          batchCount = 0;
        }
      }
      if (batchCount > 0) await batch.commit();
      if (snap.size < 500) break;
    }

    await markerRef.set({
      version: 4,
      updatedAt: Date.now(),
      scannedUsers: scanned,
      changedUsers: changed
    }, { merge: true });
    console.log(`✅ Cleanup migration complete: ${changed} users scheduled (${scanned} scanned).`);
  } catch (error) {
    console.error('❌ Cleanup migration error:', error.message);
  }
}

// =============================================
// 🛠️ One-time fix for stale ad-progress (only once)
// =============================================
//
// 🐛 FIX (repeat-unlock bug, retroactive part): the code used to never reset
// adProgress[topicId] once a topic's unlock expired, only unlockedTopics /
// topicUnlockTime got cleared. The new cleanup pass now resets adProgress
// the moment a topic actually expires OUT of unlockedTopics — but for every
// topic that had ALREADY expired under the old code (before this fix was
// deployed), that transition already happened in the past, so the new reset
// logic has no future trigger to ever clean those up. Their adProgress entry
// is left permanently sitting at `adsRequired`, and the very next watch
// re-unlocks them with just one ad, forever. This is a one-time sweep that
// finds and clears exactly those orphaned entries — any adProgress[topicId]
// that's already maxed out (>= that topic's adsRequired) for a topic the
// user does NOT currently have in unlockedTopics — without touching
// legitimate in-progress counts (someone mid-way through watching ads for a
// topic they haven't unlocked yet is left completely alone).
async function migrateStaleAdProgress() {
  const markerRef = db.collection('system').doc('cleanup');
  try {
    const marker = await markerRef.get();
    // v2: the first version of this sweep wrote with set(..., {merge:true}), which
    // can't delete map keys — so it silently cleared nothing. Re-run once with
    // real FieldValue.delete() deletes.
    if (marker.exists && Number(marker.data().adProgressVersion) >= 2) {
      console.log('⏭️ Stale ad-progress migration already done.');
      return;
    }
    console.log('🛠️ Clearing stale ad-progress left over from before the repeat-unlock fix...');

    const topicsSnap = await db.collection('topics').get();
    const requiredById = new Map();
    topicsSnap.docs.forEach(d => requiredById.set(d.id, Math.max(1, Number(d.data().adsRequired) || 1)));

    let changed = 0;
    let lastDoc = null;
    for (let page = 0; page < 40; page++) { // cap: up to 40 * 500 = 20,000 users
      let q = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(500);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;
      lastDoc = snap.docs[snap.docs.length - 1];

      let batch = db.batch();
      let batchCount = 0;
      for (const doc of snap.docs) {
        const data = doc.data();
        const progress = data.adProgress;
        if (!progress || typeof progress !== 'object') continue;
        const unlockedTopics = Array.isArray(data.unlockedTopics) ? data.unlockedTopics : [];
        const deletions = {};
        let touched = false;
        for (const topicId of Object.keys(progress)) {
          if (unlockedTopics.includes(topicId)) continue; // currently active — leave it alone
          const required = requiredById.get(topicId) || 1;
          if ((Number(progress[topicId]) || 0) >= required) {
            deletions[topicId] = admin.firestore.FieldValue.delete();
            touched = true;
          }
        }
        if (touched) {
          batch.set(doc.ref, { adProgress: deletions }, { merge: true });
          batchCount++;
          changed++;
        }
      }
      if (batchCount > 0) await batch.commit();
      if (snap.size < 500) break;
    }

    await markerRef.set({ adProgressVersion: 2, adProgressMigratedAt: Date.now() }, { merge: true });
    console.log(`✅ Stale ad-progress cleared for ${changed} users.`);
  } catch (error) {
    console.error('❌ Stale ad-progress migration error:', error.message);
  }
}

// =============================================
// 🚀 LAUNCH (Render Free-এর জন্য safe config)
// =============================================

// ⚠️ গুরুত্বপূর্ণ: একই BOT_TOKEN দিয়ে একাধিক instance চললে polling conflict হয়।
// এই warning log করি যাতে DEBUG করা সহজ হয়।
console.log('🤖 Starting bot polling...');

// Run migrations in order, then immediately process every due video. This is
// what catches videos that became due while the server was down/redeploying.
//
// 🐛 FIX (real duplicate-read multiplier during Render restart overlaps):
// this used to fire from a BLIND setTimeout(..., 8000) that ran no matter
// what — including on an instance whose bot.launch() had just failed with a
// "409: Conflict" (i.e. this process LOST the race and another instance is
// already the live poller). A losing instance still isn't actually doing
// anything useful, but it was running the full migration checks + a whole
// Firestore cleanup pass anyway — meaning every overlap window (a redeploy,
// or the free-tier dyno waking up) doubled that cost for zero benefit, since
// the winning instance was already doing the exact same work. Now this only
// ever runs on the instance that actually confirmed it's the live poller.
let startupTasksStarted = false;
function runStartupTasksOnce() {
  if (startupTasksStarted || !botLaunched) return;
  startupTasksStarted = true;
  console.log('🧹 Running startup cleanup tasks...');
  migrateCleanupSchedule()
    .then(() => migrateStaleAdProgress())
    .then(() => runCleanupPass())
    .catch(e => console.error('❌ Startup cleanup/migration error:', e.message));
}

// 🐛 FIX (THE reason cleanup logs disappeared and videos were never deleted):
// `botLaunched` used to be set ONLY inside `bot.launch().then(...)`. In
// Telegraf 4.x, the promise returned by bot.launch() does NOT resolve when
// polling starts — it stays pending for as long as the bot is running. So
// `.then()` never fired, `botLaunched` stayed false forever, and every cron
// guarded by `if (!botLaunched) return;` (video cleanup, scheduled posts,
// the daily summary) plus the startup cleanup tasks silently never ran.
// It is now set from Telegraf's `onLaunch` callback (fires as soon as polling
// starts), from the promise if it does resolve, and — as a last resort — by a
// 15-second fallback when no launch error occurred.
let launchFailed = false;
function markBotLaunched(source) {
  if (botLaunched) return;
  botLaunched = true;
  console.log(`🤖 Bot started successfully (polling mode) [${source}]`);
  setTimeout(runStartupTasksOnce, 3000);
}

const BOT_LAUNCH_OPTIONS = {
  // পুরনো pending update গুলো skip করি, যাতে restart-এর সময় ঝুলে না যায়
  dropPendingUpdates: true,
  // নির্দিষ্ট update type subscribe করি — এতে কম load
  allowedUpdates: [
    'message',
    'callback_query',
    'inline_query',
    'chosen_inline_result',
    'edited_message'
  ]
};

function launchBot(isRetry) {
  launchFailed = false;
  bot.launch(BOT_LAUNCH_OPTIONS, () => markBotLaunched('onLaunch'))
    .then(() => markBotLaunched('promise resolved'))
    .catch(err => {
      launchFailed = true;
      console.error(isRetry ? `❌ Retry failed: ${err.message}` : `❌ Bot start error: ${err.message}`);
      if (!isRetry) {
        // Polling failed হলে 5 সেকেন্ড পরে retry
        setTimeout(() => {
          console.log('🔄 Retrying bot launch...');
          launchBot(true);
        }, 5000);
      }
    });
  // Last resort: no launch error within 15s → polling is running.
  setTimeout(() => {
    if (!botLaunched && !launchFailed) markBotLaunched('fallback timer');
  }, 15000);
}
launchBot(false);

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
  // Warm the topics cache immediately so the very first user of a fresh
  // deploy/restart doesn't have to wait on a cold Firestore read.
  getTopicsCached().catch(() => {});
});

// Graceful shutdown — Render restart-এ ঝুলে না যায়
async function gracefulExit(signal) {
  console.log(`🛑 ${signal} received, stopping bot...`);
  try { bot.stop(signal); } catch (e) {}
  // Let videos that are mid-delivery finish being sent AND tracked for the
  // 30-minute deletion before the process goes away (max 10 seconds).
  const startedAt = Date.now();
  while (inflightDeliveries > 0 && (Date.now() - startedAt) < 10000) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Persist non-critical analytics before exit, without delaying delivery
  // shutdown indefinitely.
  try { await Promise.race([
    flushAdViews(),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]); } catch (_) {}
  process.exit(0);
}
process.once('SIGINT', () => { gracefulExit('SIGINT'); });
process.once('SIGTERM', () => { gracefulExit('SIGTERM'); });
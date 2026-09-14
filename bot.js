const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bot = new Telegraf(process.env.BOT_TOKEN);

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
    return true;
  } catch (err) {
    if (isBlockedError(err)) return false;
    // "message to delete not found" বা "message can't be deleted" → ignore
    if (/message to delete not found|message can't be deleted|MESSAGE_ID_INVALID/i.test(err.message || '')) {
      return false;
    }
    console.warn(`⚠️ deleteMessage failed for ${chatId}/${messageId}: ${err.message}`);
    return false;
  }
}

// =============================================
// ⚡ PERFORMANCE / CACHE
// =============================================

const THIRTY_MINUTES = 30 * 60 * 1000;
const TOPICS_CACHE_TTL = 120 * 1000;
const FILE_LINK_CACHE_TTL = 45 * 60 * 1000;
const DAILY_LIMIT_CACHE_TTL = 60 * 1000;
const DEFAULT_DAILY_AD_LIMIT = 15;
let topicsCache = null;
let topicsCacheAt = 0;
let topicsRefreshPromise = null;
const SINGLE_TOPIC_CACHE_TTL = 60 * 1000;
let singleTopicCache = new Map();
let singleTopicRefresh = new Map();
let fileLinkCache = new Map();
let dailyLimitCache = DEFAULT_DAILY_AD_LIMIT;
let dailyLimitCacheAt = 0;
let cleanupRunning = false;
let adminStatsCache = null;
let adminStatsCacheAt = 0;
let adminUserCursor = null;
let adminUserPage = 0;

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
      unlockCount: Number(data.unlockCount) || 0
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

function getCleanupDueAt(sentMessages) {
  const times = (Array.isArray(sentMessages) ? sentMessages : [])
    .map(m => Number(m && m.sentAt) || 0)
    .filter(Boolean)
    .map(sentAt => sentAt + THIRTY_MINUTES);
  return times.length ? Math.min(...times) : null;
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
let adminVideoData = {};

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

  return result;
}

async function addChannelRecord(data) {
  const ref = await db.collection('channels').add({
    name: data.name, channelId: data.channelId, link: data.link || '', active: true, createdAt: Date.now(), updatedAt: Date.now()
  });
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
    [Markup.button.callback('📈 Analytics', 'adm_analytics'), Markup.button.callback('👥 Users', 'adm_users')],
    [Markup.button.callback('📺 Ads', 'adm_ads'), Markup.button.callback('📣 Broadcast', 'adm_broadcast')],
    [Markup.button.callback('🔘 Post Buttons', 'adm_buttons'), Markup.button.callback('⚙️ Settings', 'adm_settings')]
  ]);
  if (edit && ctx.callbackQuery?.message) {
    return ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
  }
  return ctx.reply(text, keyboard);
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
    return forwarded.photo[forwarded.photo.length - 1].file_id;
  } catch (error) {
    console.error('Error forwarding photo:', error);
    throw error;
  }
}

function getDhakaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
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
  const userId = ctx.from.id;
  const video = ctx.message.video;
  const fileId = video.file_id;

  if (broadcastData[userId] && broadcastData[userId].step === 'content') {
    broadcastData[userId].type = 'video';
    broadcastData[userId].file = fileId;
    broadcastData[userId].step = 'message';
    await ctx.reply('📝 এবার ব্রডকাস্টের ক্যাপশন/মেসেজ লিখুন (রেফার লিংক সহ):');
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
  const userId = ctx.from.id;
  const document = ctx.message.document;
  if (!document.mime_type || !document.mime_type.startsWith('video/')) {
    return ctx.reply('❌ দয়া করে একটি ভিডিও ফাইল পাঠান।');
  }
  const fileId = document.file_id;

  // /post preview: NEVER send preview documents to STORAGE_CHANNEL.
  // Telegram may deliver a video uploaded as a file/document here instead of as a video.
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
    if (addVideoData[userId]) {
      const data = addVideoData[userId];
      if (data.step === 'video') {
        data.videoId = storedFileId;
        data.step = 'title';
        await ctx.reply('📝 এই ভিডিওর জন্য একটি টাইটেল দিন:');
      }
      return;
    }
  } catch (error) {
    await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
  }
});

bot.command('done', async (ctx) => {
  const userId = ctx.from.id;
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
  } catch (e) {
    console.error('❌ Could not record channel post:', e.message);
  }
}

async function getRepostPostsForChannel(channelId) {
  const wanted = String(channelId || '');
  const map = new Map();

  // New global records: caption + exact message metadata are available.
  try {
    const snap = await db.collection('channelPosts').orderBy('postedAt', 'desc').limit(100).get();
    snap.docs.forEach(doc => {
      const d = doc.data() || {};
      if (String(d.channelId) !== wanted) return;
      const key = `${d.channelId}:${d.messageId}`;
      if (!map.has(key)) map.set(key, { id: doc.id, ...d, legacy: false });
    });
  } catch (e) {
    console.warn('⚠️ channelPosts index unavailable:', e.message);
  }

  // Legacy topic-level records: useful for posts saved by older versions.
  // Old records may not have the original caption, so title is used as display fallback.
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

  return Array.from(map.values())
    .sort((a,b) => (Number(b.postedAt)||0) - (Number(a.postedAt)||0))
    .slice(0, 50);
}

bot.action('post_confirm', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const userId = ctx.from.id;
  const state = postData[userId];

  if (!state || state.step !== 'confirm' || !state.fileId || !state.topicId) {
    return ctx.answerCbQuery('❌ Post data পাওয়া যায়নি। /post দিয়ে আবার শুরু করুন');
  }
  const postingChannel = (state.channels && state.channels[0]) || POST_CHANNEL;
  if (!postingChannel) return ctx.answerCbQuery('❌ Posting Channel সেট করা নেই');

  const helpLink = await getHelpAdminLink();
  if (!helpLink) return ctx.answerCbQuery('❌ /setlink দিয়ে Help Admin link সেট করুন');

  await ctx.answerCbQuery('Posting...');
  try {
    const keyboard = buildPostKeyboard(state.topicId, helpLink);
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
    delete postData[userId];
    await ctx.reply(
      `✅ Posting Channel-এ Post হয়ে গেছে।\n\n` +
      `🆔 Video/Topic ID: ${state.topicId}\n` +
      `📌 Channel Message ID: ${sent.message_id}`
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

    let message = '📋 সব টপিক:\n\n';
    topics.forEach((data) => {
      const doc = { id: data.id };
      message += `📌 ${data.title || 'নামবিহীন'}\n`;
      message += `   🆔 <code>${doc.id}</code>\n`;
      message += `   📹 ${data.videoCount || 0}টি ভিডিও\n`;
      message += `   👁️ ${Number(data.unlockCount || data.unlocks || data.views) || 0} ভিউ\n`;
      message += `   🔢 ${data.adsRequired || 0}টি অ্যাড\n\n`;
    });
    await ctx.reply(message, { parse_mode: 'HTML' });
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
      [Markup.button.callback('🆔 Video IDs', 'adm_video_ids')],
      [Markup.button.callback('✏️ Rename / Title', 'adm_video_rename')],
      [Markup.button.callback('🖼️ Thumbnail Edit', 'adm_video_thumb')],
      [Markup.button.callback('🗑️ Delete Video', 'adm_video_delete')],
      [Markup.button.callback('⬅️ Back', 'adm_home')]
    ]));
  }
  if (action === 'add_video') { startAddVideoWorkflow(ctx.from.id); return ctx.reply('📹 ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)।\n\n⚠️ এটি Channel Post নয়। আগে ভিডিও, তারপর Title → Thumbnail → Ads Count দিন।'); }
  if (action === 'add_topic') { startAddTopicWorkflow(ctx.from.id); return ctx.reply('📹 প্রথম ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)।\n\n⚠️ এটি Channel Post নয়। ভিডিওগুলো শেষে /done দিন, তারপর Title → Thumbnail → Ads Count।'); }
  if (action === 'list') {
    const topics = await getTopicsCached();
    if (!topics.length) return ctx.reply('📭 এখনো কোনো Video/Topic নেই।');
    const lines = topics.map((t, i) => {
      const count = Array.isArray(t.videos) ? t.videos.length : (t.videoId ? 1 : 0);
      return `${i + 1}. ${String(t.title || 'নামবিহীন')}\n🆔 ${t.id}\n📹 Videos: ${count} | 🎯 Ads: ${Number(t.adsRequired || 1)}`;
    });
    const text = `📋 ALL VIDEOS / TOPICS\n\n${lines.join('\n\n')}`;
    return ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm_videos')]]));
  }
  if (action === 'video_ids') {
    const topics = await getTopicsCached();
    if (!topics.length) return ctx.reply('📭 কোনো Video/Topic নেই।');
    const rows = [];
    topics.forEach((t, i) => {
      rows.push([{ text: `${i + 1}. ${String(t.title || 'নামবিহীন').slice(0, 35)}`, copy_text: { text: String(t.id) } }]);
    });
    rows.push([Markup.button.callback('⬅️ Back', 'adm_videos')]);
    return ctx.reply('🆔 VIDEO/TOPIC IDS\n\nনিচের ID button-এ click করলে ID copy হবে।', Markup.inlineKeyboard(rows));
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
    const rows = channels.map(ch => [Markup.button.callback(`${ch.active === false ? '🔴' : '🟢'} ${String(ch.name||ch.channelId).slice(0,35)}`, `ach_view:${ch.id || ch.channelId}`)]);
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
    const channels = await getChannels();
    const rows = channels.filter(c=>c.active!==false).map(ch => [Markup.button.callback(`📢 ${String(ch.name||ch.channelId).slice(0,35)}`, `apostch:${ch.id || ch.channelId}`)]);
    if (!rows.length && POST_CHANNEL) rows.push([Markup.button.callback('📢 Posting Channel', `apostch:${POST_CHANNEL}`)]);
    rows.push([Markup.button.callback('⬅️ Back', 'adm_create_post')]);
    return ctx.editMessageText('➕ CREATE NEW POST\n\nকোন Channel-এ post করবেন?', Markup.inlineKeyboard(rows));
  }
  if (action === 'repost') {
    clearAdminWorkflow(ctx.from.id);
    repostData[ctx.from.id] = { step: 'channel' };
    const channels = await getChannels();
    const rows = channels.filter(c=>c.active!==false).map((ch, i) => [Markup.button.callback(`📢 ${String(ch.name||ch.channelId).slice(0,35)}`, `repost_channel:${i}`)]);
    if (!rows.length && POST_CHANNEL) rows.push([Markup.button.callback('📢 Posting Channel', `repost_channel:default`)]);
    rows.push([Markup.button.callback('⬅️ Back', 'adm_create_post')]);
    return ctx.editMessageText('📢 REPOST POST\n\nকোন Channel-এর পুরোনো Post repost করতে চান?', Markup.inlineKeyboard(rows));
  }
  if (action === 'analytics' || action === 'dashboard') {
    const counts = await getUserCountsCached(); const topics = await getTopicsCached();
    const totalViews = topics.reduce((n,t)=>n+(Number(t.unlockCount)||0),0); const today=getDhakaDateKey(); const todayViews=topics.reduce((n,t)=>n+(t.dailyUnlockDate===today?(Number(t.dailyUnlockCount)||0):0),0);
    return ctx.editMessageText(`📊 ${action==='dashboard'?'DASHBOARD':'ANALYTICS'}\n\n👥 Users: ${counts.totalUsers}\n🎬 Videos/Topics: ${topics.length}\n👁️ Total Views: ${totalViews.toLocaleString('en-US')}\n📅 Today: ${todayViews.toLocaleString('en-US')}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back','adm_home')]]));
  }
  if (action === 'users') return ctx.reply('👥 User Management\n\nপুরোনো /user command-এর একই user data ব্যবহার করা হবে।', Markup.inlineKeyboard([[Markup.button.callback('📋 User List','adm_userlist')],[Markup.button.callback('⬅️ Back','adm_home')]]));
  if (action === 'userlist') { adminUserCursor=null; adminUserPage=1; const snap=await db.collection('users').orderBy('createdAt','desc').limit(25).get(); if(snap.empty) return ctx.reply('📭 কোনো user নেই।'); adminUserCursor=snap.docs[snap.docs.length-1]; return sendUserPage(ctx,snap.docs,1); }
  if (action === 'ads') return ctx.reply('📺 Ads Management', Markup.inlineKeyboard([[Markup.button.callback('🎯 Set Video Ads','adm_set_ads')],[Markup.button.callback('🎯 Daily Limit','adm_daily_limit')],[Markup.button.callback('⬅️ Back','adm_home')]]));
  if (action === 'set_ads') { updateAdsData[ctx.from.id]={step:'topicId'}; return ctx.reply('🎯 Video/Topic ID পাঠান:'); }
  if (action === 'daily_limit') { const current=await getDailyAdLimit(); updateAdsData[ctx.from.id]={step:'dailyLimit'}; return ctx.reply(`📊 বর্তমান Daily Ad Limit: ${current}টি\n\nনতুন limit লিখুন:`); }
  if (action === 'broadcast') { broadcastData[ctx.from.id]={step:'content'}; return ctx.reply('📣 Broadcast content পাঠান।\n🖼️ Photo / 🎬 Video / ✏️ Text'); }
  if (action === 'settings') return ctx.editMessageText('⚙️ SETTINGS', Markup.inlineKeyboard([[Markup.button.callback('🎯 Daily Ad Limit','adm_daily_limit')],[Markup.button.callback('⬅️ Back','adm_home')]]));
  if (action === 'buttons') {
    const bs=await getPostButtons();
    const rows=bs.map((b,i)=>[Markup.button.callback(`${i+1}. ${String(b.name).slice(0,25)}`,'ab_edit:'+i),Markup.button.callback('🗑️','ab_del:'+i)]);
    rows.push([Markup.button.callback('➕ Add Button','ab_add')]);
  rows.push([Markup.button.callback('⬅️ Back','adm_home')]);
    return ctx.editMessageText('🔘 POST BUTTON MANAGER\n\nএই saved buttons নতুন post-এ automatic থাকবে।',Markup.inlineKeyboard(rows));
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
  return ctx.editMessageText(`🎬 VIDEO DETAILS\n\n📌 ${t.title||'নামবিহীন'}\n🆔 ${id}\n📹 Videos: ${t.videoCount||0}\n🎯 Ads: ${t.adsRequired||1}\n👁️ Views: ${Number(t.unlockCount||0)}`,Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Rename','av_rename:'+id),Markup.button.callback('🖼️ Thumbnail','av_thumb:'+id)],
    [Markup.button.callback('🎯 Ads','av_ads:'+id),Markup.button.callback('📤 Post','apost_topic:'+id)],
    [Markup.button.callback('🗑️ Delete','av_delete:'+id)],
    [Markup.button.callback('⬅️ Back','adm_list')]
  ]));
});
bot.action(/^av_rename:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); renameData[ctx.from.id]={step:'title',topicId:ctx.match[1]}; const d=await db.collection('topics').doc(ctx.match[1]).get(); return ctx.reply(`✏️ Current: ${d.exists?(d.data().title||'নামবিহীন'):'নেই'}\n\nনতুন Title পাঠান:`); });
bot.action(/^av_thumb:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); thumbnailData[ctx.from.id]={step:'photo',topicId:ctx.match[1]}; return ctx.reply('🖼️ নতুন Thumbnail Photo পাঠান:'); });
bot.action(/^av_ads:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); updateAdsData[ctx.from.id]={step:'count',topicId:ctx.match[1]}; const d=await db.collection('topics').doc(ctx.match[1]).get(); return ctx.reply(`🎯 Current Ads: ${d.exists?(d.data().adsRequired||1):1}\n\nনতুন Ads count পাঠান:`); });
bot.action(/^av_delete:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await db.collection('topics').doc(ctx.match[1]).delete(); invalidateTopicsCache(); await ctx.answerCbQuery('Deleted'); return ctx.reply('✅ Video/Topic delete হয়েছে।'); });
bot.action(/^apost_topic:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const channels=await getChannels(); const rows=channels.filter(c=>c.active!==false).map(c=>[Markup.button.callback(`📢 ${String(c.name||c.channelId).slice(0,35)}`,`apostch_topic:${c.id||c.channelId}:${ctx.match[1]}`)]); if(!rows.length&&POST_CHANNEL)rows.push([Markup.button.callback('📢 Default Channel',`apostch_topic:${POST_CHANNEL}:${ctx.match[1]}`)]); rows.push([Markup.button.callback('⬅️ Back','aview:'+ctx.match[1])]); await ctx.answerCbQuery(); return ctx.editMessageText('📤 SELECT CHANNEL FOR THIS VIDEO',Markup.inlineKeyboard(rows)); });
bot.action(/^apostch_topic:([^:]+):(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); delete adminVideoData[ctx.from.id]; let ch=ctx.match[1]; const doc=await db.collection('channels').doc(ch).get(); if(doc.exists)ch=doc.data().channelId; const topicId=ctx.match[2]; const td=await db.collection('topics').doc(topicId).get(); if(!td.exists)return ctx.answerCbQuery('❌ Video নেই'); const t=td.data(); const fileId=(t.videos&&t.videos[0])||t.videoId||''; if(!fileId)return ctx.answerCbQuery('❌ Video file পাওয়া যায়নি'); const kb=await buildConfiguredPostKeyboard(topicId); await ctx.answerCbQuery('Posting...'); try{const sent=await bot.telegram.sendVideo(ch,fileId,{caption:t.title||'',reply_markup:kb.reply_markup}); await recordTopicPost(topicId,ch,sent.message_id,'video',t.title||'',t.title||''); return ctx.reply(`✅ Post হয়েছে\n📢 ${ch}\n🆔 Message ID: ${sent.message_id}`);}catch(e){return ctx.reply('❌ Channel-এ post করা যায়নি: '+e.message);} });

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

  repostData[ctx.from.id] = { step: 'post', channelId, posts };
  const rows = posts.map((p, i) => {
    const caption = String(p.caption || p.title || '(Caption নেই)').replace(/\s+/g, ' ').trim();
    const media = p.type === 'photo' ? '🖼️' : '🎬';
    const date = p.postedAt ? new Date(Number(p.postedAt)).toLocaleDateString('en-GB') : '';
    return [Markup.button.callback(`${media} ${caption.slice(0, 48)}${date ? ` • ${date}` : ''}`, `repost_post:${i}`)];
  });
  rows.push([Markup.button.callback('⬅️ Channel Select', 'adm_repost')]);
  return ctx.editMessageText(`📢 ${channel.name || channelId}\n\nযে Caption-এর Post Repost করতে চান সেটিতে চাপুন:`, Markup.inlineKeyboard(rows));
});

bot.action(/^repost_post:(\d+)$/, async ctx => {
  if (!adminOnly(ctx)) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const state = repostData[ctx.from.id];
  const index = Number(ctx.match[1]);
  if (!state || state.step !== 'post' || !state.posts || !state.posts[index]) {
    return ctx.answerCbQuery('❌ Repost data পাওয়া যায়নি');
  }
  const rec = state.posts[index];
  await ctx.answerCbQuery('Reposting...');

  try {
    const copied = await bot.telegram.copyMessage(rec.channelId, rec.channelId, Number(rec.messageId));
    await recordTopicPost(rec.topicId || 'repost', rec.channelId, copied.message_id, rec.type || 'video', rec.caption || '', rec.title || '');
    delete repostData[ctx.from.id];
    return ctx.reply(`✅ Post আবার Repost হয়েছে।\n\n📢 ${rec.channelId}\n📝 ${String(rec.caption || rec.title || '(Caption নেই)').slice(0, 300)}\n🆔 নতুন Message ID: ${copied.message_id}`);
  } catch (e) {
    console.error('❌ Repost error:', e.message);
    return ctx.reply(`❌ Repost করা যায়নি।\n\n📢 ${rec.channelId}\n🆔 Message ID: ${rec.messageId}\n\n${e.message}`);
  }
});

// Channel manager actions
bot.action('ach_add', async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); postData[ctx.from.id]={step:'channel_name'}; return ctx.reply('📢 নতুন Channel-এর নাম লিখুন:'); });
bot.action(/^ach_view:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const id=ctx.match[1]; await ctx.answerCbQuery(); const channels=await getChannels(); const c=channels.find(x=>x.id===id || x.channelId===id); if(!c)return ctx.reply('❌ Channel পাওয়া যায়নি।'); return ctx.reply(`📢 ${c.name||'Posting Channel'}\n🆔 ${c.channelId}\n🔗 ${c.link||'(none)'}\n🟢 Active: ${c.active!==false}` ,Markup.inlineKeyboard([[Markup.button.callback('📤 Post Here','apostch:'+id),Markup.button.callback(c.active===false?'🟢 Enable':'🔴 Disable','ach_toggle:'+id)],[Markup.button.callback('✏️ Rename / Edit','ach_edit:'+id),Markup.button.callback('🗑️ Delete','ach_del:'+id)],[Markup.button.callback('⬅️ Back','adm_channels')]])); });
bot.action(/^ach_edit:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const id=ctx.match[1]; const channels=await getChannels(); const c=channels.find(x=>x.id===id || x.channelId===id); if(!c)return ctx.answerCbQuery('❌ নেই'); await ctx.answerCbQuery(); const docId=id.startsWith('env_') ? id : id; if(id.startsWith('env_')) { await db.collection('channels').doc(docId).set({name:c.name||'Posting Channel',channelId:c.channelId,link:c.link||'',active:c.active!==false,createdAt:Date.now(),updatedAt:Date.now(),legacyOverride:true},{merge:true}); } postData[ctx.from.id]={step:'channel_edit_name',channelDocId:docId,channel:c}; return ctx.reply(`✏️ Current Channel Name: ${c.name||''}\n\nনতুন Channel Name পাঠান:`); });

bot.action(/^ach_toggle:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const id=ctx.match[1]; const ref=db.collection('channels').doc(id); const d=await ref.get(); if(!d.exists)return ctx.answerCbQuery('❌ নেই'); await ref.update({active:d.data().active===false,updatedAt:Date.now()}); await ctx.answerCbQuery('Updated'); return ctx.reply('✅ Channel status updated.'); });
bot.action(/^ach_del:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await db.collection('channels').doc(ctx.match[1]).delete(); await ctx.answerCbQuery('Deleted'); return sendAdminPanel(ctx); });

// Admin posting: select channel then reuse the existing /post media/topic/caption flow
bot.action(/^apostch:(.+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); delete addVideoData[ctx.from.id]; delete addTopicData[ctx.from.id]; delete broadcastData[ctx.from.id]; const key=ctx.match[1]; let channelId=key; const doc=await db.collection('channels').doc(key).get(); if(doc.exists)channelId=doc.data().channelId; postData[ctx.from.id]={step:'mediaType',channels:[channelId]}; await ctx.answerCbQuery(); return ctx.reply('📤 Channel selected।\n\nকী পোস্ট করবেন?',Markup.inlineKeyboard([[Markup.button.callback('🎬 Video','post_type_video'),Markup.button.callback('🖼️ Photo','post_type_photo')],[Markup.button.callback('❌ Cancel','post_cancel')]])); });

// Saved post buttons manager
bot.action('ab_add', async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); await ctx.answerCbQuery(); postData[ctx.from.id]={step:'button_name'}; return ctx.reply('🔘 Button-এর নাম লিখুন:'); });
bot.action(/^ab_edit:(\d+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const i=Number(ctx.match[1]); const bs=await getPostButtons(); if(!bs[i])return ctx.answerCbQuery('❌ নেই'); await ctx.answerCbQuery(); postData[ctx.from.id]={step:'button_edit_name',buttonIndex:i}; return ctx.reply(`✏️ বর্তমান নাম: ${bs[i].name}\n\nনতুন Button Name লিখুন (না বদলালে একই নাম আবার লিখুন):`); });
bot.action(/^ab_del:(\d+)$/, async ctx=>{ if(!adminOnly(ctx))return ctx.answerCbQuery('❌'); const i=Number(ctx.match[1]); const bs=await getPostButtons(); if(!bs[i])return ctx.answerCbQuery('❌ নেই'); bs.splice(i,1); if(!bs.length)bs.push(...DEFAULT_POST_BUTTONS); await savePostButtons(bs); await ctx.answerCbQuery('Deleted'); return ctx.reply('✅ Button delete হয়েছে।'); });


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

async function sendUserPage(ctx, docs, page) {
  let message = `👥 ইউজার তালিকা (${page})\n\n`;
  docs.forEach((doc, index) => {
    const user = doc.data();
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    const displayName = fullName || 'নাম পাওয়া যায়নি';
    const username = user.username ? `@${String(user.username).replace(/^@/, '')}` : 'Username নেই';
    const status = user.verified === true ? '✅' : '❌';
    message += `${(page - 1) * 25 + index + 1}. ${displayName}\n`;
    message += `   👤 ${username}\n   🆔 <code>${user.userId || doc.id}</code> ${status}\n\n`;
  });
  const buttons = adminUserCursor ? Markup.inlineKeyboard([[Markup.button.callback('➡️ পরের ২৫ জন', 'admin_users_next')]]) : undefined;
  await ctx.reply(message, { parse_mode: 'HTML', ...(buttons ? { reply_markup: buttons.reply_markup } : {}) });
}

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

    if (state.step === 'channel_name') { state.name=text.slice(0,80); state.step='channel_id'; return ctx.reply('🆔 Channel ID দিন (উদাহরণ: -1001234567890):'); }
    if (state.step === 'channel_id') { state.channelId=text; state.step='channel_link'; return ctx.reply('🔗 Channel link/username দিন (না থাকলে skip লিখুন):'); }
    if (state.step === 'channel_link') { state.link=text.toLowerCase()==='skip'?'':text; const c=await addChannelRecord(state); delete postData[userId]; return ctx.reply(`✅ Channel Added\n\n📢 ${c.name}\n🆔 ${c.channelId}`,Markup.inlineKeyboard([[Markup.button.callback('📤 Post Here','apostch:'+c.id)],[Markup.button.callback('📢 Channel Manager','adm_channels')]])); }
    if (state.step === 'channel_edit_name') { state.name=text.slice(0,80); state.step='channel_edit_id'; return ctx.reply(`🆔 Current ID: ${state.channel.channelId||''}\n\nনতুন Channel ID দিন (না বদলালে আগেরটাই লিখুন):`); }
    if (state.step === 'channel_edit_id') { state.channelId=text; state.step='channel_edit_link'; return ctx.reply(`🔗 Current Link: ${state.channel.link||'(none)'}\n\nনতুন link দিন, না থাকলে skip:`); }
    if (state.step === 'channel_edit_link') { state.link=text.toLowerCase()==='skip'?'':text; await db.collection('channels').doc(state.channelDocId).update({name:state.name,channelId:state.channelId,link:state.link,updatedAt:Date.now()}); delete postData[userId]; return ctx.reply('✅ Channel updated.',Markup.inlineKeyboard([[Markup.button.callback('📢 Channel Manager','adm_channels')]])); }
    if (state.step === 'button_name') { state.name=text.slice(0,60); state.step='button_url'; return ctx.reply('🔗 Button Link দিন।\n\nVideo button হলে: {VIDEO_LINK}\nHelp Admin হলে: {HELP_LINK}\nঅন্য link হলে সরাসরি https://... দিন।'); }
    if (state.step === 'button_url') { if(text!=='{VIDEO_LINK}'&&text!=='{HELP_LINK}'&&!/^https?:\/\//i.test(text)) return ctx.reply('❌ সঠিক https:// link বা {VIDEO_LINK}/{HELP_LINK} দিন।'); const bs=await getPostButtons(); bs.push({name:state.name,url:text}); await savePostButtons(bs); delete postData[userId]; return ctx.reply('✅ Button saved. নতুন post-এ automatic থাকবে।'); }
    if (state.step === 'button_edit_name') { state.name=text.slice(0,60); state.step='button_edit_url'; return ctx.reply('🔗 নতুন Button Link দিন।\n{VIDEO_LINK}, {HELP_LINK} অথবা https://...'); }
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
          `📌 Title: ${state.title}\n` +
          `🆔 ID: ${topicId}\n\n` +
          `✍️ এখন Channel Post-এর Caption লিখুন।\n` +
          `Caption না চাইলে "skip" লিখুন।`
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
        `🆔 Video/Topic ID: ${state.topicId}\n` +
        `📝 Caption: ${state.caption || '(কোনো caption নেই)'}\n\n` +
        `Buttons:\n▶️ ভিডিও দেখুন\nHelp Admin\n\n` +
        `সব ঠিক থাকলে Post চাপুন।`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Post Now', 'post_confirm')],
          [Markup.button.callback('❌ Cancel', 'post_cancel')]
        ])
      );
    }
  }


  if (adminVideoData[userId]) {
    const state = adminVideoData[userId];
    const topicId = text.trim();
    if (state.step === 'post_id') {
      const td = await db.collection('topics').doc(topicId).get();
      if (!td.exists) return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি। আবার ID পাঠান।');
      const channels = await getChannels();
      const rows = channels.filter(c => c.active !== false).map(c => [Markup.button.callback(`📢 ${String(c.name || c.channelId).slice(0,35)}`, `apostch_topic:${c.id || c.channelId}:${topicId}`)]);
      if (!rows.length && POST_CHANNEL) rows.push([Markup.button.callback('📢 Default Channel', `apostch_topic:${POST_CHANNEL}:${topicId}`)]);
      if (!rows.length) return ctx.reply('❌ কোনো Posting Channel সেট করা নেই।');
      state.topicId = topicId;
      state.step = 'waiting_channel';
      return ctx.reply(`📤 Video/Topic: ${td.data().title || 'নামবিহীন'}\n🆔 ${topicId}\n\nকোন Channel-এ Post করবেন?`, Markup.inlineKeyboard(rows));
    }
    if (state.step === 'delete_id') {
      const td = await db.collection('topics').doc(topicId).get();
      if (!td.exists) return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি। আবার ID পাঠান।');
      await db.collection('topics').doc(topicId).delete();
      delete adminVideoData[userId];
      invalidateTopicsCache();
      return ctx.reply(`✅ Video/Topic delete হয়েছে।\n🆔 ${topicId}`);
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
      return ctx.reply(`✅ Title পরিবর্তন হয়েছে।\n🆔 ${state.topicId}\n📌 ${text}`);
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
          `🆔 Video/Topic ID: ${state.topicId}\n` +
          `আগে ছিল: ${oldAds}টি Ads\n` +
          `এখন হবে: ${ads}টি Ads`
        );
      } catch (error) {
        console.error('❌ Error updating ads count:', error);
        return ctx.reply('❌ Ads count আপডেট করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
      }
    }
  }

  if (text.startsWith('/')) return;

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
      await runBroadcast(ctx, data);
      delete broadcastData[userId];
      return;
    }

    if (data.step === 'message') {
      data.message = text;
      await runBroadcast(ctx, data);
      delete broadcastData[userId];
      return;
    }
  }

  
});

bot.on('animation', async (ctx) => {
  const userId = ctx.from.id;
  if (broadcastData[userId] && broadcastData[userId].step === 'content') {
    broadcastData[userId].type = 'animation';
    broadcastData[userId].file = ctx.message.animation.file_id;
    broadcastData[userId].step = 'message';
    await ctx.reply('📝 এবার ব্রডকাস্টের ক্যাপশন/মেসেজ লিখুন (রেফার লিংক সহ):');
  }
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const photo = ctx.message.photo;
  const fileId = photo[photo.length - 1].file_id;

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
      return ctx.reply(`✅ Thumbnail আপডেট হয়েছে।\n🆔 ${id}`);
    } catch (e) { return ctx.reply('❌ Thumbnail আপডেট করতে সমস্যা হয়েছে।'); }
  }

  try {
    const storedFileId = await forwardPhotoToStorageChannel(ctx, fileId);
  } catch (error) {
    await ctx.reply('❌ থাম্বনেইল স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।').catch(() => {});
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
    await ctx.reply(`✅ টপিক "${data.title}" তৈরি হয়েছে!\n📹 ভিডিও সংখ্যা: ${data.videos.length}\n🔢 অ্যাড প্রয়োজন: ${data.adsRequired}\n🆔 টপিক আইডি: <code>${topicRef.id}</code>`, { parse_mode: 'HTML' });
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
    await ctx.reply(`✅ ভিডিও "${data.title}" যোগ হয়েছে!\n🆔 টপিক আইডি: <code>${topicRef.id}</code>`, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error saving video:', error);
    await ctx.reply('❌ ভিডিও সেভ করতে সমস্যা হয়েছে।');
  }
}

// ============ API ENDPOINTS ============

app.get('/api/users/verify/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const userRef = db.collection('users').doc(userId.toString());
    const doc = await userRef.get();
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

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json(topic);
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
  try {
    const fileId = req.params.fileId;
    const now = Date.now();
    let entry = fileLinkCache.get(fileId);
    if (!entry || entry.expiresAt <= now) {
      entry = { promise: bot.telegram.getFileLink(fileId), expiresAt: now + FILE_LINK_CACHE_TTL };
      fileLinkCache.set(fileId, entry);
      entry.url = await entry.promise;
      entry.promise = null;
    } else if (entry.promise) {
      entry.url = await entry.promise;
      entry.promise = null;
    }
    res.set('Cache-Control', 'public, max-age=600');
    return res.redirect(entry.url);
  } catch (error) {
    fileLinkCache.delete(req.params.fileId);
    res.status(404).json({ error: 'Thumbnail not found' });
  }
});

app.get('/api/user-unlocked/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const userRef = db.collection('users').doc(userId.toString());
    const doc = await userRef.get();
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
    res.json({
      topics: activeUnlocked,
      history: unlockedTopics,
      expiresAt,
      adProgress: data.adProgress || {},
      dailyLimit,
      dailyUsed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function deliverUnlockedTopic(userId, topicId) {
  const userRef = db.collection('users').doc(userId.toString());
  const doc = await userRef.get();
  const data = doc.exists ? doc.data() : {};
  let unlockedTopics = data.unlockedTopics || [];
  let topicUnlockTime = data.topicUnlockTime || {};
  let sentMessages = data.sentMessages || [];

  const now = Date.now();
  const topicRef = db.collection('topics').doc(topicId);
  const topicDoc = await topicRef.get();
  if (!topicDoc.exists) throw new Error('Topic not found');

  const firstUnlock = !unlockedTopics.includes(topicId);
  if (firstUnlock) {
    unlockedTopics.push(topicId);
    topicUnlockTime[topicId] = now;

    try {
      const currentTopicData = topicDoc.data() || {};
      const existingRecent = Array.isArray(currentTopicData.recentUnlocks) ? currentTopicData.recentUnlocks : [];
      const recentUnlocks = existingRecent
        .map(value => typeof value === 'number' ? value : new Date(value).getTime())
        .filter(value => Number.isFinite(value))
        .slice(-99);
      recentUnlocks.push(now);

      await db.runTransaction(async tx => {
        const fresh = await tx.get(topicRef);
        const current = fresh.exists ? (fresh.data() || {}) : {};
        const todayKey = getDhakaDateKey(new Date(now));
        const sameDay = current.dailyUnlockDate === todayKey;
        const dailyUnlockCount = sameDay ? (Number(current.dailyUnlockCount) || 0) + 1 : 1;
        tx.set(topicRef, {
          unlockCount: admin.firestore.FieldValue.increment(1),
          lastUnlockAt: now,
          recentUnlocks,
          dailyUnlockDate: todayKey,
          dailyUnlockCount
        }, { merge: true });
      });
    } catch (countError) {
      console.error('❌ Could not update unlock/trending count:', countError.message);
    }
  }

  const videos = topicDoc.data().videos || [];
  for (const videoId of videos) {
    try {
      const alreadySent = sentMessages.some(m => m.videoId === videoId && m.topicId === topicId && (now - m.sentAt) < THIRTY_MINUTES);
      if (alreadySent) continue;
      // safeSendVideo uses 403-tolerant wrapper
      const sentMsg = await safeSendVideo(userId, videoId, {
        protect_content: true,
        caption: '⏳ এই ভিডিও ৩০ মিনিট পর ডিলিট হয়ে যাবে।'
      });
      if (sentMsg) {
        sentMessages.push({ messageId: sentMsg.message_id, chatId: userId, videoId, topicId, sentAt: Date.now() });
      }
    } catch (sendError) {
      console.error(`❌ Error sending video:`, sendError.message);
    }
  }

  sentMessages = sentMessages.filter(m => {
    const sentAt = Number(m && m.sentAt) || 0;
    return sentAt && (now - sentAt) < THIRTY_MINUTES;
  });

  const cleanupDueAt = getCleanupDueAt(sentMessages);
  await userRef.set({
    unlockedTopics,
    topicUnlockTime,
    sentMessages,
    cleanupDueAt: cleanupDueAt || null
  }, { merge: true });
  invalidateTopicsCache();
  return { success: true, videosDelivered: videos.length };
}

app.post('/api/ad-complete', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const topicId = String(req.body.topicId || '').trim();
    if (!userId || !topicId) return res.status(400).json({ error: 'userId and topicId are required' });

    const topicDoc = await db.collection('topics').doc(topicId).get();
    if (!topicDoc.exists) return res.status(404).json({ error: 'Topic not found' });
    const required = Math.max(1, Number(topicDoc.data().adsRequired) || 1);

    const userRef = db.collection('users').doc(userId);
    const dailyLimit = await getDailyAdLimit();
    const today = getDhakaDateKey();
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const progress = { ...(data.adProgress || {}) };
      const unlockedTopics = data.unlockedTopics || [];
      const current = Number(progress[topicId]) || 0;
      if (unlockedTopics.includes(topicId)) return { count: required, required, unlocked: true, limitReached: false, dailyUsed: Number(data.dailyAdsUsed) || 0 };

      const dailyUsed = data.dailyAdDate === today ? (Number(data.dailyAdsUsed) || 0) : 0;
      if (dailyUsed >= dailyLimit) return { count: current, required, unlocked: false, limitReached: true, dailyUsed };

      const next = Math.min(current + 1, required);
      progress[topicId] = next;
      tx.set(userRef, { adProgress: progress, dailyAdDate: today, dailyAdsUsed: dailyUsed + 1 }, { merge: true });
      return { count: next, required, unlocked: next >= required, limitReached: false, dailyUsed: dailyUsed + 1 };
    });

    if (result.limitReached) {
      return res.status(429).json({ success: false, limitReached: true, dailyLimit, dailyUsed: result.dailyUsed, error: 'আজকের Ad Limit শেষ' });
    }

    if (result.unlocked) {
      // If the user has already started the bot, deliver the exact topic
      // directly. Do NOT redirect through another /start deep-link.
      const userSnap = await userRef.get();
      const userData = userSnap.exists ? (userSnap.data() || {}) : {};

      if (userData.botStarted === true) {
        try {
          await deliverUnlockedTopic(userId, topicId);
          return res.json({
            success: true,
            count: result.count,
            required: result.required,
            unlocked: true,
            directDelivered: true
          });
        } catch (deliveryError) {
          console.error('❌ Direct topic delivery error:', deliveryError.message);
          return res.status(500).json({
            success: false,
            error: 'ভিডিও পাঠাতে সমস্যা হয়েছে।'
          });
        }
      }

      // New user: first unlock still goes to the bot and uses /start once
      // so Telegram can establish the bot chat.
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
// 🧹 CLEANUP CRON (light: every 2 minutes)
// =============================================

cron.schedule('*/2 * * * *', async () => {
  if (cleanupRunning) {
    console.log('⏭️ Cleanup already running; skipping this cycle.');
    return;
  }
  cleanupRunning = true;
  try {
    const now = Date.now();
    console.log('🔄 Running cleanup check...');

    const snapshot = await db.collection('users')
      .where('cleanupDueAt', '<=', now)
      .limit(200)
      .get();

    let deletedCount = 0;
    let updatedUsers = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const sentMessages = Array.isArray(data.sentMessages) ? data.sentMessages : [];
      const remainingMessages = [];
      let hadExpired = false;
      let retryNeeded = false;

      for (const msg of sentMessages) {
        const sentAt = Number(msg && msg.sentAt) || 0;
        if (!sentAt || (now - sentAt) < THIRTY_MINUTES) {
          if (sentAt) remainingMessages.push(msg);
          continue;
        }
        hadExpired = true;
        const ok = await safeDeleteMessage(msg.chatId, msg.messageId);
        if (ok) deletedCount++;
        else {
          // Blocked user হলে retry করা অর্থহীন, তাই drop করি
          if (isBlockedError({ message: 'blocked by the user' })) continue;
          retryNeeded = true;
          remainingMessages.push(msg);
        }
      }

      const unlockedTopics = Array.isArray(data.unlockedTopics) ? data.unlockedTopics : [];
      const topicUnlockTime = data.topicUnlockTime || {};
      const stillUnlocked = unlockedTopics.filter(topicId => {
        const time = Number(topicUnlockTime[topicId]) || 0;
        return time && (now - time) < THIRTY_MINUTES;
      });

      let nextCleanupAt = null;
      if (retryNeeded) nextCleanupAt = now + 2 * 60 * 1000;
      else nextCleanupAt = getCleanupDueAt(remainingMessages);

      const updates = { cleanupDueAt: nextCleanupAt || null };
      if (hadExpired || remainingMessages.length !== sentMessages.length) {
        updates.sentMessages = remainingMessages;
      }
      if (stillUnlocked.length !== unlockedTopics.length) {
        updates.unlockedTopics = stillUnlocked;
      }

      if (Object.keys(updates).length > 1 || Number(data.cleanupDueAt) !== Number(updates.cleanupDueAt)) {
        await doc.ref.set(updates, { merge: true });
        updatedUsers++;
      }
    }

    if (deletedCount > 0 || updatedUsers > 0 || snapshot.size > 0) {
      console.log(`✅ Cleanup: ${deletedCount} videos deleted, ${updatedUsers} users processed, ${snapshot.size} due users`);
    }
  } catch (error) {
    console.error('❌ Cron error:', error);
  } finally {
    cleanupRunning = false;
  }
});

// =============================================
// 🛠️ One-time cleanup migration (only once)
// =============================================

async function migrateCleanupSchedule() {
  const markerRef = db.collection('system').doc('cleanup');
  try {
    const marker = await markerRef.get();
    if (marker.exists && Number(marker.data().version) >= 2) {
      console.log('⏭️ Cleanup migration already done.');
      return;
    }
    console.log('🛠️ Preparing optimized cleanup schedule...');
    const snapshot = await db.collection('users').limit(500).get();
    let batch = db.batch();
    let batchCount = 0;
    let changed = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const sentMessages = Array.isArray(data.sentMessages) ? data.sentMessages : [];
      const dueAt = getCleanupDueAt(sentMessages);
      if (Number(data.cleanupDueAt) !== Number(dueAt)) {
        batch.set(doc.ref, { cleanupDueAt: dueAt || null }, { merge: true });
        batchCount++;
        changed++;
      }
      if (batchCount >= 450) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
    batch.set(markerRef, { version: 2, updatedAt: Date.now() }, { merge: true });
    await batch.commit();
    console.log(`✅ Cleanup migration complete: ${changed} users scheduled.`);
  } catch (error) {
    console.error('❌ Cleanup migration error:', error.message);
  }
}

// =============================================
// 🚀 LAUNCH (Render Free-এর জন্য safe config)
// =============================================

// ⚠️ গুরুত্বপূর্ণ: একই BOT_TOKEN দিয়ে একাধিক instance চললে polling conflict হয়।
// এই warning log করি যাতে DEBUG করা সহজ হয়।
console.log('🤖 Starting bot polling...');

bot.launch({
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
})
  .then(() => {
    console.log('🤖 Bot started successfully (polling mode)');
    // Migration একবার চালাই
    migrateCleanupSchedule().catch(() => {});
  })
  .catch(err => {
    console.error('❌ Bot start error:', err.message);
    // Polling failed হলে 5 সেকেন্ড পরে retry
    setTimeout(() => {
      console.log('🔄 Retrying bot launch...');
      bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: [
          'message',
          'callback_query',
          'inline_query',
          'chosen_inline_result',
          'edited_message'
        ]
      }).catch(e => console.error('❌ Retry failed:', e.message));
    }, 5000);
  });

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
});

// Graceful shutdown — Render restart-এ ঝুলে না যায়
process.once('SIGINT', () => {
  console.log('🛑 SIGINT received, stopping bot...');
  bot.stop('SIGINT');
  setTimeout(() => process.exit(0), 2000);
});
process.once('SIGTERM', () => {
  console.log('🛑 SIGTERM received, stopping bot...');
  bot.stop('SIGTERM');
  setTimeout(() => process.exit(0), 2000);
});
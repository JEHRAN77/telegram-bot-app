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

    const allJoined = await checkAllChannels(ctx);

    if (allJoined) {
      if (!user.verified) {
        await updateUser(userId, { verified: true, verifiedAt: new Date().toISOString() });
      }
      return ctx.reply(
        '✅ যাচাই সফল!',
        Markup.inlineKeyboard([
          Markup.button.webApp('🚀 Open App', MINI_APP_URL)
        ])
      );
    }

    if (user.verified) {
      await updateUser(userId, { verified: false });
    }

    const channelButtons = REQUIRED_CHANNELS.map(channel => {
      const cleanId = channel.startsWith('-100') ? channel : channel.replace('@', '');
      const link = channel.startsWith('-100')
        ? `https://t.me/c/${cleanId.replace('-100', '')}`
        : `https://t.me/${cleanId}`;
      return [Markup.button.url(`📢 চ্যানেল জয়েন করুন`, link)];
    });
    channelButtons.push([Markup.button.callback('✅ I\'ve Joined', 'verify_join')]);
    await ctx.reply(
      '⚠️ ভিডিও দেখার জন্য চ্যানেলটি জয়েন করুন:\n\nচ্যানেল জয়েন করে "✅ I\'ve Joined" বাটনে ক্লিক করুন',
      Markup.inlineKeyboard(channelButtons)
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

bot.command('addvideo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  }
  delete updateAdsData[ctx.from.id];
  addVideoData[ctx.from.id] = { step: 'video' };
  await ctx.reply('📹 ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)');
});

bot.command('addtopic', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  }
  delete updateAdsData[ctx.from.id];
  addTopicData[ctx.from.id] = { step: 'video', videos: [] };
  await ctx.reply('📹 প্রথম ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)');
});

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

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const document = ctx.message.document;
  if (!document.mime_type || !document.mime_type.startsWith('video/')) {
    return ctx.reply('❌ দয়া করে একটি ভিডিও ফাইল পাঠান।');
  }
  const fileId = document.file_id;

  // /post preview: NEVER send preview documents to STORAGE_CHANNEL.
  // Telegram may deliver a video uploaded as a file/document here instead of as a video.
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

  const helpLink = await getHelpAdminLink();
  if (!helpLink) {
    return ctx.reply('⚠️ আগে /setlink দিয়ে Help Admin Direct Link সেট করুন।');
  }

  postData[ctx.from.id] = { step: 'mediaType' };
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

bot.action('post_confirm', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ অনুমতি নেই');
  const userId = ctx.from.id;
  const state = postData[userId];

  if (!state || state.step !== 'confirm' || !state.fileId || !state.topicId) {
    return ctx.answerCbQuery('❌ Post data পাওয়া যায়নি। /post দিয়ে আবার শুরু করুন');
  }
  if (!POST_CHANNEL) return ctx.answerCbQuery('❌ POST_CHANNEL সেট করা নেই');

  const helpLink = await getHelpAdminLink();
  if (!helpLink) return ctx.answerCbQuery('❌ /setlink দিয়ে Help Admin link সেট করুন');

  await ctx.answerCbQuery('Posting...');
  try {
    const keyboard = buildPostKeyboard(state.topicId, helpLink);
    let sent;

    if (state.type === 'video') {
      sent = await bot.telegram.sendVideo(POST_CHANNEL, state.fileId, {
        caption: state.caption || undefined,
        reply_markup: keyboard.reply_markup
      });
    } else {
      sent = await bot.telegram.sendPhoto(POST_CHANNEL, state.fileId, {
        caption: state.caption || undefined,
        reply_markup: keyboard.reply_markup
      });
    }

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
    console.log('📊 /admin command by:', ctx.from.id);
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }
    await ctx.reply('⏳ অ্যাডমিন প্যানেল লোড হচ্ছে...');

    const counts = await getUserCountsCached();
    await ctx.reply(
      `📊 অ্যাডমিন প্যানেল\n\n` +
      `✅ যাচাইকৃত: ${counts.verifiedUsers}\n` +
      `👥 মোট ইউজার: ${counts.totalUsers}`
    );
  } catch (error) {
    console.error('❌ Error in /admin:', error);
    await ctx.reply('❌ অ্যাডমিন প্যানেল লোড করতে সমস্যা: ' + error.message);
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

    let message =
      `📊 স্ট্যাটিসটিক্স\n\n` +
      `👥 মোট ইউজার: ${counts.totalUsers} জন\n` +
      `✅ যাচাইকৃত ইউজার: ${counts.verifiedUsers} জন\n` +
      `📁 মোট ভিডিও/টপিক: ${topics.length}টি\n` +
      `👁️ মোট ভিউ: ${totalViews}\n\n` +
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

  if (postData[userId]) {
    const state = postData[userId];

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

  if (addTopicData[userId]) {
    const data = addTopicData[userId];
    if (data.step === 'title') {
      data.title = text;
      data.step = 'thumbnail';
      await ctx.reply('🖼️ এই টপিকের জন্য একটি থাম্বনেইল ইমেজ পাঠান:');
      return;
    }
    if (data.step === 'ads') {
      const ads = parseInt(text);
      if (isNaN(ads) || ads < 1) {
        await ctx.reply('❌ দয়া করে একটি বৈধ সংখ্যা দিন (১ বা তার বেশি):');
        return;
      }
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
      await ctx.reply('🖼️ এই ভিডিওর জন্য একটি থাম্বনেইল ইমেজ পাঠান:');
      return;
    }
    if (data.step === 'ads') {
      const ads = parseInt(text);
      if (isNaN(ads) || ads < 1) {
        await ctx.reply('❌ দয়া করে একটি বৈধ সংখ্যা দিন (১ বা তার বেশি):');
        return;
      }
      data.adsRequired = ads;
      await saveVideo(ctx, data);
      delete addVideoData[userId];
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
    if (addTopicData[userId]) {
      const data = addTopicData[userId];
      if (data.step === 'thumbnail') {
        data.thumbnail = storedFileId;
        data.step = 'ads';
        await ctx.reply('🔢 এই টপিক আনলক করতে কতগুলো অ্যাড দেখতে হবে? (শুধু সংখ্যা দিন):');
        return;
      }
    }
    if (addVideoData[userId]) {
      const data = addVideoData[userId];
      if (data.step === 'thumbnail') {
        data.thumbnail = storedFileId;
        data.step = 'ads';
        await ctx.reply('🔢 এই ভিডিও আনলক করতে কতগুলো অ্যাড দেখতে হবে? (শুধু সংখ্যা দিন):');
        return;
      }
    }
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
    const today = new Date().toISOString().slice(0, 10);
    const dailyUsed = data.dailyAdDate === today ? (Number(data.dailyAdsUsed) || 0) : 0;
    const dailyLimit = await getDailyAdLimit();
    res.json({ topics: activeUnlocked, expiresAt, dailyLimit, dailyUsed });
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

      await topicRef.set({
        unlockCount: admin.firestore.FieldValue.increment(1),
        lastUnlockAt: now,
        recentUnlocks
      }, { merge: true });
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
    const today = new Date().toISOString().slice(0, 10);
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
      await deliverUnlockedTopic(userId, topicId);
      return res.json({ success: true, count: result.count, required: result.required, unlocked: true });
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
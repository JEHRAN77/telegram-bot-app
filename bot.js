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

// ✅ .env থেকে Firebase JSON ব্যবহার করুন
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

console.log('✅ Firebase Connected');

const REQUIRED_CHANNELS = process.env.REQUIRED_CHANNELS.split(',').map(id => id.trim());
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL;
const ADMIN_ID = parseInt(process.env.ADMIN_USER_ID);
const MINI_APP_URL = 'https://telegram-bot-app-24ti.onrender.com';

let addTopicData = {};
let addVideoData = {};
let broadcastData = {};
let updateAdsData = {};

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
        sentMessages: []
      });
      return { userId, username, firstName, lastName, verified: false, unlockedTopics: [], topicUnlockTime: {}, sentMessages: [] };
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

bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await getOrCreateUser(
      userId,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name
    );

    // প্রতিবার লাইভ চেক করা হয় — পুরনো "verified" flag কখনোই সরাসরি trust করা হয় না
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

    // চ্যানেলে নেই — আগে verified থাকলেও এখন সেটা false করে দেওয়া হচ্ছে
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
    await ctx.reply('❌ কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।');
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
    await ctx.reply('❌ কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।');
  }
});

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
    await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।');
  }
});

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const document = ctx.message.document;
  if (!document.mime_type || !document.mime_type.startsWith('video/')) {
    return ctx.reply('❌ দয়া করে একটি ভিডিও ফাইল পাঠান।');
  }
  const fileId = document.file_id;
  
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
    await ctx.reply('❌ ভিডিও স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।');
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
// ✅ অ্যাডমিন কমান্ড
// =============================================

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
  const topicsSnapshot = await db.collection('topics').get();
  if (topicsSnapshot.empty) throw new Error('NO_TOPICS');

  const topics = topicsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  topics.sort((a, b) => {
    const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : new Date(a.createdAt || 0).getTime();
    const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : new Date(b.createdAt || 0).getTime();
    return orderB - orderA;
  });

  const index = topics.findIndex(t => t.id === topicId);
  if (index === -1) throw new Error('NOT_FOUND');

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= topics.length) return { edge: true, topic: topics[index] };

  // Rebuild stable ordering for all topics. This also upgrades old topics that have no sortOrder.
  const reordered = topics.slice();
  const temp = reordered[index];
  reordered[index] = reordered[targetIndex];
  reordered[targetIndex] = temp;

  const batch = db.batch();
  reordered.forEach((topic, i) => {
    batch.update(db.collection('topics').doc(topic.id), { sortOrder: reordered.length - i });
  });
  await batch.commit();

  return { edge: false, topic: reordered[targetIndex], swappedWith: reordered[index] };
}

bot.command('up', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  const args = ctx.message.text.trim().split(/\s+/);
  const topicId = args[1];
  if (!topicId) return ctx.reply('⬆️ ব্যবহার: /up VIDEO_ID\n\nউদাহরণ: /up abc123');
  try {
    const result = await moveTopic(topicId, 'up');
    if (result.edge) return ctx.reply('⬆️ এই ভিডিওটি ইতোমধ্যে সবার উপরে আছে।');
    await ctx.reply(`✅ ভিডিওটি ১ ধাপ উপরে নেওয়া হয়েছে।\n\n📌 ${result.topic.title || 'নামবিহীন টপিক'}\n🆔 <code>${topicId}</code>`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি।');
    console.error('❌ /up error:', error);
    return ctx.reply('❌ ভিডিও উপরে নিতে সমস্যা হয়েছে।');
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
    await ctx.reply(`✅ ভিডিওটি ১ ধাপ নিচে নেওয়া হয়েছে।\n\n📌 ${result.topic.title || 'নামবিহীন টপিক'}\n🆔 <code>${topicId}</code>`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return ctx.reply('❌ এই Video/Topic ID পাওয়া যায়নি।');
    console.error('❌ /down error:', error);
    return ctx.reply('❌ ভিডিও নিচে নিতে সমস্যা হয়েছে।');
  }
});

bot.command('list', async (ctx) => {
  try {
    console.log('📋 /list command by:', ctx.from.id);
    
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }

    await ctx.reply('⏳ তালিকা তৈরি হচ্ছে...');

    const snapshot = await db.collection('topics').get();
    if (snapshot.empty) {
      return ctx.reply('📭 এখনো কোনো টপিক যোগ করা হয়নি।');
    }

    let message = '📋 সব টপিক:\n\n';
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
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

bot.command('admin', async (ctx) => {
  try {
    console.log('📊 /admin command by:', ctx.from.id);
    
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
    }

    await ctx.reply('⏳ অ্যাডমিন প্যানেল লোড হচ্ছে...');

    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => doc.data());
    const verifiedUsers = users.filter(u => u.verified === true);

    await ctx.reply(
      `📊 অ্যাডমিন প্যানেল\n\n` +
      `✅ যাচাইকৃত: ${verifiedUsers.length}\n` +
      `👥 মোট ইউজার: ${users.length}`
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

    const userSnapshot = await db.collection('users').get();
    const users = userSnapshot.docs.map(doc => doc.data());
    const verifiedUsers = users.filter(u => u.verified === true);

    const topicSnapshot = await db.collection('topics').get();

    const topics = topicSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
      `👥 মোট ইউজার: ${users.length} জন\n` +
      `✅ যাচাইকৃত ইউজার: ${verifiedUsers.length} জন\n` +
      `📁 মোট ভিডিও/টপিক: ${topics.length}টি\n` +
      `👁️ মোট ভিউ: ${totalViews}\n\n` +
      `🏆 ভিডিও অনুযায়ী ভিউ:\n\n`;

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

    let success = 0, failed = 0;
    for (const user of users) {
      try {
        if (data.type === 'photo') {
          await bot.telegram.sendPhoto(user.userId, data.file, { caption: data.message || '' });
        } else if (data.type === 'video') {
          await bot.telegram.sendVideo(user.userId, data.file, { caption: data.message || '' });
        } else if (data.type === 'animation') {
          await bot.telegram.sendAnimation(user.userId, data.file, { caption: data.message || '' });
        } else if (data.type === 'poll') {
          await bot.telegram.sendPoll(user.userId, data.question, data.options, {
            is_anonymous: true,
            allows_multiple_answers: false
          });
        } else {
          await bot.telegram.sendMessage(user.userId, data.message);
        }
        success++;
      } catch (error) {
        failed++;
        console.error(`❌ Failed to send to ${user.userId}:`, error.message);
      }
      // ছোট delay, একসাথে অনেক বেশি fast না পাঠানোর জন্য (Telegram rate limit avoid করতে)
      await new Promise(resolve => setTimeout(resolve, 40));
    }

    await ctx.reply(`✅ ব্রডকাস্ট শেষ!\n✅ সফল: ${success}\n❌ ব্যর্থ: ${failed}`);
  } catch (error) {
    console.error('❌ Error in broadcast run:', error);
    await ctx.reply('❌ ব্রডকাস্ট করতে সমস্যা: ' + error.message);
  }
}

// =============================================
// 🩺 ডায়াগনস্টিক টুল
// =============================================

bot.command('checkdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ শুধুমাত্র অ্যাডমিনের জন্য।');
  }

  try {
    const topics = await db.collection('topics').get();
    const users = await db.collection('users').get();
    await ctx.reply(
      `📊 ডেটাবেস রিপোর্ট:\n\n` +
      `📁 টপিক: ${topics.size}টি\n` +
      `👥 ইউজার: ${users.size}টি`
    );
  } catch (error) {
    await ctx.reply('❌ ডেটাবেস চেক করতে সমস্যা: ' + error.message);
  }
});

bot.command('testdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ শুধুমাত্র অ্যাডমিনের জন্য।');
  }
  
  try {
    const usersSnapshot = await db.collection('users').get();
    const userCount = usersSnapshot.size;
    
    const topicsSnapshot = await db.collection('topics').get();
    const topicCount = topicsSnapshot.size;
    
    let reply = `📊 ডেটাবেস রিপোর্ট:\n\n`;
    reply += `👥 ইউজার: ${userCount}টি\n`;
    reply += `📁 টপিক: ${topicCount}টি\n\n`;
    
    if (topicCount > 0) {
      reply += `📌 টপিকের নাম:\n`;
      topicsSnapshot.docs.forEach((doc, i) => {
        const data = doc.data();
        reply += `${i+1}. ${data.title || 'নামবিহীন'} (${doc.id})\n`;
      });
    }
    
    if (userCount > 0) {
      reply += `\n👤 ইউজার:\n`;
      usersSnapshot.docs.forEach((doc, i) => {
        const data = doc.data();
        reply += `${i+1}. ${data.firstName || 'N/A'} (${data.verified ? '✅' : '❌'})\n`;
      });
    }
    
    await ctx.reply(reply);
    
  } catch (error) {
    console.error('❌ testdb error:', error);
    await ctx.reply('❌ ডেটাবেস চেক করতে সমস্যা: ' + error.message);
  }
});


bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // /ads interactive flow: /ads -> Topic ID -> new Ads count
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
          return ctx.reply(`❌ এই Video/Topic ID পাওয়া যায়নি:\n${topicId}\n\nআবার সঠিক ID পাঠান।`);
        }

        const currentAds = Math.max(1, Number(topicDoc.data().adsRequired) || 1);
        state.topicId = topicId;
        state.currentAds = currentAds;
        state.step = 'count';

        return ctx.reply(
          `📌 এই ভিডিও/টপিকের বর্তমান Ads count: ${currentAds}টি\n\n` +
          '👉 এখন বলুন, কয়টি Ads রাখতে চান?\n' +
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
          return ctx.reply('❌ Video/Topic আর পাওয়া যাচ্ছে না। /ads দিয়ে আবার শুরু করুন।');
        }

        const oldAds = Math.max(1, Number(topicDoc.data().adsRequired) || 1);
        await topicRef.update({
          adsRequired: ads,
          updatedAt: new Date().toISOString()
        });

        delete updateAdsData[userId];
        return ctx.reply(
          `✅ Ads count সফলভাবে আপডেট হয়েছে!\n\n` +
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

  if (text.startsWith('/')) {
    return;
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
    await ctx.reply('❌ থাম্বনেইল স্টোরেজ চ্যানেলে ফরওয়ার্ড করতে সমস্যা হয়েছে।');
  }
});

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

app.get('/api/topics', async (req, res) => {
  try {
    const snapshot = await db.collection('topics').get();
    const topics = [];
    snapshot.docs.forEach(doc => {
      topics.push({ id: doc.id, ...doc.data() });
    });
    // Manual order first; old topics fall back to upload time.
    topics.sort((a, b) => {
      const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : new Date(a.createdAt || 0).getTime();
      const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : new Date(b.createdAt || 0).getTime();
      return orderB - orderA;
    });
    res.json(topics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/thumbnail/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const fileLink = await bot.telegram.getFileLink(fileId);
    res.redirect(fileLink);
  } catch (error) {
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
    const THIRTY_MINUTES = 30 * 60 * 1000;
    
    const activeUnlocked = unlockedTopics.filter(topicId => {
      const time = topicUnlockTime[topicId];
      return time && (now - time) < THIRTY_MINUTES;
    });
    
    res.json({ topics: activeUnlocked });
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
  const THIRTY_MINUTES = 30 * 60 * 1000;
  const topicRef = db.collection('topics').doc(topicId);
  const topicDoc = await topicRef.get();
  if (!topicDoc.exists) throw new Error('Topic not found');

  const firstUnlock = !unlockedTopics.includes(topicId);
  if (firstUnlock) {
    unlockedTopics.push(topicId);
    topicUnlockTime[topicId] = now;

    // Keep a simple popularity counter for the Mini App categories.
    try {
      await topicRef.set({ unlockCount: admin.firestore.FieldValue.increment(1) }, { merge: true });
    } catch (countError) {
      console.error('❌ Could not update unlock count:', countError.message);
    }
  }

  const videos = topicDoc.data().videos || [];
  for (const videoId of videos) {
    try {
      const alreadySent = sentMessages.some(m => m.videoId === videoId && m.topicId === topicId && (now - m.sentAt) < THIRTY_MINUTES);
      if (alreadySent) continue;
      const sentMsg = await bot.telegram.sendVideo(userId, videoId, {
        protect_content: true,
        caption: '⏳ এই ভিডিও ৩০ মিনিট পর ডিলিট হয়ে যাবে।'
      });
      sentMessages.push({ messageId: sentMsg.message_id, chatId: userId, videoId, topicId, sentAt: Date.now() });
    } catch (sendError) {
      console.error(`❌ Error sending video:`, sendError.message);
    }
  }

  await userRef.set({ unlockedTopics, topicUnlockTime, sentMessages }, { merge: true });
  return { success: true, videosDelivered: videos.length };
}

// One completed rewarded ad = one server-side progress increment.
app.post('/api/ad-complete', async (req, res) => {
  try {
    const userId = String(req.body.userId || '').trim();
    const topicId = String(req.body.topicId || '').trim();
    if (!userId || !topicId) return res.status(400).json({ error: 'userId and topicId are required' });

    const topicDoc = await db.collection('topics').doc(topicId).get();
    if (!topicDoc.exists) return res.status(404).json({ error: 'Topic not found' });
    const required = Math.max(1, Number(topicDoc.data().adsRequired) || 1);

    const userRef = db.collection('users').doc(userId);
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const progress = { ...(data.adProgress || {}) };
      const unlockedTopics = data.unlockedTopics || [];
      const current = Number(progress[topicId]) || 0;

      if (unlockedTopics.includes(topicId)) {
        return { count: required, required, unlocked: true };
      }

      const next = Math.min(current + 1, required);
      progress[topicId] = next;
      tx.set(userRef, { adProgress: progress }, { merge: true });
      return { count: next, required, unlocked: next >= required };
    });

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

// Legacy endpoint kept, but it can no longer unlock a topic by itself.
app.post('/api/unlock-topic', async (req, res) => {
  return res.status(403).json({ error: 'Complete the required rewarded ads first.' });
});

cron.schedule('* * * * *', async () => {
  try {
    console.log('🔄 Running cleanup check...');
    const snapshot = await db.collection('users').get();
    const now = Date.now();
    const THIRTY_MINUTES = 30 * 60 * 1000;
    let deletedCount = 0;
    let updatedUsers = 0;
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      let needsUpdate = false;
      
      const sentMessages = data.sentMessages || [];
      const remainingMessages = [];
      for (const msg of sentMessages) {
        if (now - msg.sentAt < THIRTY_MINUTES) {
          remainingMessages.push(msg);
        } else {
          try {
            await bot.telegram.deleteMessage(msg.chatId, msg.messageId);
            deletedCount++;
            console.log(`🗑️ Deleted video ${msg.messageId} for user ${msg.chatId}`);
          } catch (error) {
            console.error(`❌ Could not delete message ${msg.messageId}:`, error.message);
          }
        }
      }
      
      if (remainingMessages.length !== sentMessages.length) {
        await doc.ref.set({ sentMessages: remainingMessages }, { merge: true });
        needsUpdate = true;
      }
      
      const unlockedTopics = data.unlockedTopics || [];
      const topicUnlockTime = data.topicUnlockTime || {};
      
      const stillUnlocked = unlockedTopics.filter(topicId => {
        const time = topicUnlockTime[topicId];
        return time && (now - time) < THIRTY_MINUTES;
      });
      
      if (stillUnlocked.length !== unlockedTopics.length) {
        await doc.ref.set({
          unlockedTopics: stillUnlocked
        }, { merge: true });
        needsUpdate = true;
      }
      
      if (needsUpdate) updatedUsers++;
    }
    
    if (deletedCount > 0 || updatedUsers > 0) {
      console.log(`✅ Cleanup: ${deletedCount} videos deleted, ${updatedUsers} users updated`);
    }
  } catch (error) {
    console.error('❌ Cron error:', error);
  }
});

bot.launch()
  .then(() => console.log('🤖 Bot started successfully'))
  .catch(err => console.error('❌ Bot start error:', err));

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

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
    if (user.verified) {
      return ctx.reply(
        '🎉 আপনি ইতিমধ্যে যাচাইকৃত!',
        Markup.inlineKeyboard([
          Markup.button.webApp('🚀 Open App', MINI_APP_URL)
        ])
      );
    }
    const allJoined = await checkAllChannels(ctx);
    if (allJoined) {
      await updateUser(userId, { verified: true, verifiedAt: new Date().toISOString() });
      return ctx.reply(
        '✅ যাচাই সফল!',
        Markup.inlineKeyboard([
          Markup.button.webApp('🚀 Open App', MINI_APP_URL)
        ])
      );
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
      return ctx.reply('✅ আপনি ইতিমধ্যে যাচাইকৃত!');
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
  addVideoData[ctx.from.id] = { step: 'video' };
  await ctx.reply('📹 ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)');
});

bot.command('addtopic', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ এই কমান্ড শুধুমাত্র অ্যাডমিনের জন্য।');
  }
  addTopicData[ctx.from.id] = { step: 'video', videos: [] };
  await ctx.reply('📹 প্রথম ভিডিওটি পাঠান (ফাইল বা ভিডিও হিসেবে)');
});

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  const video = ctx.message.video;
  const fileId = video.file_id;
  
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

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  
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

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const photo = ctx.message.photo;
  const fileId = photo[photo.length - 1].file_id;
  
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
      createdAt: new Date().toISOString()
    });
    await ctx.reply(`✅ টপিক "${data.title}" তৈরি হয়েছে!\n📹 ভিডিও সংখ্যা: ${data.videos.length}\n🔢 অ্যাড প্রয়োজন: ${data.adsRequired}\n🆔 টপিক আইডি: ${topicRef.id}`);
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
      createdAt: new Date().toISOString()
    });
    await ctx.reply(`✅ ভিডিও "${data.title}" যোগ হয়েছে!\n🆔 টপিক আইডি: ${topicRef.id}`);
  } catch (error) {
    console.error('Error saving video:', error);
    await ctx.reply('❌ ভিডিও সেভ করতে সমস্যা হয়েছে।');
  }
}

// =============================================
// ✅ অ্যাডমিন কমান্ড (ডিবাগ ভার্সন)
// =============================================

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
      message += `   🆔 ${doc.id}\n`;
      message += `   📹 ${data.videoCount || 0}টি ভিডিও\n`;
      message += `   🔢 ${data.adsRequired || 0}টি অ্যাড\n\n`;
    });
    await ctx.reply(message);
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

    const snapshot = await db.collection('users')
      .where('verified', '==', true)
      .orderBy('verifiedAt', 'desc')
      .limit(10)
      .get();

    if (snapshot.empty) {
      return ctx.reply('📊 এখনো কোনো যাচাইকৃত ইউজার নেই।');
    }

    let message = '📊 সর্বশেষ যাচাইকৃত ইউজার:\n\n';
    snapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      message += `${index + 1}. ${data.firstName} ${data.lastName || ''}\n`;
    });
    await ctx.reply(message);
  } catch (error) {
    console.error('❌ Error in /stats:', error);
    await ctx.reply('❌ পরিসংখ্যান লোড করতে সমস্যা: ' + error.message);
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

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('⚠️ মেসেজ দিন:\n/broadcast <আপনার মেসেজ>');
    }

    const message = args.slice(1).join(' ');
    await ctx.reply(`⏳ ব্রডকাস্ট শুরু হচ্ছে...`);

    const snapshot = await db.collection('users').where('verified', '==', true).get();
    const users = snapshot.docs.map(doc => doc.data());

    if (users.length === 0) {
      return ctx.reply('📭 কোনো যাচাইকৃত ইউজার নেই।');
    }

    let success = 0, failed = 0;
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.userId, message);
        success++;
      } catch (error) {
        failed++;
        console.error(`❌ Failed to send to ${user.userId}:`, error.message);
      }
    }

    await ctx.reply(`✅ ব্রডকাস্ট শেষ!\n✅ সফল: ${success}\n❌ ব্যর্থ: ${failed}`);
  } catch (error) {
    console.error('❌ Error in /broadcast:', error);
    await ctx.reply('❌ ব্রডকাস্ট করতে সমস্যা: ' + error.message);
  }
});

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

// =============================================
// 🚨 জরুরি ডায়াগনস্টিক কমান্ড - ১০০% কাজ করবে
// =============================================

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

app.post('/api/unlock-topic', async (req, res) => {
  try {
    const { userId, topicId } = req.body;
    console.log(`🔓 Unlocking topic ${topicId} for user ${userId}`);
    
    const userRef = db.collection('users').doc(userId.toString());
    const doc = await userRef.get();
    
    let unlockedTopics = [];
    let topicUnlockTime = {};
    let sentMessages = [];
    if (doc.exists) {
      const data = doc.data();
      unlockedTopics = data.unlockedTopics || [];
      topicUnlockTime = data.topicUnlockTime || {};
      sentMessages = data.sentMessages || [];
    }
    
    const now = Date.now();
    const THIRTY_MINUTES = 30 * 60 * 1000;
    
    if (!unlockedTopics.includes(topicId)) {
      unlockedTopics.push(topicId);
      topicUnlockTime[topicId] = now;
    }
    
    await userRef.set({
      unlockedTopics: unlockedTopics,
      topicUnlockTime: topicUnlockTime
    }, { merge: true });
    
    const topicRef = db.collection('topics').doc(topicId);
    const topicDoc = await topicRef.get();
    
    let videosDelivered = 0;
    if (topicDoc.exists) {
      const topicData = topicDoc.data();
      const videos = topicData.videos || [];
      console.log(`📹 Sending ${videos.length} videos to user ${userId}`);
      
      for (const videoId of videos) {
        try {
          const sentMsg = await bot.telegram.sendVideo(userId, videoId, {
            protect_content: true,
            caption: '⏳ এই ভিডিও ৩০ মিনিট পর ডিলিট হয়ে যাবে।'
          });
          
          sentMessages.push({
            messageId: sentMsg.message_id,
            chatId: userId,
            videoId: videoId,
            sentAt: Date.now()
          });
          
          videosDelivered++;
          console.log(`✅ Video sent to ${userId}`);
        } catch (sendError) {
          console.error(`❌ Error sending video:`, sendError.message);
        }
      }
      
      await userRef.set({ sentMessages: sentMessages }, { merge: true });
    }
    
    res.json({ success: true, videosDelivered });
  } catch (error) {
    console.error('Unlock error:', error);
    res.status(500).json({ error: error.message });
  }
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
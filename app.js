(function() {
    'use strict';
    
    console.log('App.js started');
    
    let Telegram = null;
    try {
        Telegram = window.Telegram.WebApp;
        Telegram.ready();
        console.log('Telegram WebApp ready');
    } catch (e) {
        console.log('Telegram WebApp not available');
        Telegram = { initDataUnsafe: { user: null } };
    }

    const API_BASE = '/api';
    let topics = [];
    let userData = null;
    let currentTopic = null;

    function getUserId() {
        try {
            if (Telegram && Telegram.initDataUnsafe && Telegram.initDataUnsafe.user) {
                return Telegram.initDataUnsafe.user.id;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    function getUserName() {
        try {
            if (Telegram && Telegram.initDataUnsafe && Telegram.initDataUnsafe.user) {
                return Telegram.initDataUnsafe.user.first_name || 'ইউজার';
            }
            return 'ইউজার';
        } catch (e) {
            return 'ইউজার';
        }
    }

    async function init() {
        try {
            const name = getUserName();
            document.getElementById('user-name').textContent = name;
            await loadTopics();
            await loadUserStatus();
        } catch (error) {
            console.error('Init error:', error);
            document.getElementById('loading').textContent = '❌ লোড করতে সমস্যা হয়েছে';
        }
    }

    async function loadTopics() {
        try {
            const response = await fetch(`${API_BASE}/topics`);
            if (!response.ok) throw new Error('Network error');
            const data = await response.json();
            console.log('Topics loaded:', data.length);
            topics = data;
            renderTopics();
        } catch (error) {
            console.error('Error loading topics:', error);
            document.getElementById('loading').textContent = '❌ টপিক লোড করতে সমস্যা হয়েছে';
        }
    }

    async function loadUserStatus() {
        try {
            const userId = getUserId();
            if (!userId) {
                console.log('No user ID found');
                return;
            }
            const response = await fetch(`${API_BASE}/users/verify/${userId}`);
            userData = await response.json();
            console.log('User data loaded:', userData);
            renderTopics();
        } catch (error) {
            console.error('Error loading user status:', error);
        }
    }

    function getThumbnailUrl(topic) {
        if (topic.thumbnail) {
            return `${API_BASE}/thumbnail/${topic.thumbnail}`;
        }
        if (topic.thumbnails && topic.thumbnails.length > 0) {
            return `${API_BASE}/thumbnail/${topic.thumbnails[0]}`;
        }
        return null;
    }

    function renderTopics() {
        const grid = document.getElementById('topic-grid');
        const loading = document.getElementById('loading');
        
        if (!topics || topics.length === 0) {
            loading.textContent = '📭 এখনো কোনো টপিক যোগ করা হয়নি';
            return;
        }
        
        loading.style.display = 'none';
        grid.innerHTML = '';
        
        const isUnlocked = userData && userData.verified === true;
        
        topics.forEach(topic => {
            const card = document.createElement('div');
            card.className = 'topic-card';
            const thumbUrl = getThumbnailUrl(topic);
            const videoCount = topic.videoCount || (topic.videos ? topic.videos.length : 0);
            
            card.innerHTML = `
                <div class="thumbnail" style="position:relative; background:#2a2a2a; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; font-size:40px; overflow:hidden;">
                    ${thumbUrl ? `<img src="${thumbUrl}" alt="${topic.title || 'টপিক'}" style="width:100%; height:100%; object-fit:cover;" onerror="this.parentElement.innerHTML='<span style=\\'font-size:40px;\\'>📹</span>'">` : '📹'}
                    <div class="lock-icon" style="position:absolute; top:8px; right:8px; background:rgba(0,0,0,0.7); border-radius:50%; width:28px; height:28px; display:flex; align-items:center; justify-content:center; font-size:14px; color:white;">
                        ${isUnlocked ? '🔓' : '🔒'}
                    </div>
                    <div style="position:absolute; bottom:8px; left:8px; background:rgba(0,0,0,0.7); border-radius:4px; padding:2px 8px; font-size:11px; color:#fff;">
                        📹 ${videoCount}
                    </div>
                </div>
                <div class="topic-info" style="padding:10px 12px;">
                    <div class="topic-title" style="font-size:14px; font-weight:600; color:#fff;">${topic.title || 'নামবিহীন টপিক'}</div>
                    <div class="topic-meta" style="font-size:12px; color:#888; margin-top:4px;">🔢 ${topic.adsRequired || 0}টি অ্যাড দেখে আনলক করুন</div>
                </div>
            `;
            
            card.addEventListener('click', () => openTopic(topic));
            grid.appendChild(card);
        });
    }

    function openTopic(topic) {
        currentTopic = topic;
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const description = document.getElementById('modal-description');
        const actionBtn = document.getElementById('modal-action-btn');
        
        title.textContent = topic.title || 'টপিক';
        const videoCount = topic.videoCount || (topic.videos ? topic.videos.length : 0);
        const adsRequired = topic.adsRequired || 0;
        
        description.innerHTML = `
            📹 ${videoCount}টি ভিডিও<br>
            🔢 ${adsRequired}টি অ্যাড দেখে আনলক করুন
        `;
        
        const isUnlocked = userData && userData.verified === true;
        
        if (isUnlocked) {
            actionBtn.textContent = '✅ আনলক করা আছে';
            actionBtn.className = 'btn-primary unlocked';
            actionBtn.disabled = true;
            actionBtn.style.background = '#22c55e';
            actionBtn.style.color = '#fff';
        } else {
            actionBtn.textContent = `🎬 ${adsRequired}টি অ্যাড দেখে আনলক করুন`;
            actionBtn.className = 'btn-primary watch-ad';
            actionBtn.disabled = false;
            actionBtn.style.background = '#dc2626';
            actionBtn.style.color = '#fff';
            actionBtn.onclick = () => watchAd(topic);
        }
        
        modal.classList.add('show');
    }

    async function watchAd(topic) {
        if (window.__watchingAd) return;
        window.__watchingAd = true;
        const actionBtn = document.getElementById('modal-action-btn');
        const adsRequired = Math.max(1, Number(topic.adsRequired) || 1);
        actionBtn.disabled = true;
        actionBtn.textContent = '⏳ Ad প্রস্তুত হচ্ছে...';
        try {
            const startRes = await fetch(`${API_BASE}/ad-start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: getUserId(), topicId: topic.id })
            });
            const startData = await startRes.json();
            if (!startData.success) throw new Error(startData.error || 'Ad শুরু করা যায়নি');

            const adFn = window.show_11737734;
            if (typeof adFn !== 'function') throw new Error('Ad এখনো প্রস্তুত নয়। একটু পর আবার চেষ্টা করুন।');
            const startedAt = Date.now();
            await Promise.resolve(adFn());
            const wait = Math.max(0, 10000 - (Date.now() - startedAt));
            if (wait) await new Promise(resolve => setTimeout(resolve, wait));

            const completeRes = await fetch(`${API_BASE}/ad-complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: getUserId(), topicId: topic.id, token: startData.token })
            });
            const data = await completeRes.json();
            if (!completeRes.ok || !data.success) throw new Error(data.error || 'Ad count হয়নি');

            actionBtn.textContent = data.unlocked ? '✅ আনলক হয়েছে' : `(${data.count}/${data.required}) Ads`;
            actionBtn.disabled = !!data.unlocked;
            if (data.unlocked) await loadUserStatus();
        } catch (e) {
            console.error('Ad/unlock error:', e);
            actionBtn.disabled = false;
            actionBtn.textContent = `🎬 ${adsRequired}টি অ্যাড দেখে আনলক করুন`;
            if (Telegram && Telegram.showAlert) Telegram.showAlert(e.message || 'Ad সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।');
        } finally {
            window.__watchingAd = false;
        }
    }

    document.querySelector('.close-btn').addEventListener('click', () => {
        document.getElementById('modal').classList.remove('show');
    });

    document.getElementById('modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            document.getElementById('modal').classList.remove('show');
        }
    });

    setTimeout(init, 100);
})();
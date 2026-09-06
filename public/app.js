const Telegram = window.Telegram.WebApp;
Telegram.ready();

const API_BASE = 'http://localhost:3000/api';

let topics = [];
let userData = null;
let currentTopic = null;

async function init() {
    try {
        const user = Telegram.initDataUnsafe.user;
        if (user) {
            document.getElementById('user-name').textContent = user.first_name || 'ইউজার';
        }
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
        topics = await response.json();
        renderTopics();
    } catch (error) {
        console.error('Error loading topics:', error);
        document.getElementById('loading').textContent = '❌ টপিক লোড করতে সমস্যা হয়েছে';
    }
}

async function loadUserStatus() {
    try {
        const userId = Telegram.initDataUnsafe.user?.id;
        if (!userId) return;
        const response = await fetch(`${API_BASE}/users/verify/${userId}`);
        userData = await response.json();
    } catch (error) {
        console.error('Error loading user status:', error);
    }
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
    
    topics.forEach(topic => {
        const card = document.createElement('div');
        card.className = 'topic-card';
        
        const isUnlocked = userData?.verified && true;
        
        card.innerHTML = `
            <div class="thumbnail">
                <img src="https://via.placeholder.com/300x169/2a2a2a/888?text=${encodeURIComponent(topic.title?.charAt(0) || '📹')}" alt="${topic.title || 'টপিক'}">
                <div class="lock-icon ${isUnlocked ? 'unlocked' : ''}">
                    ${isUnlocked ? '🔓' : '🔒'}
                </div>
            </div>
            <div class="topic-info">
                <div class="topic-title">${topic.title || 'নামবিহীন টপিক'}</div>
                <div class="topic-meta">📹 ${topic.videoCount || 0}টি ভিডিও • 🔢 ${topic.adsRequired || 0}টি অ্যাড</div>
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
    description.innerHTML = `
        📹 ${topic.videoCount || 0}টি ভিডিও<br>
        🔢 ${topic.adsRequired || 0}টি অ্যাড দেখে আনলক করুন
    `;
    
    const isUnlocked = userData?.verified && true;
    
    if (isUnlocked) {
        actionBtn.textContent = '✅ আনলক করা আছে';
        actionBtn.className = 'btn-primary unlocked';
        actionBtn.disabled = true;
    } else {
        actionBtn.textContent = `🎬 ${topic.adsRequired || 0}টি অ্যাড দেখে আনলক করুন`;
        actionBtn.className = 'btn-primary watch-ad';
        actionBtn.disabled = false;
        actionBtn.onclick = () => watchAd(topic);
    }
    
    modal.classList.add('show');
}

function watchAd(topic) {
    alert(`📢 ${topic.adsRequired || 0}টি অ্যাড দেখুন (Adsgram ইন্টিগ্রেশন পরে আসছে)`);
}

document.querySelector('.close-btn').addEventListener('click', () => {
    document.getElementById('modal').classList.remove('show');
});

document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        document.getElementById('modal').classList.remove('show');
    }
});

init();
const express = require('express');
const path = require('path');
const { createClient } = require('redis');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || '';
const LEADERBOARD_KEY = 'news_typing_leaderboard_v1';
const MAX_ENTRIES = 30;

/* ---------------- Redis (leaderboard storage) ---------------- */
let redisClient = null;
let memoryFallback = [];

async function getRedis() {
  if (!REDIS_URL) return null;
  try {
    if (redisClient && redisClient.isOpen) return redisClient;
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis error:', err.message));
    await redisClient.connect();
    return redisClient;
  } catch (e) {
    console.error('Redis connect failed:', e.message);
    return null;
  }
}

app.get('/api/leaderboard', async (req, res) => {
  try {
    const client = await getRedis();
    if (client) {
      const raw = await client.get(LEADERBOARD_KEY);
      return res.json(raw ? JSON.parse(raw) : []);
    }
    res.json(memoryFallback);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed to load leaderboard' });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { name, cpm, acc, time, title } = req.body || {};
    if (!name || typeof cpm !== 'number' || typeof acc !== 'number') {
      return res.status(400).json({ error: 'invalid payload' });
    }
    const entry = {
      name: String(name).trim().slice(0, 20) || '무명의 기자',
      cpm: Math.max(0, Math.round(cpm)),
      acc: Math.max(0, Math.min(100, Math.round(acc))),
      time: typeof time === 'number' ? Math.round(time * 10) / 10 : 0,
      title: title ? String(title).slice(0, 30) : '',
      playedAt: Date.now(),
    };

    const client = await getRedis();
    let list;
    if (client) {
      const raw = await client.get(LEADERBOARD_KEY);
      list = raw ? JSON.parse(raw) : [];
      list.push(entry);
      list.sort((a, b) => b.cpm - a.cpm || b.acc - a.acc);
      list = list.slice(0, MAX_ENTRIES);
      await client.set(LEADERBOARD_KEY, JSON.stringify(list));
    } else {
      memoryFallback.push(entry);
      memoryFallback.sort((a, b) => b.cpm - a.cpm || b.acc - a.acc);
      memoryFallback = memoryFallback.slice(0, MAX_ENTRIES);
      list = memoryFallback;
    }
    res.json({ ok: true, entry, leaderboard: list.slice(0, 10) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed to save score' });
  }
});

/* ---------------- Daily news (server-side fetch, no CORS issues) ---------------- */
const FALLBACK_NEWS = [
  { tag: '사회', text: '경남 가뭄에 국가소방동원령이 발령됐다. 저수율이 33%까지 떨어져 전국에서 물탱크차 200대가 투입됐다.' },
  { tag: '안보', text: '합동참모본부는 북한이 동쪽 방향으로 미상의 발사체를 발사했다고 밝혔다.' },
  { tag: '국제', text: '이란이 호르무즈 해협을 열려면 동결 자금부터 풀어야 한다고 주장했다. 후티 반군까지 가세하며 홍해 정세에도 먹구름이 꼈다.' },
  { tag: '국제', text: '젤렌스키 대통령은 러시아가 북한산 탄도미사일로 자포리자를 공격해 6명이 숨졌다고 밝혔다.' },
  { tag: '국제', text: '콜롬비아에서 발생한 강진으로 사망자가 164명, 부상자가 570명에 달했다.' },
  { tag: '경제', text: '삼성전자는 로봇 도입 효과로 주가가 상승한 반면, SK하이닉스는 HBM 관련 이슈로 상대적으로 부진한 흐름을 보였다.' },
  { tag: '경제', text: '한국은행 부총재는 특별한 충격이 없다면 기준금리를 추가로 인상할 수 있다고 말했다.' },
  { tag: '정치', text: '서울시장 선거에 대한 선거소청이 기각됐다. 선관위는 이번 판단이 선거 결과에 영향을 주지 않는다고 밝혔다.' },
  { tag: '정치', text: '김윤덕 국토교통부 장관은 그린벨트를 해제해 주택 공급을 확대하겠다는 의지를 밝혔다.' },
  { tag: '화제', text: '경기 광교에서 한 달 전 잃어버렸던 1미터 크기의 나일왕도마뱀 주인이 마침내 나타났다.' },
];

const xmlParser = new XMLParser({ ignoreAttributes: false });
const RSS_FEEDS = [
  'https://www.yna.co.kr/rss/news.xml',
  'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko',
];

function stripHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFeed(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 7000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsTypingGame/1.0)' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    const data = xmlParser.parse(xml);
    const rawItems = data?.rss?.channel?.item || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    const cleaned = [];
    for (const it of items) {
      const title = stripHtml(it?.title);
      let desc = stripHtml(it?.description);
      if (!title) continue;
      let text = desc && desc !== title && desc.length > 8 ? `${title}. ${desc}` : title;
      if (text.length > 120) text = text.slice(0, 120).trim() + '…';
      if (text.length < 12) continue;
      const tag = (it?.category && typeof it.category === 'string' ? it.category : '오늘의뉴스').toString().slice(0, 10);
      cleaned.push({ tag, text });
      if (cleaned.length >= 10) break;
    }
    if (cleaned.length < 6) throw new Error('too few valid items');
    return cleaned;
  } finally {
    clearTimeout(t);
  }
}

let newsCache = { items: null, source: null, fetchedAt: 0 };
const NEWS_CACHE_MS = 30 * 60 * 1000; // 30분 캐시

app.get('/api/news', async (req, res) => {
  const now = Date.now();
  if (newsCache.items && now - newsCache.fetchedAt < NEWS_CACHE_MS) {
    return res.json({ source: newsCache.source, items: newsCache.items });
  }
  for (const feedUrl of RSS_FEEDS) {
    try {
      const items = await fetchFeed(feedUrl);
      newsCache = { items, source: 'live', fetchedAt: now };
      return res.json({ source: 'live', items });
    } catch (e) {
      console.warn('feed failed:', feedUrl, e.message);
    }
  }
  newsCache = { items: FALLBACK_NEWS, source: 'fallback', fetchedAt: now };
  res.json({ source: 'fallback', items: FALLBACK_NEWS });
});

app.listen(PORT, () => console.log(`news-typing-game server listening on ${PORT}`));

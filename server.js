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
  { tag: '정치', text: '이재명 대통령은 경찰의 수사 전권에 대한 우려를 언급하며 범죄 피해자 대책을 다시 검토하라고 지시했다.' },
  { tag: '사회', text: '서울 가양동의 한 아파트에서 화재가 발생해 뇌병변 장애가 있는 어머니와 아들이 숨졌다.' },
  { tag: '경제', text: '코스피가 삼성전자와 SK하이닉스의 동반 상승에 힘입어 매수 사이드카가 발동됐다.' },
  { tag: '사회', text: '복날을 앞두고 개고기 판매 금지를 하루 앞둔 업주들 사이에서는 생계 걱정이 커지고 있다.' },
  { tag: '국제', text: '미국에서는 전쟁 장기화 여파로 고용의 질적 저하가 나타나고 있으며, 이는 기준금리 결정에 영향을 줄 수 있다는 분석이 나온다.' },
  { tag: '정치', text: '더불어민주당은 메가 프로젝트 뒷받침에 총력을 기울이고 있으며, 국민의힘은 재정 레버리지에 대한 우려를 제기했다.' },
  { tag: '사회', text: '수면 마취 뒤 느닷없이 달아난 30대가 1년 동안 프로포폴 등을 140여 차례 처방받은 정황이 드러났다.' },
  { tag: '건강', text: '고혈압과 당뇨를 앓고 담배를 피우는 중년층은 치매 발병 시점이 평균 12.6년 더 빠른 것으로 나타났다.' },
  { tag: '사회', text: '청년 취업자 수가 45개월째 감소하는 가운데, 전체 취업자 수는 한 달 새 10만 명 늘었다.' },
  { tag: '정치', text: '정부는 광복 100주년을 향한 2045 국가전략 수립에 속도를 내고 있다.' },
];

const MAX_NEWS_COUNT = 20;
const MIN_NEWS_COUNT = 5;

const xmlParser = new XMLParser({ ignoreAttributes: false });
// CJK 한자(漢字) 유니코드 범위 — 이 범위에 해당하는 문자가 하나라도 있으면 해당 뉴스는 사용하지 않음
const HANJA_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
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

async function fetchFeed(url, limit) {
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
      let text = stripHtml(it?.title); // 본문·기자이름 없이 헤드라인 한 줄만 사용
      if (!text) continue;
      if (HANJA_REGEX.test(text)) continue; // 한자 포함된 뉴스는 제외
      if (text.length > 120) text = text.slice(0, 120).trim() + '…';
      if (text.length < 8) continue;
      const tag = (it?.category && typeof it.category === 'string' ? it.category : '오늘의뉴스').toString().slice(0, 10);
      cleaned.push({ tag, text });
      if (cleaned.length >= limit) break;
    }
    if (cleaned.length < Math.min(6, limit)) throw new Error('too few valid items');
    return cleaned;
  } finally {
    clearTimeout(t);
  }
}

let newsCache = { items: null, source: null, dayKey: null, fetchedAt: 0 };

// 한국시간(KST) 기준 "오늘의 뉴스" 갱신 주기: 매일 오전 9시.
// 오전 9시 이전 접속은 전날 9시에 받아온 뉴스를 그대로 재사용하고,
// 오전 9시가 지난 뒤 첫 요청이 들어오면 그때 새로 한 번만 가져온다.
function getKstParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) };
}

function currentNewsDayKey(date = new Date()) {
  const { dateKey, hour } = getKstParts(date);
  if (hour >= 9) return dateKey;
  const yesterday = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return getKstParts(yesterday).dateKey;
}

app.get('/api/news', async (req, res) => {
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count)) count = MAX_NEWS_COUNT;
  count = Math.max(MIN_NEWS_COUNT, Math.min(MAX_NEWS_COUNT, count));

  const todayKey = currentNewsDayKey();
  if (newsCache.items && newsCache.dayKey === todayKey) {
    return res.json({ source: newsCache.source, items: newsCache.items.slice(0, count) });
  }
  for (const feedUrl of RSS_FEEDS) {
    try {
      const items = await fetchFeed(feedUrl, MAX_NEWS_COUNT);
      newsCache = { items, source: 'live', dayKey: todayKey, fetchedAt: Date.now() };
      return res.json({ source: 'live', items: items.slice(0, count) });
    } catch (e) {
      console.warn('feed failed:', feedUrl, e.message);
    }
  }
  newsCache = { items: FALLBACK_NEWS, source: 'fallback', dayKey: todayKey, fetchedAt: Date.now() };
  res.json({ source: 'fallback', items: FALLBACK_NEWS.slice(0, count) });
});

app.listen(PORT, () => console.log(`news-typing-game server listening on ${PORT}`));

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

// 전체 랭킹 초기화. RESET_KEY 환경변수와 일치하는 key 쿼리파라미터로만 접근 가능.
// 브라우저 주소창에 바로 붙여넣어 쓸 수 있도록 GET으로 만들었고, 결과도 HTML로 보여줌.
app.get('/api/leaderboard/reset', async (req, res) => {
  const provided = req.query.key;
  if (!process.env.RESET_KEY || provided !== process.env.RESET_KEY) {
    return res.status(403).send('<p style="font-family:sans-serif">접근 권한이 없어요.</p>');
  }
  try {
    const client = await getRedis();
    if (client) await client.del(LEADERBOARD_KEY);
    memoryFallback = [];
    res.send('<p style="font-family:sans-serif">랭킹이 초기화됐어요. <a href="/">메인으로 돌아가기</a></p>');
  } catch (e) {
    console.error(e);
    res.status(500).send('<p style="font-family:sans-serif">초기화 중 오류가 발생했어요.</p>');
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
].map((it) => ({ ...it, title: it.text, link: null })); // 실시간 기사가 아니므로 원문 링크는 없음

const MAX_NEWS_COUNT = 10;
const MIN_NEWS_COUNT = 5;

const xmlParser = new XMLParser({ ignoreAttributes: false });
// CJK 한자(漢字) 유니코드 범위 — 이 범위에 해당하는 문자가 하나라도 있으면 해당 뉴스는 사용하지 않음
const HANJA_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
// 1순위: JTBC의 "오늘의 주요 이슈" 피드. 이미 중요도순으로 큐레이션된 피드라
// 분야별로 나눠 인터리빙할 필요 없이 순서 그대로 사용한다.
const ISSUE_FEED = { key: 'issue', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/issue', useSummary: true, tag: '오늘의 이슈' };
// 2순위: 이슈 피드가 실패했을 때 쓰는 JTBC 분야별 RSS (정치/경제/사회/국제/문화/연예/스포츠에서 골고루)
// key는 프런트엔드의 뉴스 분야 선택 버튼(data-category)과 그대로 매칭된다.
const CATEGORY_FEEDS = [
  { key: 'politics', tag: '정치', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/politics' },
  { key: 'economy', tag: '경제', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/economy' },
  { key: 'society', tag: '사회', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/society' },
  { key: 'international', tag: '국제', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/international' },
  { key: 'culture', tag: '문화', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/culture' },
  { key: 'entertainment', tag: '연예', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/entertainment' },
  { key: 'sports', tag: '스포츠', url: 'https://news-ex.jtbc.co.kr/v1/get/rss/section/sports' },
];
const CATEGORY_LOOKUP = CATEGORY_FEEDS.reduce((acc, f) => { acc[f.key] = f; return acc; }, {});
// 사용자가 뉴스 분야를 직접 고를 수 있는 선택지. 'issue'는 기존의 다단계 폴백 체인을 그대로 쓰고,
// 나머지는 해당 분야 RSS 하나만 사용한다.
const CATEGORY_KEYS = ['issue', ...CATEGORY_FEEDS.map((f) => f.key)];
// 3순위: 그마저도 대부분 실패했을 때 쓰는 연합뉴스 전체기사 피드
const ALL_NEWS_FEED = { url: 'https://www.yna.co.kr/rss/news.xml', useSummary: true };
// 4순위: 그마저도 실패하면 구글뉴스 (description이 지저분해서 요약 추출은 포기하고 헤드라인만 사용)
const GOOGLE_NEWS_FEED = { url: 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', useSummary: false };

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'");
}

function stripHtml(s) {
  return decodeEntities(
    String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// description에서 기자 바이라인·저작권 문구를 걷어내고 첫 문장 하나만 뽑아낸다.
// 실패하거나 결과가 너무 짧으면 null을 반환해서 호출부가 헤드라인으로 대체하게 한다.
function extractSummarySentence(rawDescription) {
  let desc = stripHtml(rawDescription);
  if (!desc) return null;

  // 맨 앞에 붙는 [앵커], [기자], [단독], [속보] 같은 대괄호 태그 제거 (방송사 스크립트 형식 대응)
  desc = desc.replace(/^(\[[^\]]{1,6}\]\s*)+/, '');
  // "(서울=연합뉴스) 홍길동 기자 = " 또는 "홍길동 기자 = " 같은 바이라인 접두부 제거 (지역=매체 표시는 있어도 없어도 됨)
  desc = desc.replace(/^(\([^)]{0,25}\)\s*)?[가-힣]{2,6}\s*(기자|앵커|특파원|통신원)\s*=\s*/, '');
  // 꼬리에 붙는 저작권/재배포 금지 문구는 그 지점부터 잘라냄
  desc = desc.split(/저작권자|무단\s*전재|재배포\s*금지/)[0].trim();
  if (!desc) return null;

  const match = desc.match(/^(.{10,140}?[.!?」』])(\s|$)/);
  let sentence = match ? match[1] : desc.slice(0, 120).trim();
  sentence = sentence.trim();
  if (sentence.length < 10) return null;
  if (!/[.!?」』]$/.test(sentence)) sentence += '.';
  return sentence;
}

async function fetchFeed(feedUrl, useSummary, limit) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 7000);
  try {
    const r = await fetch(feedUrl, {
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
      if (!title) continue;

      let text = null;
      if (useSummary) {
        text = extractSummarySentence(it?.description);
      }
      if (!text) text = title; // 요약을 못 뽑으면 헤드라인으로 대체

      if (HANJA_REGEX.test(text) || HANJA_REGEX.test(title)) continue; // 한자 포함된 뉴스는 제외
      if (text.length > 120) text = text.slice(0, 120).trim() + '…';
      if (text.length < 8) continue;

      const link = stripHtml(it?.link);
      const tag = (it?.category && typeof it.category === 'string' ? it.category : '오늘의뉴스').toString().slice(0, 10);
      cleaned.push({ tag, text, title, link: link || null });
      if (cleaned.length >= limit) break;
    }
    if (cleaned.length < Math.min(6, limit)) throw new Error('too few valid items');
    return cleaned;
  } finally {
    clearTimeout(t);
  }
}

// 여러 분야 리스트를 한 분야씩 번갈아 섞는다. 5개만 뽑아도 한 분야로 쏠리지 않게 하기 위함.
function interleave(lists) {
  const result = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const l of lists) {
      if (l[i]) result.push(l[i]);
    }
  }
  return result;
}

async function fetchCategoryPool(limitTotal) {
  const perCategoryLimit = 6;
  const settled = await Promise.allSettled(
    CATEGORY_FEEDS.map((cat) =>
      fetchFeed(cat.url, true, perCategoryLimit).then((items) =>
        items.map((it) => ({ ...it, tag: cat.tag })) // RSS 자체 카테고리값 대신 우리가 정한 분야명으로 통일
      )
    )
  );

  const lists = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length) {
      lists.push(r.value);
    } else if (r.status === 'rejected') {
      console.warn('category feed failed:', CATEGORY_FEEDS[i].url, r.reason?.message);
    }
  });

  const merged = interleave(lists);
  if (merged.length < 6) throw new Error('category pool too small (' + merged.length + ' items from ' + lists.length + ' categories)');
  return merged.slice(0, limitTotal);
}

// 분야(category)별로 따로 캐시한다. 키는 CATEGORY_KEYS 중 하나.
const newsCacheByCategory = new Map();

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

// '실시간 주요이슈' 분야: 이슈 피드 -> 분야별 혼합 -> 연합뉴스 전체 -> 구글뉴스 -> 정적 폴백, 기존 다단계 체인 그대로.
async function fetchIssueChain() {
  const attempts = [
    {
      name: 'issue-feed',
      run: () =>
        fetchFeed(ISSUE_FEED.url, ISSUE_FEED.useSummary, MAX_NEWS_COUNT).then((items) =>
          items.map((it) => ({ ...it, tag: ISSUE_FEED.tag }))
        ),
    },
    { name: 'category-pool', run: () => fetchCategoryPool(MAX_NEWS_COUNT) },
    { name: 'all-news', run: () => fetchFeed(ALL_NEWS_FEED.url, ALL_NEWS_FEED.useSummary, MAX_NEWS_COUNT) },
    { name: 'google-news', run: () => fetchFeed(GOOGLE_NEWS_FEED.url, GOOGLE_NEWS_FEED.useSummary, MAX_NEWS_COUNT) },
  ];
  for (const attempt of attempts) {
    try {
      const items = await attempt.run();
      return { items, source: 'live' };
    } catch (e) {
      console.warn(`news source failed (${attempt.name}):`, e.message);
    }
  }
  return { items: FALLBACK_NEWS, source: 'fallback' };
}

// 정치/경제/사회/국제/문화/연예/스포츠: 해당 분야 RSS 하나만 사용하고,
// 실패하면 (분야가 섞인) 정적 폴백으로 대체한다. 실시간 여부는 source 값으로 프런트에 그대로 알려준다.
async function fetchSingleCategoryChain(categoryKey) {
  const feed = CATEGORY_LOOKUP[categoryKey];
  try {
    const items = (await fetchFeed(feed.url, true, MAX_NEWS_COUNT)).map((it) => ({ ...it, tag: feed.tag }));
    return { items, source: 'live' };
  } catch (e) {
    console.warn(`news source failed (category:${categoryKey}):`, e.message);
  }
  return { items: FALLBACK_NEWS, source: 'fallback' };
}

app.get('/api/news', async (req, res) => {
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count)) count = MAX_NEWS_COUNT;
  count = Math.max(MIN_NEWS_COUNT, Math.min(MAX_NEWS_COUNT, count));

  let category = req.query.category;
  if (!CATEGORY_KEYS.includes(category)) category = 'issue';

  const todayKey = currentNewsDayKey();
  const cached = newsCacheByCategory.get(category);
  if (cached && cached.items && cached.dayKey === todayKey) {
    return res.json({ source: cached.source, category, items: cached.items.slice(0, count) });
  }

  const result = category === 'issue' ? await fetchIssueChain() : await fetchSingleCategoryChain(category);
  newsCacheByCategory.set(category, { items: result.items, source: result.source, dayKey: todayKey, fetchedAt: Date.now() });
  res.json({ source: result.source, category, items: result.items.slice(0, count) });
});

app.listen(PORT, () => console.log(`news-typing-game server listening on ${PORT}`));

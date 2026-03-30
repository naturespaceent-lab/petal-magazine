#!/usr/bin/env node

/**
 * PETAL Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-pop girl group news sites,
 * extracts article data, fetches full article content,
 * and generates self-contained static HTML pages.
 * PETAL — K-POP Girl Group Magazine (Japanese, non-no/ar style)
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
  // === Tier 4: Japanese K-pop media ===
  { name: 'WowKoreaEnt', url: 'https://www.wowkorea.jp/rss/rss_ent.xml', lang: 'ja' },
  { name: 'WowKorea', url: 'https://www.wowkorea.jp/rss/rss_all.xml', lang: 'ja' },
  { name: 'Danmee', url: 'https://danmee.jp/feed/', lang: 'ja' },
  { name: 'KPOPMONSTER', url: 'https://kpopmonster.jp/feed/', lang: 'ja' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/petal-placeholder/800/450';

const log = (msg) => console.log(`[PETAL Crawler] ${msg}`);
const warn = (msg) => console.warn(`[PETAL Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting
// ============================================================

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const dd = d.getDate();
    return `${yyyy}年${mm}月${dd}日`;
  } catch {
    return '';
  }
}

// ============================================================
// REWRITE ENGINE — "Same event, different perspective"
// Transforms ALL titles to PETAL editorial tone in Japanese
// Girl group focused, feminine magazine style (non-no/ar)
// ============================================================

// ---- Known K-pop group / artist names for extraction ----

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Rosé', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

// Build a sorted-by-length-desc list for greedy matching
const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Boy groups / male soloists — filter these out of sidebar/related in PETAL (girls magazine) ----
const BOY_GROUP_NAMES = new Set([
  'BTS', 'EXO', 'NCT', 'Stray Kids', 'ENHYPEN', 'TXT', 'ATEEZ', 'SEVENTEEN',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', 'BIGBANG', 'Super Junior', 'SHINee',
  'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ', 'Golden Child', 'ONEUS', 'VERIVERY',
  'CIX', 'VICTON', 'AB6IX', 'WEi', 'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE',
  'Xdinary Heroes', 'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers',
  'NCT 127', 'NCT DREAM', 'WayV', 'NCT WISH', 'DAY6', 'ASTRO', 'INFINITE',
  'BEAST', 'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'TREASURE', 'Super M', 'EXO-CBX',
]);
const BOY_SOLOIST_NAMES = new Set([
  'V', 'Jungkook', 'Suga', 'RM', 'J-Hope', 'Jin', 'Jimin',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'Zico', 'Cha Eun Woo',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Park Bo Gum', 'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun',
  'Park Seo Joon', 'Jung Hae In', 'Yoo Yeon Seok',
]);

function isBoyGroupArticle(article) {
  const title = article.originalTitle || article.title || '';
  const artist = extractArtist(title);
  if (artist && (BOY_GROUP_NAMES.has(artist) || BOY_SOLOIST_NAMES.has(artist))) return true;
  return false;
}

// ---- Topic classifier keyword map ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  drama:        ['drama', 'movie', 'film', 'acting', 'kdrama', 'k-drama', 'episode', 'season'],
  dating:       ['dating', 'couple', 'relationship', 'romantic', 'wedding', 'married', 'love'],
  military:     ['military', 'enlistment', 'discharge', 'service', 'army', 'enlisted', 'discharged'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  controversy:  ['controversy', 'scandal', 'apologize', 'apology', 'accused', 'allegations', 'lawsuit', 'bullying'],
  mv:           ['mv', 'music video', 'teaser', 'm/v', 'visual', 'concept photo'],
  interview:    ['interview', 'exclusive', 'reveals', 'talks about', 'opens up'],
  photo:        ['photo', 'pictorial', 'magazine', 'photoshoot', 'selfie', 'selca', 'photobook', 'cover'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  fan:          ['fan', 'fandom', 'fanmeeting', 'fan meeting', 'lightstick', 'fanclub'],
  trending:     ['trending', 'viral', 'reaction', 'meme', 'goes viral', 'buzz'],
  health:       ['health', 'injury', 'hospital', 'recover', 'surgery', 'hiatus', 'rest'],
  contract:     ['contract', 'agency', 'sign', 'renewal', 'renew', 'leave', 'departure', 'new agency'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  performance:  ['cover', 'performance', 'dance practice', 'choreography', 'stage', 'perform'],
};

// ---- Title templates per topic ----

const TITLE_TEMPLATES = {
  comeback: [
    '{artist}の新章が始まる — 待望のカムバック情報まとめ',
    '帰ってきた{artist} — 新曲の魅力を徹底解剖',
    '{artist}カムバック速報 — ビジュアルからコンセプトまで',
  ],
  chart: [
    '{artist}がチャートを席巻 — 記録更新の快進撃',
    '止まらない{artist} — 最新チャート成績まとめ',
  ],
  release: [
    '{artist}の新曲が届けるメッセージとは',
    'いま聴きたい{artist}の新作をチェック',
    '{artist}ニューリリース — ファン必見の注目ポイント',
  ],
  concert: [
    '{artist}のステージに夢中 — ライブレポート',
    'あの瞬間をもう一度 — {artist}コンサートハイライト',
    '{artist}ツアー情報 — 会場で感じる特別な時間',
  ],
  fashion: [
    '{artist}のスタイルブック — 真似したいコーデ集',
    'トレンドを作る{artist}のファッション哲学',
    '{artist}が選ぶ今季のマストバイアイテム',
  ],
  drama: [
    '{artist}出演のドラマが話題沸騰',
    '{artist}の演技力に注目が集まる',
    '{artist}、映像作品で新たな一面を披露',
  ],
  dating: [
    '{artist}の恋愛報道、真相に迫る',
    '{artist}、プライベートに注目が集まる',
  ],
  military: [
    '{artist}の兵役に関する最新情報',
    '{artist}の除隊が間近、今後の活動予定は',
  ],
  award: [
    '{artist}が魅せた受賞の瞬間',
    '輝く{artist} — アワード受賞の舞台裏',
    '{artist}の快挙 — 今年最も注目のアワード',
  ],
  controversy: [
    '{artist}を巡る議論、事実関係を整理',
    '{artist}に関する報道について — 知っておくべきこと',
  ],
  mv: [
    '{artist}、新MVが公開 — 映像美に注目',
    '{artist}のMVが話題、その世界観を読み解く',
  ],
  interview: [
    '{artist}が語る今の心境 — インタビュー',
    '素顔の{artist}に迫る — スペシャルインタビュー',
  ],
  photo: [
    '{artist}、最新ビジュアルが公開',
    '{artist}の最新写真が話題 — 圧倒的なビジュアル',
  ],
  debut: [
    '新星{artist}がデビュー — 注目のプロフィール完全版',
    'デビューしたての{artist}に夢中になる理由',
  ],
  collab: [
    '{artist}×話題のブランド — スペシャルコラボの全貌',
    '{artist}コラボ速報 — 見逃せない限定アイテム',
  ],
  fan: [
    '{artist}、ファンへの愛を語る特別な瞬間',
    '{artist}とファンの絆 — 特別なファンミーティングレポート',
  ],
  trending: [
    '{artist}のSNSが話題沸騰中',
    'フォロー必須 — {artist}のリアルタイム更新まとめ',
    'ファンが歓喜した{artist}の最新投稿',
  ],
  health: [
    '{artist}の健康状態について最新情報',
    '{artist}の回復を願うファンの声が殺到',
  ],
  contract: [
    '{artist}の所属事務所に関する新展開',
    '{artist}、新たなスタートを切る — 契約詳細が判明',
  ],
  variety: [
    '{artist}の素顔に迫る — バラエティ出演まとめ',
    '笑顔がかわいすぎる{artist}のオフショット',
    '{artist}のリアルな魅力を発見',
  ],
  performance: [
    '{artist}のパフォーマンスに鳥肌 — 圧巻のステージ',
    '{artist}、カバーステージで見せた実力',
  ],
  sns: [
    '{artist}のSNSが話題沸騰中',
    'フォロー必須 — {artist}のリアルタイム更新まとめ',
    'ファンが歓喜した{artist}の最新投稿',
  ],
  collaboration: [
    '{artist}×話題のブランド — スペシャルコラボの全貌',
    '{artist}コラボ速報 — 見逃せない限定アイテム',
  ],
  general: [
    '{artist}の最新ニュースをお届け',
    '見逃せない{artist}の話題まとめ',
    'いま知りたい{artist}のすべて',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'K-POPガールズシーンの注目ニュースをお届け',
  'ガールズグループの最新動向をチェック',
  '今週のガールズグループ界、注目トピックまとめ',
  'PETAL編集部が選ぶ、今週の注目ニュース',
  'K-POPガールズの最前線から — 最新レポート',
  'ガールズグループの今を追う — PETAL特集',
  '話題のニュースをPETAL視点で深掘り',
  '見逃せないガールズグループニュース — PETALセレクト',
  '注目のガールズグループトピック — PETAL編集部がピックアップ',
  'K-POPガールズの最新トレンドを徹底チェック',
  'ガールズシーンの今を知る — PETAL最新レポート',
  '今押さえるべきガールズグループニュースまとめ',
  'PETALが追いかける、ガールズグループの今',
  'K-POPガールズ最前線 — 見逃し厳禁のニュース',
  'ガールズグループファン必見のトピック集',
  '今週のK-POPガールズダイジェスト',
  'ガールズグループの話題を総まとめ — PETALレビュー',
  'K-POPガールズの注目ポイントを深掘り解説',
  '今知りたいガールズグループ最新事情',
  'PETALセレクト — ガールズグループ最旬ニュース',
  'K-POPガールズシーンの潮流を読む',
  '今週チェックすべきガールズグループの動き',
  'PETAL厳選 — 見逃せないK-POPガールズ情報',
  'ガールズグループ最新ニュースダイジェスト',
  '今週のガールズシーン — PETALまとめ',
  'K-POPガールズの話題をPETALがキャッチ',
  '編集部注目のガールズグループトピック',
  'PETALが選ぶ今週のベストK-POPニュース',
  'ガールズグループ界の最新トレンド分析',
  'K-POPガールズのリアルタイム速報',
];

// ---- Helper: pick random item from array ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Step 1: Extract artist name from title ----

// Words that should NOT be treated as artist names even when capitalized
const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t', 'can\'t',
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

// Very short soloist names that need exact-case matching to avoid false positives
const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  // Check known names (longest-first for greedy match)
  for (const name of ALL_KNOWN_NAMES) {
    // Skip short ambiguous names for now — handle them separately
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Case-insensitive for longer names
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) {
      return name;
    }
  }

  // Short ambiguous names — require exact case AND context
  // e.g. "V Releases Solo Album" should match, but "5 V 5 tournament" should not
  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Exact case match with word boundary context
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      // Additional check: the title should contain at least one K-pop related keyword
      // or the name should appear near the beginning
      const pos = title.indexOf(name);
      if (pos <= 5) {
        return name;
      }
    }
  }

  // Fallback: extract leading capitalized word sequence that looks like an Asian person name
  // Pattern: 2-3 capitalized words where the first isn't a common English word
  // e.g. "Chae Jong Hyeop Reveals..." -> "Chae Jong Hyeop"
  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    // Reject if ANY word in the candidate is a common English word
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) {
      return candidate;
    }
  }

  return null;
}

// ---- Step 2: Classify topic ----

function classifyTopic(title) {
  const lower = title.toLowerCase();
  // Check each topic's keywords
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return topic;
      }
    }
  }
  return 'general';
}

// ---- Step 3 & 4: Generate Japanese title ----

function rewriteTitle(originalTitle, source) {
  // If already Japanese (contains hiragana/katakana/kanji), keep as-is
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(originalTitle)) {
    return originalTitle;
  }

  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  // No artist found — use generic templates
  return pickRandom(NO_ARTIST_TEMPLATES);
}

// ============================================================
// Image downloading — save artist photos locally
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Category mapping
// ============================================================

function mapCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'music';
  if (lower.includes('drama') || lower.includes('tv') || lower.includes('film') || lower.includes('movie')) return 'drama';
  if (lower.includes('fashion') || lower.includes('beauty')) return 'fashion';
  if (lower.includes('entertainment') || lower.includes('news') || lower.includes('stories')) return 'entertainment';
  return 'entertainment';
}

function getDisplayCategory(topic) {
  const map = {
    comeback: 'カムバック',
    release: 'ニューリリース',
    concert: 'ライブ',
    award: 'アワード',
    variety: 'バラエティ',
    fashion: 'ファッション',
    sns: 'SNS',
    collaboration: 'コラボ',
    debut: 'デビュー',
    chart: 'チャート',
    general: 'ニュース',
  };
  return map[topic] || 'ニュース';
}

// Legacy displayCategory — maps RSS category strings to PETAL display categories
function displayCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'ニューリリース';
  if (lower.includes('drama')) return 'ニュース';
  if (lower.includes('tv') || lower.includes('film') || lower.includes('movie')) return 'ニュース';
  if (lower.includes('fashion')) return 'ファッション';
  if (lower.includes('beauty')) return 'ファッション';
  if (lower.includes('interview')) return 'ニュース';
  if (lower.includes('photo') || lower.includes('picture')) return 'ニュース';
  return 'ニュース';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) {
      image = extractImageFromContent(contentEncoded);
    }
    if (!image) {
      image = extractImageFromContent(description);
    }

    if (!title || !link) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      // Will be populated later
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  // Remove script, style, nav, header, footer, sidebar, comments
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  // Try to find article body using common selectors
  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) {
    bodyHtml = cleaned;
  }

  // Extract paragraphs
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    // Skip very short paragraphs, ads, empty ones
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  // Extract images from the article body
  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    const content = extractArticleContent(html);
    return content;
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  // Only fetch content for articles that will be used (first ~50)
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body rewriting
// ============================================================

// ============================================================
// Fully Japanese article body generation — template-based
// ============================================================

const BODY_TEMPLATES = {
  comeback: [
    `{artist}が待望のカムバックを果たし、ファンの間で大きな話題となっています。新曲のコンセプトは前作から大きく変化し、{artist}の新たな一面を見せるものとなりました。`,
    `今回のカムバックで{artist}が見せたビジュアルは、これまでの可愛らしいイメージから一歩踏み出した大人っぽい雰囲気が特徴。ファンからは「美しすぎる」という声が続出しています。`,
    `{artist}のカムバック準備の裏側には、メンバーたちの並々ならぬ努力がありました。練習期間中のエピソードや、楽曲に込めた想いをメンバー自身の言葉でお届けします。`,
  ],
  general: [
    `{artist}に関する新たな情報が入ってきました。K-POPシーンで注目を集め続ける{artist}の最新動向をPETALがお届けします。`,
    `{artist}のファンにとって見逃せないニュースです。グループの今後の活動予定や、メンバーの近況について詳しくお伝えします。`,
    `K-POPガールズグループの中でも特に注目度の高い{artist}。今回お届けするニュースは、ファンの期待をさらに高めるものとなりそうです。`,
  ],
};

// Generic (no artist) body templates
const NO_ARTIST_BODY = [
  `K-POPガールズシーンに新たな動きがありました。PETALがお届けする最新情報をチェックしてみてください。`,
  `ガールズグループファンにとって気になるニュースが入ってきました。今回の話題は業界全体に影響を与える可能性があります。`,
  `K-POPシーンは常に進化し続けています。PETALでは、ガールズグループを中心とした最新トレンドをいち早くお届けします。`,
];

// Shared expansion paragraphs — used across all topics to create longer articles
const SHARED_PARAGRAPHS = {
  background: [
    `{artist}がK-POPシーンに登場して以来、そのユニークな魅力で多くのファンを虜にしてきました。グループ結成の経緯から現在に至るまでの軌跡を振り返ります。`,
    `デビュー以来、{artist}は着実にファンベースを拡大してきました。その成長の背景には、メンバーそれぞれの努力と、グループとしての強い絆があります。`,
    `K-POPガールズグループとして独自のポジションを確立した{artist}。音楽性だけでなく、ファッションやビューティーの面でもトレンドを生み出し続けています。`,
    `{artist}の人気の秘密は、完成度の高いパフォーマンスだけではありません。メンバーの親しみやすいキャラクターと、ファンとの距離の近さも大きな魅力です。`,
    `多くのK-POPグループがひしめく中、{artist}が特別な存在であり続ける理由。それは常に新しい挑戦を恐れない姿勢にあります。`,
    `{artist}を語る上で欠かせないのが、楽曲のクオリティの高さ。プロデューサーチームとの信頼関係から生まれる楽曲は、毎回ファンの期待を超えてきます。`,
  ],
  detail: [
    `今回の活動で{artist}が見せた新しい一面は、ファンを驚かせるものでした。コンセプトの細部にまでこだわった演出が、{artist}の魅力をさらに引き立てています。`,
    `{artist}のパフォーマンスには、メンバー全員の息の合ったダンスと、感情を込めた歌唱が光ります。練習量の多さがうかがえる完成度の高さです。`,
    `ビジュアル面でも話題を集めた{artist}。スタイリングチームとの綿密な打ち合わせにより、グループのコンセプトに完璧にマッチした衣装が実現しました。`,
    `{artist}の活動は音楽だけにとどまりません。バラエティ番組やファッション誌への出演を通じて、より幅広い層にグループの魅力を発信しています。`,
    `ファンミーティングやサイン会など、{artist}はファンとの交流も大切にしています。こうした姿勢が、長く愛されるグループであり続ける理由の一つです。`,
    `{artist}のMVは毎回、映画のような映像美で話題になります。世界観の構築にかける情熱が、視聴回数の記録更新につながっています。`,
    `メンバーのSNS投稿も{artist}の魅力を伝える重要な要素。日常の素顔やオフショットは、ファンにとってかけがえのないコンテンツです。`,
  ],
  reaction: [
    `ファンの間では今回の{artist}の活動に対して、「最高のカムバック」「ビジュアルが優勝」といった熱い反応が寄せられています。`,
    `SNSでは{artist}に関する投稿がトレンド入りし、国内外のファンが喜びの声を共有しています。その反響の大きさは、{artist}の影響力を物語っています。`,
    `音楽評論家からも{artist}の成長を評価する声が上がっています。「前作を超える完成度」という高い評価を受けています。`,
    `{artist}の活動を受けて、ファンコミュニティでは応援プロジェクトが次々と立ち上がっています。ファンの団結力もグループの魅力の一つです。`,
    `海外メディアでも{artist}の活躍が取り上げられ、グローバルな注目度がさらに高まっています。`,
  ],
  impact: [
    `{artist}の今回の活動は、K-POPガールズグループのトレンドに新たな方向性を示すものとなりました。今後の展開にも大きな期待が寄せられています。`,
    `業界関係者は{artist}の成功について、「グループの実力とファンの応援が生み出した相乗効果」と分析しています。`,
    `{artist}の活躍は、K-POPファン以外の層にも影響を与えています。ファッションやビューティートレンドへの波及効果も見逃せません。`,
    `今回の成果を踏まえ、{artist}のさらなる飛躍が期待されています。PETALでは今後も{artist}の活動を追い続けます。`,
  ],
  closing: [
    `PETALでは引き続き{artist}の最新情報をお届けしていきます。次回の特集もお楽しみに。`,
    `{artist}のこれからに、PETALは注目し続けます。新たな展開があり次第、すぐにお届けします。`,
    `{artist}の物語はまだまだ続きます。PETALと一緒に、その成長を見届けましょう。`,
    `以上、{artist}の最新情報をPETAL編集部がお届けしました。次回更新をお見逃しなく。`,
  ],
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  // Determine target length based on original content
  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  // Collect inline images from original article (skip first which is hero)
  const inlineImages = (articleContent?.images || []).slice(1, 4); // Up to 3 inline images

  const paragraphs = [];
  // Track all used text to prevent any paragraph from appearing twice
  const usedTexts = new Set();

  // Pick a random item that hasn't been used yet
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };

  // Shuffle and pick N unique items that haven't been used yet
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const topicTemplates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    // 1. Opening (1 paragraph from topic templates)
    const intro = pickUnique(topicTemplates);
    paragraphs.push({ type: 'intro', text: sub(intro) });

    // 2. Background (1-2 paragraphs)
    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    // 3. Detail (2-3 paragraphs)
    const detailCount = targetParagraphs >= 10 ? 3 : 2;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    // Insert inline image position marker after detail
    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    // 4. Reaction (1-2 paragraphs)
    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    // Insert second inline image
    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    // 5. Impact (1 paragraph)
    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });

    // 6. Closing (1 paragraph — from dedicated closing pool, never from impact)
    paragraphs.push({ type: 'closing', text: sub(pickUnique(SHARED_PARAGRAPHS.closing)) });

  } else {
    // No artist — use generic body
    const introText = pickUnique(NO_ARTIST_BODY);
    paragraphs.push({ type: 'intro', text: introText });

    // Background from shared (generic substitution without artist)
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, 2)) {
      paragraphs.push({ type: 'body', text: bg.replace(/\{artist\}/g, 'ガールズグループ') });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, 2)) {
      paragraphs.push({ type: 'body', text: d.replace(/\{artist\}/g, 'ガールズグループ') });
    }

    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r.replace(/\{artist\}/g, 'ガールズグループ') });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.impact).replace(/\{artist\}/g, 'ガールズグループ') });

    // Closing — pick from NO_ARTIST_BODY but ensure it's different from the intro
    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY) });
  }

  return { paragraphs };
}

// Try to find an artist name in the first few paragraphs of article content
function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

// Shuffle array and pick N items
function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Build image tag helper
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// For article pages, image paths need to go up one level (../images/)
function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  // If it's a local image path, prefix with ../
  if (src.startsWith('images/')) {
    src = '../' + src;
  }
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Section generators — internal links with source attribution
// ============================================================

// Hero is handled via template placeholders in PETAL

function generateHeroSideCard(article, isLast) {
  if (!article) return '';
  const filename = escapeHtml(article.localUrl || '#');
  const image = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const category = escapeHtml(displayCategory(article.category));
  const title = escapeHtml(article.title);
  const date = escapeHtml(article.formattedDate);
  const borderClass = isLast ? '' : ' border-b border-rule pb-4';
  return `<a href="${filename}" class="flex gap-3${borderClass}">
          <img src="${image}" alt="" class="w-24 h-16 object-cover flex-shrink-0">
          <div>
            <span class="text-[10px] text-accent font-bold">${category}</span>
            <h3 class="text-sm font-bold text-ink leading-snug mt-0.5 hover:text-accent">${title}</h3>
            <span class="text-[11px] text-meta mt-1 block">${date}</span>
          </div>
        </a>`;
}

function generatePickupCard(article) {
  if (!article) return '';
  const filename = article.localUrl;
  const image = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const category = escapeHtml(displayCategory(article.category));
  const title = escapeHtml(article.title);
  const date = escapeHtml(article.formattedDate);
  return `<div class="bg-white rounded-[20px] overflow-hidden shadow-sm hover:shadow-md transition-shadow">
  <a href="${escapeHtml(filename)}">
    <div class="aspect-[4/3] overflow-hidden">
      <img src="${image}" alt="" class="w-full h-full object-cover hover:scale-105 transition-transform duration-500" loading="lazy">
    </div>
    <div class="p-5">
      <span class="inline-block px-3 py-1 text-xs font-medium rounded-full bg-[#f78da7]/10 text-[#f78da7] mb-2">${category}</span>
      <h3 class="font-bold text-[#3d3d3d] leading-snug mb-2 line-clamp-2" style="font-family:'Zen Maru Gothic',sans-serif">${title}</h3>
      <span class="text-xs text-[#999]">${date}</span>
    </div>
  </a>
</div>`;
}

function generateLatestCard(article) {
  if (!article) return '';
  const filename = escapeHtml(article.localUrl);
  const image = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const category = escapeHtml(displayCategory(article.category));
  const title = escapeHtml(article.title);
  const date = escapeHtml(article.formattedDate);
  const source = escapeHtml(article.source);
  return `<div class="flex gap-5 p-4 rounded-[16px] hover:bg-[#FFF0F5] transition-colors">
  <a href="${filename}" class="shrink-0">
    <img src="${image}" alt="" class="w-28 h-20 md:w-36 md:h-24 object-cover rounded-[12px]" loading="lazy">
  </a>
  <div class="flex flex-col justify-center">
    <span class="inline-block w-fit px-2 py-0.5 text-[10px] font-medium rounded-full bg-[#b8e6d0]/20 text-[#3d3d3d] mb-1">${category}</span>
    <h3 class="font-bold text-[#3d3d3d] text-sm md:text-base leading-snug line-clamp-2 mb-1" style="font-family:'Zen Maru Gothic',sans-serif">${title}</h3>
    <span class="text-xs text-[#999]">${date} — ${source}</span>
  </div>
</div>`;
}

function generateFocusCard(article) {
  if (!article) return '';
  const filename = escapeHtml(article.localUrl);
  const image = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const category = escapeHtml(displayCategory(article.category));
  const title = escapeHtml(article.title);
  return `<div class="bg-white rounded-[20px] overflow-hidden shadow-sm">
  <a href="${filename}">
    <div class="aspect-[3/4] overflow-hidden">
      <img src="${image}" alt="" class="w-full h-full object-cover hover:scale-105 transition-transform duration-500" loading="lazy">
    </div>
    <div class="p-4">
      <span class="inline-block px-2 py-0.5 text-[10px] font-medium rounded-full bg-[#f78da7]/10 text-[#f78da7] mb-2">${category}</span>
      <h3 class="font-bold text-[#3d3d3d] text-sm leading-snug line-clamp-2" style="font-family:'Zen Maru Gothic',sans-serif">${title}</h3>
    </div>
  </a>
</div>`;
}

function generateRankingItem(article, rank) {
  if (!article) return '';
  const filename = escapeHtml(article.localUrl);
  const image = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const title = escapeHtml(article.title);
  const date = escapeHtml(article.formattedDate);
  return `<div class="flex items-center gap-4 py-3 border-b border-[#f0e8e0] last:border-0">
  <span class="text-2xl font-bold text-[#f78da7] w-8 text-center" style="font-family:'Quicksand',sans-serif">${rank}</span>
  <a href="${filename}" class="shrink-0">
    <img src="${image}" alt="" class="w-16 h-16 object-cover rounded-[10px]" loading="lazy">
  </a>
  <div>
    <h4 class="font-bold text-[#3d3d3d] text-sm leading-snug line-clamp-2" style="font-family:'Zen Maru Gothic',sans-serif">${title}</h4>
    <span class="text-xs text-[#999]">${date}</span>
  </div>
</div>`;
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  // Pre-assign localUrl to ALL usedArticles before generating pages.
  // This ensures that when related articles are picked, they already
  // have a valid localUrl instead of falling back to '../index.html'.
  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    // Find related articles (same category, different article)
    // Only pick articles that have a localUrl so links are never broken
    // Filter out boy group articles — PETAL is a girls magazine
    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl && !isBoyGroupArticle(a))
      .slice(0, 20) // from a pool
      .sort(() => Math.random() - 0.5) // shuffle
      .slice(0, 3); // take 3

    // Build article body
    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src.startsWith('http') ? item.src : item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    // Build hero image
    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) {
      heroImgSrc = '../' + heroImgSrc;
    }
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    // Build related articles
    let relatedHtml = '';
    for (const rel of related) {
      // Related article URLs: localUrl is guaranteed by the filter above
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) {
        relImgSrc = '../' + relImgSrc;
      }
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${escapeHtml(displayCategory(rel.category))}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    // Build popular sidebar (pick 3 random articles different from current)
    // Filter out boy group articles — PETAL is a girls magazine
    const popularPool = allArticles
      .filter(a => a !== article && a.image && a.localUrl && !isBoyGroupArticle(a))
      .slice(0, 30)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    const viewCounts = [15847, 12403, 9821, 8654, 7390, 6102, 5443];
    let popularSidebarHtml = '';
    for (let pi = 0; pi < popularPool.length; pi++) {
      const pop = popularPool[pi];
      let popImgSrc = pop.image || PLACEHOLDER_IMAGE;
      if (popImgSrc.startsWith('images/')) popImgSrc = '../' + popImgSrc;
      const popUrl = `../${pop.localUrl}`;
      const popFallback = `https://picsum.photos/seed/${encodeURIComponent(pop.title.slice(0, 15))}/200/200`;
      popularSidebarHtml += `
                <a href="${escapeHtml(popUrl)}" class="flex gap-3 group">
                  <div class="flex-shrink-0 w-16 h-16 rounded-[10px] overflow-hidden">
                    <img src="${escapeHtml(popImgSrc)}" alt="${escapeHtml(pop.title)}" class="w-full h-full object-cover img-zoom" loading="lazy" decoding="async" data-fallback="${escapeHtml(popFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="text-xs font-bold text-ink leading-snug break-keep group-hover:text-petal transition-colors duration-300 line-clamp-2">${escapeHtml(pop.title)}</h4>
                    <span class="text-[10px] text-muted mt-1 block">${(viewCounts[pi] || 5000 + Math.floor(Math.random() * 10000)).toLocaleString()} views</span>
                  </div>
                </a>`;
    }

    // Build source attribution
    const sourceAttribution = `<div class="source-attribution">
          出典: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">元記事を読む &rarr;</a>
        </div>`;

    // Build photo credit
    const photoCredit = `写真: &copy;${escapeHtml(article.source)}`;

    // Fill template
    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace(/\{\{ARTICLE_CATEGORY\}\}/g, escapeHtml(displayCategory(article.category)))
      .replace(/\{\{ARTICLE_SOURCE\}\}/g, escapeHtml(article.source))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml)
      .replace('{{POPULAR_SIDEBAR}}', popularSidebarHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 4;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/petal-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const all = [...articles];

  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  // PETAL layout: hero(1), heroSide(4), pickup(6), latest(8), focus(8), ranking(5)
  const heroCandidates = withRealImages.length >= 1 ? withRealImages : all;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const heroSide = take(all, 4);
  const pickup = take(withRealImages.length >= 7 ? withRealImages : all, 6);
  const latest = take(all, 8);
  const focus = take(withRealImages.length >= 8 ? withRealImages : all, 8);
  const ranking = take(all, 5);

  return {
    hero: hero[0] || null,
    heroSide,
    pickup,
    latest,
    focus,
    ranking,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  // Hero section
  if (sections.hero) {
    const hero = sections.hero;
    template = template.replace('{{HERO_IMAGE}}', escapeHtml(hero.image || PLACEHOLDER_IMAGE));
    template = template.replace('{{HERO_TITLE}}', escapeHtml(hero.title));
    template = template.replace('{{HERO_CATEGORY}}', escapeHtml(displayCategory(hero.category)));
    template = template.replace('{{HERO_DATE}}', escapeHtml(hero.formattedDate));
    template = template.replace('{{HERO_SOURCE}}', escapeHtml(hero.source));
  }

  // Hero side articles
  template = template.replace(
    '{{HERO_SIDE_ARTICLES}}',
    sections.heroSide.map((a, i) => generateHeroSideCard(a, i === sections.heroSide.length - 1)).join('\n        ')
  );

  // Pickup section
  template = template.replace(
    '{{PICKUP_ITEMS}}',
    sections.pickup.map(a => generatePickupCard(a)).join('\n        ')
  );

  // Latest articles section
  template = template.replace(
    '{{LATEST_ARTICLES}}',
    sections.latest.map(a => generateLatestCard(a)).join('\n        ')
  );

  // Focus section
  template = template.replace(
    '{{FOCUS_ITEMS}}',
    sections.focus.map(a => generateFocusCard(a)).join('\n        ')
  );

  // Ranking section
  template = template.replace(
    '{{RANKING_ITEMS}}',
    sections.ranking.map((a, i) => generateRankingItem(a, i + 1)).join('\n        ')
  );

  // Remove any remaining unused placeholders
  template = template.replace('{{GENERATED_AT}}', '');

  return template;
}

// ============================================================
// Main
// ============================================================

// ============================================================
// Backdating — spread articles from Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const totalMs = endDate.getTime() - startDate.getTime();

  if (articles.length <= 1) return;

  // Sort newest first, then assign evenly spaced dates from endDate to startDate
  for (let i = 0; i < articles.length; i++) {
    const ratio = i / (articles.length - 1); // 0 = newest, 1 = oldest
    const dateMs = endDate.getTime() - (ratio * totalMs);
    const d = new Date(dateMs);
    // Add some random hours to avoid all being at midnight
    d.setHours(Math.floor(Math.random() * 14) + 8); // 8:00-22:00
    d.setMinutes(Math.floor(Math.random() * 60));

    articles[i].pubDate = d;
    // Japanese date format: 2026年3月22日
    const yyyy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const dd = d.getDate();
    articles[i].formattedDate = `${yyyy}年${mm}月${dd}日`;
  }

  log(`  Backdated ${articles.length} articles from 2026年1月1日 to 2026年3月22日`);
}

async function main() {
  log('Starting PETAL K-POP Girl Group Magazine Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to Japanese (with deduplication)
  log('Rewriting titles to Japanese editorial style...');
  let rewritten = 0;
  const usedTitles = new Set();
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    let newTitle = rewriteTitle(original, article.source);
    // Deduplication: if title already used, try up to 10 times for a unique one
    let attempts = 0;
    while (usedTitles.has(newTitle) && attempts < 10) {
      newTitle = rewriteTitle(original, article.source);
      attempts++;
    }
    // If still duplicate after 10 attempts, append a suffix
    if (usedTitles.has(newTitle)) {
      const suffixes = ['（続報）', '（詳報）', '（速報）', '（独自取材）', '（編集部注目）', '（PETAL独占）', '（最新情報）', '（深掘り）'];
      newTitle = newTitle + suffixes[Math.floor(Math.random() * suffixes.length)];
    }
    usedTitles.add(newTitle);
    article.title = newTitle;
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles (${usedTitles.size} unique)`);
  log('');

  // 4. Backdate articles (spread from Jan 1 to Mar 22, 2026)
  backdateArticles(articles);
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles for article page generation
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.heroSide);
  addUsed(sections.pickup);
  addUsed(sections.latest);
  addUsed(sections.focus);
  addUsed(sections.ranking);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content for used articles
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML from template
  const html = await generateHtml(sections);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.heroSide.length +
    sections.pickup.length +
    sections.latest.length +
    sections.focus.length +
    sections.ranking.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[PETAL Crawler] Fatal error:', err);
  process.exit(1);
});

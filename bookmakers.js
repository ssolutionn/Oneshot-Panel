// Where the tournament is on sale: Russian licensed bookmakers' own public
// line feeds (the ones their websites call), parsed without DOM so the same
// code runs in the server function (netlify/functions/bookmakers.mjs) and in
// the lobby. Only CyberClash events are kept.

// Fonbet and PARI share one platform (same event ids); each still sells it
// under its own brand, so both are listed.
const FONBET_HOSTS = ['line54w.bk6bba-resources.com', 'line55w.bk6bba-resources.com',
  'line31w.bk6bba-resources.com', 'line02w.bk6bba-resources.com'];
const PARI_HOSTS = ['line-lb51-w.pb06e2-resources.com', 'line-lb01-w.pb06e2-resources.com'];
const showEvents = (host, scope, live) =>
  `https://${host}/line/mobile/showEvents?sysId=2&lang=ru&scopeMarket=${scope}&lineType=${live ? 'live_line' : 'line'}&skId=29086`;
const OLIMP = live =>
  `https://www.olimp.bet/api/v4/0/${live ? 'live' : 'line'}/sports-with-competitions-with-events?vids%5B%5D=112%3A`;
// Betcity: sport 73 is esports; "off" is the line, "on_air" the live.
const BETCITY = live => `https://ad.betcity.ru/d/${live ? 'on_air' : 'off'}/events?rev=6&ver=69&lng=1&csn=ooca9s&ids_sp=73`;

export const BOOKMAKERS = [
  {
    id: 'fonbet', name: 'Фонбет', kind: 'fonbet', page: 'https://fon.bet/sports/esports',
    feeds: [false, true].map(live => ({ live, urls: FONBET_HOSTS.map(h => showEvents(h, 1600, live)) })),
    eventUrl: e => `https://fon.bet/${e.live ? 'live' : 'sports'}/esports/${e.group}/${e.id}`
  },
  {
    id: 'pari', name: 'PARI', kind: 'fonbet', page: 'https://pari.ru/esports/category/cs',
    feeds: [false, true].map(live => ({ live, urls: PARI_HOSTS.map(h => showEvents(h, 2300, live)) })),
    eventUrl: e => `https://pari.ru/${e.live ? 'live' : 'sports'}/esports/${e.group}/${e.id}`
  },
  {
    id: 'olimp', name: 'OLIMPBET', kind: 'olimp', page: 'https://www.olimp.bet/cybersport/cs2',
    feeds: [false, true].map(live => ({ live, urls: [OLIMP(live)] })),
    eventUrl: e => `https://www.olimp.bet/${e.live ? 'live' : 'line'}/kibersport-112/${e.group}/${e.id}`
  },
  {
    id: 'marathon', name: 'Марафон', kind: 'marathon',
    page: 'https://www.marathonbet.ru/su/betting/e-Sports/Counter-Strike+2+-+16339652',
    feeds: [{ live: false, urls: ['https://www.marathonbet.ru/su/betting/e-Sports/Counter-Strike+2+-+16339652'] }],
    eventUrl: e => `https://www.marathonbet.ru/su/betting/${e.path}`
  },
  {
    id: 'betcity', name: 'Бетсити', kind: 'betcity', page: 'https://betcity.ru/ru/line/cybersport',
    feeds: [false, true].map(live => ({ live, urls: [BETCITY(live)] })),
    eventUrl: e => `https://betcity.ru/ru/${e.live ? 'live' : 'line'}/cybersport/${e.group}/${e.id}`
  }
];
// Licensed bookmakers without an automated check yet (websocket, signed
// headers, foreign IPs dropped): the lobby lists them with a link to look.
export const MANUAL = [
  { id: 'winline', name: 'Winline', url: 'https://winline.ru/stavki/sport/kibersport/counter-strike' },
  { id: 'ligastavok', name: 'Лига Ставок', url: 'https://www.ligastavok.ru/bets/cybersport' },
  { id: 'betboom', name: 'BetBoom', url: 'https://betboom.ru/esport/counter-strike-2' },
  { id: 'melbet', name: 'Мелбет', url: 'https://melbet.ru/' },
  { id: 'baltbet', name: 'Балтбет', url: 'https://baltbet.ru/' },
  { id: 'zenit', name: 'Зенит', url: 'https://zenit.win/line/556' },
  { id: 'bettery', name: 'Bettery', url: 'https://bettery.ru/sports/esports/category/cs' },
  { id: 'leon', name: 'Леон', url: 'https://leon.ru/bets/esports/cs2' },
  { id: 'betm', name: 'БЕТ-М', url: 'https://betm.ru/' },
  { id: 'sportbet', name: 'Спортбет', url: 'https://sportbet.ru/' },
  { id: 'bet24', name: '24bet', url: 'https://24bet.ru/' }
];

export const isCyberClash = name => /cyber\s*clash|кибер\s*клэш/i.test(String(name || ''));

const price = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
};

// Fonbet / PARI showEvents: events[] with parentId 0 for matches (maps are
// child events), sportName "Counter-Strike. CyberClash. …", main odds in
// subcategory 120 (factor 921 = team 1, 923 = team 2).
function parseFonbet(body, live) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  return (data?.events || []).filter(e => e && Number(e.parentId) === 0 &&
      /counter-?strike|cs\s*2/i.test(e.sportName || '') && isCyberClash(e.sportName))
    .map(e => {
      const quotes = (e.subcategories || []).find(s => Number(s.num) === 120)?.quotes || [];
      const quote = id => price(quotes.find(q => Number(q.factorId) === id)?.value);
      return {
        id: String(e.id), group: String(e.sportId), tournament: e.sportName,
        team1: e.team1 || '', team2: e.team2 || '',
        start: Number(e.startTimeTimestamp) * 1000 || null,
        odds: [quote(921), quote(923)], live
      };
    });
}

// OLIMPBET: [{payload: {competitionsWithEvents: [{competition, events}]}}];
// odds are outcomes with tableType RESULT, shortName П1/П2, in "probability".
function parseOlimp(body, live) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  const blocks = (Array.isArray(data) ? data : [data]).flatMap(item => item?.payload?.competitionsWithEvents || []);
  return blocks.filter(b => isCyberClash(b.competition?.name)).flatMap(b => (b.events || []).map(e => {
    const outcome = short => price((e.outcomes || []).find(o => o.tableType === 'RESULT' && o.shortName === short)?.probability);
    return {
      id: String(e.id), group: String(b.competition.id), tournament: b.competition.name,
      team1: e.team1Name || '', team2: e.team2Name || '',
      start: Number(e.startDateTime) * 1000 || null,
      odds: [outcome('П1'), outcome('П2')], live: live || !!e.score,
      score: e.score || ''
    };
  }));
}

// Betcity: {reply: {sports: {73: {chmps: {<id>: {name_ch, evts: {<id>: …}}}}}}};
// the match result is main["69"] (blocks.Wm.P1 / P2, kf). The live list
// carries no odds, only the score.
function parseBetcity(body, live) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  return Object.values(data?.reply?.sports || {}).flatMap(sport => Object.values(sport?.chmps || {}))
    .filter(c => isCyberClash(c?.name_ch))
    .flatMap(c => Object.values(c.evts || {}).filter(e => e && !e.del_ev).map(e => {
      const result = e.main?.['69']?.data?.[e.id_ev]?.blocks?.Wm || {};
      return {
        id: String(e.id_ev), group: String(c.id_ch), tournament: c.name_ch,
        team1: e.name_ht || '', team2: e.name_at || '',
        start: Number(e.date_ev) * 1000 || null,
        odds: [price(result.P1?.kf), price(result.P2?.kf)], live,
        score: e.sc_ev || ''
      };
    }));
}

const decode = text => String(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const stripTags = html => decode(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Marathonbet renders its line as HTML: a category block per tournament
// (h2.category-label), a div.coupon-row per match with data attributes,
// the start time in .date-wrapper and the 2-way prices in data-selection-price.
function parseMarathon(body, live, now = Date.now()) {
  const html = String(body);
  const events = [];
  for (const block of html.split(/<div class="category-container"/).slice(1)) {
    const label = block.match(/<h2[^>]*class="category-label[^"]*"[^>]*>([\s\S]*?)<\/h2>/);
    const tournament = label ? stripTags(label[1]) : '';
    if (!isCyberClash(tournament)) continue;
    for (const row of block.split(/<div class="bg coupon-row"/).slice(1)) {
      const attr = name => decode(row.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '');
      const id = attr('data-event-eventId');
      if (!id) continue;
      const [team1 = '', team2 = ''] = attr('data-event-name').split(/\s+-\s+/);
      const prices = [...row.matchAll(/data-market-type="RESULT_2WAY"[\s\S]*?data-selection-price="([\d.]+)"/g)].map(m => price(m[1]));
      events.push({
        id, group: attr('data-event-treeId'), tournament, team1, team2,
        start: mskTime(row.match(/date-wrapper">\s*([^<]+?)\s*</)?.[1] || '', now),
        odds: [prices[0] ?? null, prices[1] ?? null],
        live: live || attr('data-live') === 'true', path: attr('data-event-path')
      });
    }
  }
  return events;
}
// "16:00" (today, Moscow) or "17 окт 16:00" → ms; null when unknown.
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function mskTime(text, now = Date.now()) {
  const m = String(text).toLowerCase().match(/(?:(\d{1,2})\s+([а-я]{3})[а-я]*\s+)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const today = new Date(now + 3 * 3600000);
  const month = m[2] ? MONTHS.indexOf(m[2]) : today.getUTCMonth();
  if (month < 0) return null;
  const day = m[1] ? Number(m[1]) : today.getUTCDate();
  return Date.UTC(today.getUTCFullYear(), month, day, Number(m[3]) - 3, Number(m[4]));
}

const PARSERS = { fonbet: parseFonbet, olimp: parseOlimp, marathon: parseMarathon, betcity: parseBetcity };
export function parseFeed(bookmaker, body, live, now = Date.now()) {
  const parse = PARSERS[bookmaker.kind];
  if (!parse) throw new Error('Неизвестный формат линии.');
  // A successful HTTP response can still be a maintenance page or a changed
  // schema. Treat that as unavailable, never as proof that the tournament vanished.
  const data = bookmaker.kind === 'marathon' ? body : typeof body === 'string' ? JSON.parse(body) : body;
  const valid = bookmaker.kind === 'fonbet' ? Array.isArray(data?.events) :
    bookmaker.kind === 'olimp' ? (Array.isArray(data) ? data : [data])
      .some(item => Array.isArray(item?.payload?.competitionsWithEvents)) :
    bookmaker.kind === 'betcity' ? data?.ok !== false && data?.reply?.sports &&
      typeof data.reply.sports === 'object' :
    bookmaker.kind === 'marathon' ? /class="[^"]*category-container/.test(String(data)) : true;
  if (!valid) throw new Error('формат линии изменился или источник вернул страницу ошибки');
  return parse(data, live, now).map(e => ({ ...e, url: bookmaker.eventUrl(e) }));
}

// Team names differ per bookmaker ("Rune Eaters Esports", "Honved Esport",
// "Lenovo Legion Honved", "Private"): compare letters only, without accents,
// and let one name contain the other.
export function teamKey(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-zа-яё0-9]/g, '').replace(/(esports?|gaming|team|clan)$/, '');
}
export function sameTeam(a, b) {
  const x = teamKey(a), y = teamKey(b);
  return x.length >= 3 && y.length >= 3 && (x === y || x.includes(y) || y.includes(x));
}
// The bookmaker's event for our match, in either order; odds in our order.
export function findMatch(events, team1, team2) {
  for (const e of events) {
    if (sameTeam(e.team1, team1) && sameTeam(e.team2, team2)) return { ...e, swapped: false };
    if (sameTeam(e.team1, team2) && sameTeam(e.team2, team1)) {
      return { ...e, swapped: true, odds: [e.odds[1], e.odds[0]] };
    }
  }
  return null;
}
export const eventKey = (bookmakerId, e) => `${bookmakerId}:${e.id}`;

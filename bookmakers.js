// Where the tournament is on sale: Russian licensed bookmakers' own public
// line feeds (the ones their websites call), parsed without DOM so the same
// code runs in the server function (netlify/functions/bookmakers.mjs) and in
// the lobby. Only CyberClash events are kept.

// Fonbet and PARI share one platform (same event ids); each still sells it
// under its own brand, so both are listed.
const FONBET_HOSTS = ['line54w.bk6bba-resources.com', 'line55w.bk6bba-resources.com',
  'line31w.bk6bba-resources.com', 'line02w.bk6bba-resources.com'];
const PARI_HOSTS = ['line-lb51-w.pb06e2-resources.com', 'line-lb01-w.pb06e2-resources.com'];
// Bettery and 24bet run the same platform (hosts from their /urls.json).
const BETTERY_HOSTS = ['line-vk01', 'line-nx-w', 'line-cv-w', 'line01', 'line51'].map(h => `${h}.at58f5-resources.ru`);
const BET24_HOSTS = ['line51.tf39be-resources.com'];
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
    id: 'bettery', name: 'Bettery', kind: 'fonbet', page: 'https://bettery.ru/sports/esports/category/cs',
    feeds: [false, true].map(live => ({ live, urls: BETTERY_HOSTS.map(h => showEvents(h, 501, live)) })),
    eventUrl: e => `https://bettery.ru/${e.live ? 'live' : 'sports'}/esports/${e.group}/${e.id}`
  },
  {
    id: 'bet24', name: '24bet', kind: 'fonbet', page: 'https://24bet.ru/sports/esports',
    feeds: [false, true].map(live => ({ live, urls: BET24_HOSTS.map(h => showEvents(h, 3000, live)) })),
    eventUrl: e => `https://24bet.ru/${e.live ? 'live' : 'sports'}/esports/${e.group}/${e.id}`
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
  },
  {
    id: 'sportbet', name: 'Спортбет', kind: 'sportbet', page: 'https://sportbet.ru/',
    feeds:[false,true].map(live => ({live, urls:[
      'https://bthm-server.sportbet.ru/events.table?lang=ru&status=' + (live ? 'live' : 'prematch') + '&sport=esport-counter-strike'
    ]})),
    eventUrl: () => 'https://sportbet.ru/'
  },
  {
    id: 'baltbet', name: 'Балтбет', kind: 'baltbet', page: 'https://baltbet.ru/prematch/cybersport',
    feeds: [{live:false, urls:['https://events.baltbet.ru/api/prematch/sport/25/events?offset=all'],
      headers:{bb_appSource:'UniRu'}}],
    eventUrl: e => typeof e.path === 'string' && e.path.startsWith('/cybersport/') ?
      'https://baltbet.ru' + e.path : 'https://baltbet.ru/prematch/cybersport'
  },
  {
    id: 'winline', name: 'Winline', kind: 'winline',
    page: 'https://winline.ru/stavki/sport/kibersport/counter-strike',
    feeds: [{live:false, urls:[]}],
    eventUrl: () => 'https://winline.ru/stavki/sport/kibersport/counter-strike'
  },
  {
    id: 'leon', name: 'Леон', kind: 'leon', page: 'https://leon.ru/bets/esports/cs2',
    feeds: [{ live: false, urls: ['https://leon.ru/api-ext/betline-exports/esports'] }],
    // The export gives the match page itself; only a leon.ru address is taken.
    eventUrl: e => /^https:\/\/leon\.ru\//.test(e.path) ? e.path : 'https://leon.ru/bets/esports/cs2'
  }
];
// Licensed bookmakers without an automated check yet (websocket, signed
// headers, foreign IPs dropped): the lobby lists them with a link to look.
export const MANUAL = [
  { id: 'ligastavok', name: 'Лига Ставок', url: 'https://www.ligastavok.ru/bets/cybersport', reason: 'Публичный серверный запрос отклонён; линия не проверена' },
  { id: 'betboom', name: 'BetBoom', url: 'https://betboom.ru/sport/esport/3/39428', reason: 'Турнир найден; получение матчей и коэффициентов ещё не подключено' },
  { id: 'melbet', name: 'Мелбет', url: 'https://melbet.ru/', reason: 'Публичный серверный запрос отклонён; линия не проверена' },
  { id: 'zenit', name: 'Зенит', url: 'https://zenit.win/line/556', reason: 'Линия видна в браузере; серверное чтение ещё не подтверждено' },
  { id: 'betm', name: 'БЕТ-М', url: 'https://bet-m.ru/', reason: 'Публичный серверный запрос отклонён; линия не проверена' }
];

export const isCyberClash = name => /cyber\s*clash|кибер\s*клэш/i.test(String(name || ''));

const price = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
};
// Every event may carry, besides the match winner (odds):
//   markets — the other two-way markets the feed lists: {kind, name, line, odds}
//     handicap: line and odds[0] for team 1, odds[1] for team 2 at the opposite line;
//     total: odds = [over, under];
//   size — how big the bookmaker's line on the match is, as it counts it:
//     {count, unit} with unit 'исходов' (prices) or 'рынков' (bet types);
//   liveOffered — the bookmaker says the match will be in live.
const market = (name, line, odds) => {
  const kind = /фора|handicap/i.test(name) ? 'handicap' : /тотал|total/i.test(name) ? 'total' : 'other';
  const prices = odds.map(price);
  return prices.length === 2 && prices.some(Boolean) ? { kind, name, line: line == null ? '' : String(line), odds: prices } : null;
};
const size = (count, unit) => Number(count) > 0 ? { count: Number(count), unit } : null;

// Fonbet / PARI showEvents: events[] with parentId 0 for matches (maps are
// child events), sportName "Counter-Strike. CyberClash. …", main odds in
// subcategory 120 (factor 921 = team 1, 923 = team 2).
function parseFonbet(body, live) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  return (data?.events || []).filter(e => e && Number(e.parentId) === 0 &&
      /counter-?strike|cs\s*2/i.test(e.sportName || '') && isCyberClash(e.sportName))
    .map(e => {
      const subs = e.subcategories || [];
      const quotes = subs.find(s => Number(s.num) === 120)?.quotes || [];
      const quote = id => price(quotes.find(q => Number(q.factorId) === id)?.value);
      return {
        id: String(e.id), group: String(e.sportId), tournament: e.sportName,
        team1: e.team1 || '', team2: e.team2 || '',
        start: Number(e.startTimeTimestamp) * 1000 || null,
        odds: [quote(921), quote(923)], live,
        // 304 Фора (927 team 1, 928 team 2), 305 Тотал (930 over, 931 under).
        markets: subs.filter(s => Number(s.num) !== 120)
          .map(s => market(s.name || '', s.quotes?.[0]?.p, (s.quotes || []).map(q => q.value))).filter(Boolean),
        size: size(e.allFactorsCount, 'исходов')
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
      score: e.score || '', markets: [], size: size(e.outcomeCount, 'исходов')
    };
  }));
}

// Betcity: {reply: {sports: {73: {chmps: {<id>: {name_ch, evts: {<id>: …}}}}}}};
// the match result is main["69"] (blocks.Wm.P1 / P2, kf), the handicap
// main["71"] (F1m: Kf_F1 / Kf_F2 at F1), the total main["72"] (T1m: Tb over,
// Tm under at Tot); cnt_ext_add is how many more bet types the event has,
// is_live = 1 that it goes to live. The live list carries no odds, only the score.
function parseBetcity(body, live) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  return Object.values(data?.reply?.sports || {}).flatMap(sport => Object.values(sport?.chmps || {}))
    .filter(c => isCyberClash(c?.name_ch))
    .flatMap(c => Object.values(c.evts || {}).filter(e => e && !e.del_ev).map(e => {
      const block = (id, name) => e.main?.[id]?.data?.[e.id_ev]?.blocks?.[name] || null;
      const result = block('69', 'Wm') || {}, handicap = block('71', 'F1m'), total = block('72', 'T1m');
      const markets = [
        handicap && market('Фора', handicap.F1, [handicap.Kf_F1?.kf, handicap.Kf_F2?.kf]),
        total && market('Тотал', total.Tot, [total.Tb?.kf, total.Tm?.kf])
      ].filter(Boolean);
      const shown = Object.keys(e.main || {}).length;
      return {
        id: String(e.id_ev), group: String(c.id_ch), tournament: c.name_ch,
        team1: e.name_ht || '', team2: e.name_at || '',
        start: Number(e.date_ev) * 1000 || null,
        odds: [price(result.P1?.kf), price(result.P2?.kf)], live,
        score: e.sc_ev || '', markets,
        size: shown ? size(shown + (Number(e.cnt_ext_add) || 0), 'рынков') : null,
        liveOffered: Number(e.is_live) === 1
      };
    }));
}

// Leon's public export (api-ext/betline-exports/esports): events[] with
// league, team1 / team2, kickoff (ISO with offset), matchUrl (the event id is
// its number) and markets [{market: "Победитель", selections [{type 1|2, odds}]}].
function parseLeon(body, live) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  return (data?.events || []).filter(e => e && isCyberClash(e.league)).map(e => {
    const winner = (e.markets || []).find(m => /победитель/i.test(m?.market || ''));
    const pick = type => price(winner?.selections?.find(x => String(x?.type) === type)?.odds);
    const path = String(e.matchUrl || '');
    return {
      id: path.match(/\/(\d+)-[^/]*$/)?.[1] || `${e.team1}-${e.team2}-${e.kickoff}`,
      group: String(e.league), tournament: String(e.league),
      team1: e.team1 || '', team2: e.team2 || '',
      start: Date.parse(e.kickoff) || null,
      odds: [pick('1'), pick('2')], live, path, markets: [], size: null
    };
  });
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
      // "+3" beside the match: three more bet types than the winner shown.
      const more = Number(row.match(/class="event-more-view">\s*\+(\d+)/)?.[1] || 0);
      events.push({
        id, group: attr('data-event-treeId'), tournament, team1, team2,
        start: mskTime(row.match(/date-wrapper">\s*([^<]+?)\s*</)?.[1] || '', now),
        odds: [prices[0] ?? null, prices[1] ?? null],
        live: live || attr('data-live') === 'true', path: attr('data-event-path'),
        markets: [], size: size(1 + more, 'рынков')
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

// Sportbet's complete table endpoint, filtered by the official CS2 slug.
// An empty sports[] is a verified empty table; homepage/top/upcoming are not.
function parseSportbet(data, live) {
  return data.data.sports.filter(s => s.slug === 'esport-counter-strike')
    .flatMap(s => (s.tournaments || []).filter(t => isCyberClash(t.name))
      .flatMap(t => (t.events || []).filter(e => !['finished','ended','cancelled','closed'].includes(e.status)).map(e => {
        const winner = (e.markets || []).find(m => m.status === 'active' && /^(Победитель|Исход|Победа в матче)$/i.test(m.name));
        const quote = name => price(winner?.outcomes?.find(o => o.name === name && o.active !== false)?.odd);
        return {
          id:String(e.id), group:String(t.id), tournament:t.name,
          team1:e.teams?.team1?.name || '', team2:e.teams?.team2?.name || '',
          start:Number(e.scheduled) || null, odds:[quote('Поб 1'),quote('Поб 2')],
          live:live || e.status === 'live', score:e.score || '', markets:[], size:null
        };
      })));
}

// Baltbet: complete cyber sport prematch list, not the homepage's hot picks.
// Result2 and ExtResult2 coefficient IDs are described by superMarkets.
function parseBaltbet(data, live) {
  const result = data.superMarkets.find(m => m.kind === 'Result2');
  const maps = data.superMarkets.find(m => m.kind === 'ExtResult2');
  const idOf = (def, name) => def?.coefs?.find(c => c.name === name)?.id;
  const first = idOf(result, '1'), second = idOf(result, '2');
  if (!result || first == null || second == null) throw new Error('формат линии изменился: нет рынка победителя');
  const quote = (values, id) => price(values?.find(c => Number(c.smcid) === Number(id))?.value);
  return data.leagues.filter(l => isCyberClash(l.title) && /counter-?strike|cs\s*2/i.test(l.title))
    .flatMap(l => (l.events || []).map(e => {
      const values = e.markets?.find(m => Number(m.smid) === Number(result.id))?.coefs || [];
      const mapMarkets = (e.markets || []).filter(m => Number(m.smid) === Number(maps?.id))
        .map(m => market(m.coefs?.find(c => !maps.coefs?.find(d => Number(d.id) === Number(c.smcid))?.isNumeric)?.text || maps.name,
          '', [quote(m.coefs, idOf(maps,'1')),quote(m.coefs, idOf(maps,'2'))])).filter(Boolean);
      return {
        id:String(e.id), group:String(l.id), tournament:l.title,
        team1:e.team1 || '', team2:e.team2 || '', start:Number(e.startTime)*1000 || null,
        odds:[quote(values,first),quote(values,second)], live, path:e.webLink,
        markets:mapMarkets,
        size:size(e.additionalCoefsCount, 'доп. коэффициентов')
      };
    }));
}

const PARSERS = { sportbet: parseSportbet, baltbet: parseBaltbet, fonbet: parseFonbet, olimp: parseOlimp, marathon: parseMarathon, betcity: parseBetcity, leon: parseLeon };
export function parseFeed(bookmaker, body, live, now = Date.now()) {
  const parse = PARSERS[bookmaker.kind];
  if (!parse) throw new Error('Неизвестный формат линии.');
  // A successful HTTP response can still be a maintenance page or a changed
  // schema. Treat that as unavailable, never as proof that the tournament vanished.
  const data = bookmaker.kind === 'marathon' ? body : typeof body === 'string' ? JSON.parse(body) : body;
  const valid = ['fonbet', 'leon'].includes(bookmaker.kind) ? Array.isArray(data?.events) :
    bookmaker.kind === 'sportbet' ? data?.status === 'ok' && Number(data?.statusCode) === 200 && Array.isArray(data?.data?.sports) &&
      data.data.sports.every(s => s?.slug === 'esport-counter-strike' && Array.isArray(s.tournaments) &&
        s.tournaments.every(t => typeof t?.name === 'string' && Array.isArray(t.events) &&
          t.events.every(e => e && e.id != null && typeof e.status === 'string' &&
            typeof e.teams?.team1?.name === 'string' && typeof e.teams?.team2?.name === 'string' && Array.isArray(e.markets)))) :
    bookmaker.kind === 'baltbet' ? Number(data?.sportId) === 25 && Array.isArray(data?.superMarkets) && Array.isArray(data?.leagues) :
    bookmaker.kind === 'olimp' ? (Array.isArray(data) ? data : [data])
      .some(item => Array.isArray(item?.payload?.competitionsWithEvents)) :
    bookmaker.kind === 'betcity' ? data?.ok !== false && data?.reply?.sports &&
      typeof data.reply.sports === 'object' :
    bookmaker.kind === 'marathon' ? /class="[^"]*category-container/.test(String(data)) : true;
  if (!valid) throw new Error('формат линии изменился или источник вернул страницу ошибки');
  return parse(data, live, now).map(e => ({ ...e,
    start:Number.isFinite(e.start) && e.start > 0 && e.start <= 8640000000000000 ? e.start : null,
    url: bookmaker.eventUrl(e) }));
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
// The bookmaker's event for our match, in either order; odds in our order
// (a handicap turns around too: the other team at the opposite line).
const flipLine = line => !line || Number(line) === 0 ? line :
  line.startsWith('-') ? '+' + line.slice(1) : '-' + line.replace(/^\+/, '');
export function findMatch(events, team1, team2) {
  for (const e of events) {
    if (sameTeam(e.team1, team1) && sameTeam(e.team2, team2)) return { ...e, swapped: false };
    if (sameTeam(e.team1, team2) && sameTeam(e.team2, team1)) {
      const markets = (e.markets || []).map(m => m.kind === 'handicap' ?
        { ...m, line: flipLine(m.line), odds: [m.odds[1], m.odds[0]] } : m);
      return { ...e, swapped: true, odds: [e.odds[1], e.odds[0]], markets };
    }
  }
  return null;
}
// "Ф1 −5.5 1.90 · Ф2 +5.5 1.80", "ТБ 52.5 1.83 · ТМ 1.87" (team 1 is ours).
const two = v => v ? v.toFixed(2) : '—';
export function marketText(m) {
  if (m.kind === 'handicap') return `Ф1 ${m.line || '0'} ${two(m.odds[0])} · Ф2 ${flipLine(m.line) || '0'} ${two(m.odds[1])}`;
  if (m.kind === 'total') return `ТБ ${m.line} ${two(m.odds[0])} · ТМ ${two(m.odds[1])}`;
  return `${m.name}${m.line ? ' ' + m.line : ''} ${two(m.odds[0])} · ${two(m.odds[1])}`;
}
export const eventKey = (bookmakerId, e) => `${bookmakerId}:${e.id}`;

// Broadcast statistics, counted from the journal's events. Pure functions, no
// I/O: the events come from server/cs2-log.js, the HTTP side is
// server/cs2-api.js. What the server log carries (kills, damage, rounds, bomb,
// sides) is exact; what it does not (assists) is derived and says so. Only live
// rounds count: warm-up (round 0) kills are not a player's stats.
//
// Log text comes from players (their names, their chat): everything here stays
// data. A page shows it with textContent, a graphics package reads the JSON.

// SteamID3 → SteamID64. The sum is past Number.MAX_SAFE_INTEGER, so this is
// BigInt arithmetic: a graphics package or a HUD manager matching players by
// SteamID64 needs the exact digits, not a rounded ones.
const STEAM64_BASE = 76561197960265728n;
export function steamId64(steam) {
  const match = /^\[U:1:(\d+)\]$/.exec(String(steam || '').trim());
  return match ? (STEAM64_BASE + BigInt(match[1])).toString() : '';
}

// One player's identity inside a game. Real accounts are told apart by their
// SteamID3, because a name can change mid-match; bots all report «BOT», so they
// fall back to the name (that is all the log gives).
const isSteam3 = value => /^\[U:1:\d+\]$/.test(String(value || ''));
export function playerKey(player) {
  if (!player || !player.name) return '';
  return isSteam3(player.steam) ? player.steam : `${player.name}\u0000${player.steam || ''}`;
}

// How a round ended, as the server says it; `reason` keeps its own string.
// A planted bomb proves nothing on its own: the terrorists may still win by
// killing everyone before it goes off.
export const REASONS = {
  SFUI_Notice_CTs_Win: { text: 'CT победили', code: 'elimination' },
  SFUI_Notice_Terrorists_Win: { text: 'T победили', code: 'elimination' },
  SFUI_Notice_Target_Bombed: { text: 'бомба взорвалась', code: 'bomb' },
  SFUI_Notice_Bomb_Defused: { text: 'бомба разминирована', code: 'defuse' },
  SFUI_Notice_Target_Saved: { text: 'время вышло', code: 'time' },
  SFUI_Notice_Round_Draw: { text: 'ничья', code: 'draw' },
  SFUI_Notice_Terrorists_Escaped: { text: 'T ускользнули', code: 'escape' },
  SFUI_Notice_CTs_PreventEscape: { text: 'CT не дали ускользнуть', code: 'escape' },
  SFUI_Notice_Hostages_Rescued: { text: 'заложники спасены', code: 'hostage' },
  SFUI_Notice_VIP_Escaped: { text: 'VIP спасён', code: 'escape' },
  SFUI_Notice_VIP_Killed: { text: 'VIP убит', code: 'other' }
};

// The latest game in a list of events (0 when there are none).
export function lastGame(events) {
  let game = 0;
  for (const event of events) if (event.game > game) game = event.game;
  return game;
}

const blankPlayer = (player, key) => ({
  key, name: player.name, steam: isSteam3(player.steam) ? player.steam : '',
  steamid64: steamId64(player.steam), side: player.side || '', team: '',
  kills: 0, deaths: 0, assists: 0, headshots: 0, firstKills: 0, firstDeaths: 0,
  damage: 0, damageTaken: 0, friendlyDamage: 0, adr: 0,
  plants: 0, defuses: 0, roundsSurvived: 0, rounds: 0
});

// Every game in one pass: rounds in order, players with their counted stats,
// and which team each side was at each moment.
function analyze(events, game) {
  const rounds = new Map(), players = new Map(), sideName = { CT: '', T: '' };
  // The team of a side as the log reports it, so a round won by CT can be
  // attributed to a team name even after the half-time swap.
  const sideTeamAt = new Map();
  let map = '', live = false, over = false, ct = 0, t = 0;
  // Damage per victim per round: the assist goes to whoever hurt the victim
  // most, past the game's own bar of 40. Flash assists are not in damage lines.
  // One pass, no nested search.
  const hurt = new Map();
  // Health left per victim per round: damage past it (an AWP on 30 HP) is not
  // damage dealt, ADR counts only what the victim had.
  const health = new Map();
  // Who died in which round, by key (a name can change mid-match).
  const died = new Set();
  const roundOf = (n, clock) => {
    let round = rounds.get(n);
    if (!round) {
      round = { round: n, clock, startOffset: null, endOffset: null, winner: '', winnerTeam: '', reason: '',
        reasonCode: '', reasonText: '', ct: null, t: null, planted: false, defused: false, exploded: false,
        kills: [], duration: null };
      rounds.set(n, round);
    }
    return round;
  };
  const seen = (player) => {
    const key = playerKey(player);
    if (!key) return null;
    let entry = players.get(key);
    if (!entry) { entry = blankPlayer(player, key); players.set(key, entry); }
    // A name and a side can change; the last one the log showed is the truth.
    entry.name = player.name || entry.name;
    if (player.side) entry.side = player.side;
    if (!entry.steamid64) entry.steamid64 = steamId64(player.steam);
    return entry;
  };
  const teamOf = (player, round) => sideTeamAt.get(`${round}:${player.side}`) || sideName[player.side] || '';

  for (const event of events) {
    if (event.game !== game) continue;
    if (event.round < 1 && ['kill', 'damage', 'bomb'].includes(event.type)) continue;
    switch (event.type) {
      case 'map': map = event.map || map; break;
      case 'match_start': live = true; if (event.map) map = event.map; break;
      case 'game_over': over = true; ct = event.ct; t = event.t; if (event.map) map = event.map; break;
      case 'team': sideName[event.side] = event.name; break;
      case 'round_start': {
        const round = roundOf(event.round, event.clock);
        if (round.startOffset === null) round.startOffset = event.offset;
        // Remember who held which side in this round: after a swap the same
        // side name belongs to the other team.
        for (const side of ['CT', 'T']) if (sideName[side]) sideTeamAt.set(`${event.round}:${side}`, sideName[side]);
        break;
      }
      case 'round_result': {
        const round = roundOf(event.round);
        ct = event.ct; t = event.t;
        round.winner = event.winner; round.reason = event.reason;
        round.ct = event.ct; round.t = event.t;
        round.winnerTeam = sideTeamAt.get(`${event.round}:${event.winner}`) || sideName[event.winner] || '';
        const reason = REASONS[event.reason] || { text: `${event.winner} победили`, code: 'other' };
        round.reasonCode = reason.code; round.reasonText = reason.text;
        round.exploded = event.reason === 'SFUI_Notice_Target_Bombed';
        if (event.reason === 'SFUI_Notice_Bomb_Defused') round.defused = true;
        break;
      }
      case 'round_end': {
        const round = roundOf(event.round);
        if (round.endOffset === null) round.endOffset = event.offset;
        break;
      }
      case 'kill': {
        const killer = seen(event.killer), victim = seen(event.victim);
        if (!killer || !victim) break;
        const round = roundOf(event.round);
        if (!killer.team) killer.team = teamOf(event.killer, event.round);
        if (!victim.team) victim.team = teamOf(event.victim, event.round);
        // A teammate killed is a death, never a frag (the game takes a frag away).
        const teamkill = Boolean(event.killer.side) && event.killer.side === event.victim.side;
        victim.deaths++;
        died.add(`${event.round}\u0000${victim.key}`);
        if (!teamkill) {
          killer.kills++;
          if (event.headshot) killer.headshots++;
          // The first frag of a round is the entry frag.
          if (!round.kills.some(kill => !kill.teamkill)) { killer.firstKills++; victim.firstDeaths++; }
        }
        round.kills.push({
          at: event.offset, clock: event.clock, weapon: event.weapon, headshot: event.headshot,
          through: event.through, killer: killer.name, killerTeam: killer.team, killerSide: event.killer.side,
          victim: victim.name, victimTeam: victim.team, victimSide: event.victim.side, teamkill
        });
        if (teamkill) break;
        // An assist goes to whoever hurt this victim most in this round, over 40.
        const hurtHere = hurt.get(`${event.round}\u0000${victim.key}`);
        if (hurtHere) {
          let best = null;
          for (const [key, amount] of hurtHere) if (key !== killer.key && amount > 40 && (!best || amount > best.amount)) best = { key, amount };
          const helper = best && players.get(best.key);
          if (helper && helper !== victim) helper.assists++;
        }
        break;
      }
      case 'damage': {
        const attacker = seen(event.attacker), victim = seen(event.victim);
        if (!attacker || !victim || attacker === victim) break;
        const id = `${event.round}\u0000${victim.key}`;
        // The line gives the health left after the hit, so the health before it
        // is exact while the victim lives; the last hit takes only what was left.
        const given = Number(event.damage) || 0;
        const before = event.health > 0 ? event.health + given : health.get(id) ?? 100;
        const amount = Math.max(0, Math.min(given, before));
        health.set(id, Number.isFinite(event.health) ? event.health : before - amount);
        const own = event.attacker.side && event.victim.side && event.attacker.side === event.victim.side;
        if (own) attacker.friendlyDamage += amount; else attacker.damage += amount;
        if (!own) victim.damageTaken += amount;
        if (!attacker.team) attacker.team = teamOf(event.attacker, event.round);
        if (!victim.team) victim.team = teamOf(event.victim, event.round);
        if (!own) {
          const list = hurt.get(id) || new Map();
          list.set(attacker.key, (list.get(attacker.key) || 0) + amount);
          hurt.set(id, list);
        }
        break;
      }
      case 'bomb': {
        const player = seen(event.player);
        if (!player) break;
        if (!player.team) player.team = teamOf(event.player, event.round);
        const round = roundOf(event.round);
        if (event.action === 'Planted_The_Bomb') { player.plants++; round.planted = true; }
        if (event.action === 'Defused_The_Bomb') { player.defuses++; round.defused = true; }
        break;
      }
      case 'presence': {
        const player = seen(event.player);
        if (player && !player.team && event.player.side) player.team = teamOf(event.player, event.round);
        break;
      }
      default: break;
    }
  }

  // Rounds the game actually played: the denominator of ADR and of «survived».
  const liveRounds = [...rounds.values()].filter(round => round.round > 0);
  const played = liveRounds.length;
  for (const player of players.values()) {
    player.rounds = played;
    player.roundsSurvived = liveRounds.filter(round => !died.has(`${round.round}\u0000${player.key}`)).length;
    player.adr = played ? Math.round(player.damage / played) : 0;
  }
  const list = [...rounds.values()].sort((a, b) => a.round - b.round)
    .map(round => ({ ...round, duration: round.startOffset !== null && round.endOffset !== null ?
      Math.max(0, round.endOffset - round.startOffset) : null }));
  return { game, map, live, over, score: { ct, t }, sideName, rounds: list, players: [...players.values()] };
}

// One game's players, best first: a graphic reads them in this order.
export function playerStats(events, game = lastGame(events)) {
  const { players } = analyze(events, game);
  return players
    .filter(player => player.kills || player.deaths || player.damage || player.plants || player.defuses || player.assists)
    .sort((a, b) => b.kills - a.kills || b.damage - a.damage || b.assists - a.assists ||
      a.name.localeCompare(b.name, 'ru'))
    .map(({ key, ...player }) => ({ ...player, headshotRate: player.kills ? Math.round(player.headshots * 100 / player.kills) : 0,
      kd: player.deaths ? Math.round(player.kills / player.deaths * 100) / 100 : player.kills }));
}

// One game's rounds in order: the timeline a round-by-round graphic walks.
export function roundStats(events, game = lastGame(events)) {
  return analyze(events, game).rounds.filter(round => round.round > 0);
}

// The whole picture of one game, in the shape a graphics package asks for.
// `version` is in the payload so a graphic can refuse an older one loudly
// instead of drawing empty numbers.
export function summarize(events, status = {}, { game = lastGame(events) } = {}) {
  const found = analyze(events, game);
  const players = playerStats(events, game);
  // Teams are counted from the players, so a half-time swap does not move a
  // team's score to the other side's name. A team is known only by the name the
  // server gives it (mp_teamname_1/2 → «Team playing»): grouped by side, players
  // would trade their rounds at half-time, so without names there are no teams.
  const teams = [];
  for (const player of players) {
    const name = player.team;
    if (!name) continue;
    let team = teams.find(entry => entry.name === name);
    if (!team) teams.push(team = { name, side: player.side, score: 0, roundsWon: 0, players: [] });
    team.players.push(player.name);
    if (player.side && !team.side) team.side = player.side;
  }
  for (const round of found.rounds) {
    const team = round.winnerTeam && teams.find(entry => entry.name === round.winnerTeam);
    if (team) { team.roundsWon++; team.score++; }
  }
  return {
    version: 1, generatedAt: Date.now(), game, map: found.map || status.map || '',
    live: found.live || Boolean(status.live), over: found.over || Boolean(status.over),
    // The score by side is the server's own: authoritative, and what the HUD
    // shows. `teams[].score` is the same number attributed to a team name.
    score: { ct: found.score.ct || status.ct || 0, t: found.score.t || status.t || 0 },
    sides: { CT: found.sideName.CT || status.teams?.CT || '', T: found.sideName.T || status.teams?.T || '' },
    teams: teams.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru')),
    rounds: roundStats(events, game), players,
    totals: { rounds: players[0]?.rounds || 0, kills: players.reduce((sum, p) => sum + p.kills, 0) }
  };
}

// CSV for a spreadsheet; one row per player of one game.
const CSV_COLUMNS = [
  ['name', 'Ник'], ['steamid64', 'SteamID64'], ['team', 'Команда'], ['side', 'Сторона'],
  ['kills', 'Фраги'], ['deaths', 'Смерти'], ['assists', 'Ассисты'], ['headshots', 'Хедшоты'],
  ['headshotRate', 'HS %'], ['damage', 'Урон'], ['adr', 'ADR'], ['firstKills', 'Первые фраги'],
  ['firstDeaths', 'Первые смерти'], ['plants', 'Планты'], ['defuses', 'Дефьюзы'],
  ['roundsSurvived', 'Выжил раундов'], ['rounds', 'Раундов'], ['kd', 'K/D']
];
const csvCell = value => {
  let text = String(value ?? '');
  // A nick or a team name comes out of the game log, and the file is opened in
  // Excel: a cell starting with «=», «+», «-» or «@» is read as a formula, so a
  // player could name themselves «=HYPERLINK(…)» and have it run on the
  // operator's machine. An apostrophe in front makes Excel keep it as text.
  // A plain number is left alone, so the stats stay numbers in the sheet.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = `'${text}`;
  // A comma is quoted too: an Excel set to «,» would split «a,=cmd…» into a
  // fresh cell that starts with «=», past the apostrophe above.
  return /[";,\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function toCsv(players) {
  // A semicolon: the Russian Excel opens such a file by a double click.
  const head = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(';');
  const rows = players.map(player => CSV_COLUMNS.map(([key]) => csvCell(player[key])).join(';'));
  return [head, ...rows].join('\r\n') + '\r\n';
}

// NDJSON: one event per line, for a graphics engine that follows the match
// live and wants to append, not to re-read everything.
export function toNdjson(events) {
  return events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

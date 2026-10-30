// eBot match list without DOM: the panel's own view of the eBot web page
// (37.230.228.105 or any eBot-CSGO-Web install). The list of matches in
// progress is public there; the panel reads it through this site's proxy
// (/api/ebot) so no third-party origin is opened from the browser. Live
// score changes arrive as small "diff" events this module turns into
// journal-ready texts. Nothing here runs in the Claude artifact.
export const EBOT_PROXY = '/api/ebot';

// A number from the page ("1", "12") — eBot lists 12 per page; the panel
// only ever reads the first page, which holds the live matches.
export function parseEbotMatches(html) {
  const matches = [];
  // Two list layouts exist: the home page with two empty flag cells around
  // the names, /matchs/current without them. Rows are anchored on the score
  // div; team names sit beside it, the map and status are found by content.
  const rowPattern = /<tr\b[^>]*>[\s\S]*?<\/tr>/g;
  for (const row of String(html ?? '').match(rowPattern) || []) {
    const scoreMatch = row.match(/id="score-(\d+)"[^>]*>([\s\S]*?)<\/div>/);
    if (!scoreMatch) continue;
    const cells = (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || [])
      .map(cell => text(cell));
    // The score cell itself: find its index so the names are its neighbours.
    const scoreIndex = cells.findIndex(cell => /^\d+\s*-\s*\d+$/.test(cell));
    if (scoreIndex < 1) continue;
    const teamA = cells[scoreIndex - 1], teamB = cells[scoreIndex + 1] || '';
    // Map is the only de_* cell; status is the last non-"Show" text cell.
    const map = cells.find(cell => /^de_[a-z0-9_]+$/i.test(cell)) || '';
    const status = cells.filter((cell, i) => cell && i > scoreIndex + 1 && cell !== 'Show').pop() || '';
    const numbers = (scoreMatch[2].match(/-?\d+/g) || ['0', '0']).map(Number);
    matches.push({ id: scoreMatch[1], teamA, teamB, map, scoreA: numbers[0] || 0, scoreB: numbers[1] || 0, status });
  }
  return matches;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function text(html) {
  return html.replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z#0-9]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ').trim();
}

// Only statuses the broadcast team cares about: a match that is running now.
export function isLive(match) {
  return !/^(Finished|Archived|Stop|Canceled)/i.test(match.status);
}

// Diff between two reads: score changes and status changes, as texts for
// the lobby journal. The first read of an unknown match is a note too, so
// a panel opened late still sees the match arrive.
export function ebotEvents(before, after) {
  const events = [];
  const beforeById = new Map(before.map(m => [m.id, m]));
  for (const match of after) {
    const old = beforeById.get(match.id);
    if (!old) {
      events.push({ type: 'start', match, text: `eBot: ${match.teamA} — ${match.teamB}, статус «${match.status}»` });
      continue;
    }
    if (old.scoreA !== match.scoreA || old.scoreB !== match.scoreB) {
      const winner = match.scoreA > match.scoreB ? match.teamA : match.teamB;
      const note = old.status !== match.status && /Finished/i.test(match.status) ?
        `eBot: ${match.teamA} ${match.scoreA}:${match.scoreB} ${match.teamB} — матч завершён, победа ${winner}` :
        `eBot: ${match.teamA} ${match.scoreA}:${match.scoreB} ${match.teamB}`;
      events.push({ type: /Finished/i.test(match.status) ? 'match' : 'score', match, text: note });
    } else if (old.status !== match.status) {
      events.push({ type: 'status', match, text: `eBot: ${match.teamA} — ${match.teamB}: ${old.status} → ${match.status}` });
    }
  }
  return events;
}

export function ebotStatusLine(matches, updatedAt = 0) {
  const live = matches.filter(isLive);
  const finished = matches.length - live.length;
  const when = updatedAt ? ` · обновлено ${new Date(updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '';
  return `eBot: идут ${live.length} · завершено ${finished}${when}`;
}

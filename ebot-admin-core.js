// Чистая логика вкладки «eBot» без DOM (покрыта test/ebot-admin-ui.test.js):
// форматирование строки таблицы матчей, класс статуса, валидация формы
// создания и текст строки команды. eBot-данные проходят только через
// строки/числа — innerHTML не нужен.

// Строка таблицы матчей: все поля — строки, пустые eBot-поля (карта,
// статус) не ломают таблицу. Ник из eBot — только текст ячейки.
export function formatMatchRow(match) {
  return {
    id: String(match.id ?? ''),
    teamA: match.teamA || '—',
    teamB: match.teamB || '—',
    score: `${match.scoreA ?? 0} : ${match.scoreB ?? 0}`,
    map: match.map || '',
    status: match.status || '—'
  };
}

// Класс строки по статусу: running → live, завершён → done, остальное
// (Not started и прочее) — без подсветки, но стартуемое отличаем.
export function statusClass(statusText) {
  if (/Finished|Archived/i.test(statusText || '')) return 'is-done';
  if (/^Not started/i.test(statusText || '')) return 'is-pending';
  if (/Stop|Canceled/i.test(statusText || '')) return 'is-stopped';
  return 'is-live';
}

// Валидация формы создания: команды обязательны и различны, карта
// обязательна. Сервер — второй по важности, но без него eBot сам выберет,
// поэтому отдельного требования нет (возвращает '' при успехе).
export function validateCreateForm(value) {
  const teamA = String(value.teamA || '').trim();
  const teamB = String(value.teamB || '').trim();
  const map = String(value.map || '').trim();
  if (!teamA) return 'Выбери команду A.';
  if (!teamB) return 'Выбери команду B.';
  if (teamA.toLowerCase() === teamB.toLowerCase()) return 'Команды A и B должны быть разными.';
  if (!map) return 'Выбери карту — без карты eBot матч не создаст.';
  if (!['1', '3', '5'].includes(String(value.mapsCount))) return 'Количество карт: 1, 3 или 5.';
  return '';
}

// Строка таблицы команд: название и состав (ники через запятую).
export function teamRowText(team) {
  const players = Array.isArray(team?.players) ? team.players.filter(Boolean).join(', ') : '';
  return { name: String(team?.name || ''), players: players || '—' };
}

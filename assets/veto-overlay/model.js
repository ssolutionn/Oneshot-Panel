import { MAP_POOL, VETO_RULES, validateVeto, appendVeto } from '../../core.js';

export { MAP_POOL };
export const DEMO_TEAMS = ['Bushido Wildcats', 'Johnny Speeds'];
const DEMO_ORDER = ['Ancient', 'Anubis', 'Mirage', 'Nuke', 'Dust2', 'Cache'];

export function snapshot(value) {
  if (!value || typeof value !== 'object') throw new Error('Нет состояния вето.');
  const teams = value.teams;
  if (!Array.isArray(teams) || teams.length !== 2 ||
      !teams.every(name => typeof name === 'string' && name.trim() &&
        name.length <= 100 && !/[\r\n\x00-\x1f]/.test(name)) ||
      teams[0].trim() === teams[1].trim()) {
    throw new Error('Нужны две разные команды.');
  }
  const format = value.format, first = value.first;
  const actions = value.actions;
  const remaining = validateVeto(actions, format, first);
  const pending = value.pending || null;
  if (pending && (!remaining.includes(pending) ||
      VETO_RULES[format][actions.length] !== 'pick')) {
    throw new Error('Некорректный выбор стороны.');
  }
  const stage = typeof value.stage === 'string' ? value.stage.slice(0, 100) : 'GROUP STAGE';
  return {
    version:1, teams:teams.map(name => name.trim()), format, first,
    actions:actions.map(a => ({ map:a.map, type:a.type, team:a.team,
      ...(a.type === 'pick' ? { side:a.side } : {}) })),
    pending, stage
  };
}

export function viewModel(value) {
  const state = snapshot(value);
  const remaining = validateVeto(state.actions, state.format, state.first);
  const finished = state.actions.length === 6;
  const nextTeam = (state.first + state.actions.length) % 2;
  const nextType = VETO_RULES[state.format][state.actions.length];
  const maps = MAP_POOL.map(name => {
    const index = state.actions.findIndex(a => a.map === name);
    const action = state.actions[index];
    const left = finished && !action;
    return {
      name, status:action?.type || (left ? 'leftover' : state.pending === name ? 'pending' : 'available'),
      step:index < 0 ? (left ? 7 : null) : index + 1,
      team:action?.team ?? null,
      sideTeam:action?.type === 'pick' ? 1 - action.team : null,
      side:action?.side || null,
      ownSide:action?.type === 'pick' ? (action.side === 'CT' ? 'T' : 'CT') : null
    };
  });
  const series = state.actions.filter(a => a.type === 'pick').map(a => a.map);
  if (finished) series.push(remaining[0]);
  return { ...state, maps, series, finished, nextTeam, nextType, remaining,
    // BO2 has two maps and no deciding map. The untouched map is still played.
    leftoverLabel:state.format === 'BO2' ? 'MAP 02' : 'DECIDER'
  };
}

export function demoState(format = 'BO3', count = 2, first = 0) {
  let actions = [];
  for (let i = 0; i < Math.max(0, Math.min(6, count)); i++) {
    actions = appendVeto(actions, format, first, DEMO_ORDER[i], i % 2 ? 'T' : 'CT');
  }
  return snapshot({ teams:DEMO_TEAMS, format, first, actions, stage:'GROUP STAGE' });
}

export function nextDemoMap(state) { return DEMO_ORDER[state.actions.length]; }

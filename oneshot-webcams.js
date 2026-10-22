// Custom webcam tool module for Oneshot Panel: replaces the external Python/Node
// crop script with direct VDO.Ninja individual player camera streams, styled
// and positioned exactly as the OBS JSON requires.

export class OneshotWebcams {
  constructor(container, { onSelect = () => {} } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.activePlayer = null;
    this.streams = new Map();
  }
  // Renders the 10 camera slots directly in the panel with live preview frames
  render(players, liveIds = new Set()) {
    if (!this.container) return;
    this.container.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'oneshot-webcams-grid';

    players.forEach((p, idx) => {
      const slot = idx + 1;
      const card = document.createElement('div');
      card.className = 'oneshot-cam-card';
      const isLive = liveIds.has(p.id);

      card.innerHTML = `
        <div class="cam-card-header">
          <span class="cam-slot">CAM ${String(slot).padStart(2, '0')}</span>
          <span class="cam-status ${isLive ? 'live' : ''}">${isLive ? 'В эфире' : 'Нет сигнала'}</span>
        </div>
        <div class="cam-player-info">
          <b>${p.team || ''}</b> · ${p.nick || ''}
        </div>
        <div class="cam-preview-frame" data-slot="${slot}">
          <div class="cam-placeholder">Ожидание камеры...</div>
        </div>
      `;
      grid.appendChild(card);
    });
    this.container.appendChild(grid);
  }
}

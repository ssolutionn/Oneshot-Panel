import pandas as pd, numpy as np, os, subprocess, json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import imageio_ffmpeg

kills = pd.read_csv('real_kills.csv')
pos = pd.read_parquet('real_positions.parquet')
pos = pos.rename(columns={'name': 'player'})
pos = pos[pos['health'] > 0]

XMIN, XMAX = -2300, 2300
YMIN, YMAX = -2500, 2200
W, H = 900, 1000
TICKRATE = 64
FPS = 12

def to_px(x, y):
    return (x - XMIN) / (XMAX - XMIN) * W, (YMAX - y) / (YMAX - YMIN) * H

os.makedirs('render/frames', exist_ok=True)

gr = kills[kills['attacker_name'].notna()].groupby(['total_rounds_played', 'attacker_name']).size().reset_index(name='n')
gr = gr[gr['n'] >= 3].sort_values('n', ascending=False)
print('Highlights:', gr.to_string())

def render_clip(round_num, player, out_name, pre_s=6, post_s=4):
    k = kills[(kills['total_rounds_played'] == round_num) & (kills['attacker_name'] == player)]
    if k.empty: return None
    t0, t1 = int(k['tick'].min()), int(k['tick'].max())
    start, end = max(0, t0 - pre_s * TICKRATE), t1 + post_s * TICKRATE
    win = pos[(pos['tick'] >= start) & (pos['tick'] <= end)]
    maps = win[['tick', 'player', 'X', 'Y', 'team_name']].set_index('tick')
    ticks_all = sorted(maps.index.unique())
    step = max(1, TICKRATE // FPS)
    ticks_sel = ticks_all[::step]
    kx = k.set_index('tick')
    for frame, tick in enumerate(ticks_sel):
        snap = maps.loc[[tick]]
        fig, ax = plt.subplots(figsize=(W/100, H/100), dpi=100)
        ax.set_facecolor('#141e14')
        ax.set_xlim(0, W); ax.set_ylim(H, 0)
        ax.set_xticks([]); ax.set_yticks([])
        for s in ax.spines.values(): s.set_color('#2c3e2c')
        # schematic callouts grid
        for gx in range(XMIN, XMAX, 500): ax.axvline(to_px(gx, 0)[0], color='#223022', lw=0.4)
        for gy in range(YMIN, YMAX, 500): ax.axhline(to_px(0, gy)[1], color='#223022', lw=0.4)
        ct = t = 0
        for _, row in snap.drop_duplicates('player').iterrows():
            px, py = to_px(row['X'], row['Y'])
            team = row['team_name']
            color = '#4F9BD9' if team == 'CT' else '#DE9152'
            if team == 'CT': ct += 1
            else: t += 1
            hero = row['player'] == player
            ax.scatter([px], [py], s=260 if hero else 100, c=color,
                       edgecolors='#FFD700' if hero else 'none',
                       linewidths=2.5 if hero else 0, zorder=3)
            ax.annotate(row['player'], (px, py - 16), color='#FFD700' if hero else '#cccccc',
                        fontsize=10 if hero else 7, ha='center',
                        weight='bold' if hero else 'normal')
        seen = 0
        for kt, kk in kx[kx.index <= tick].iterrows():
            jx, jy = to_px(kk['user_X'], kk['user_Y'])
            ax.scatter([jx], [jy], marker='x', c='red', s=150, linewidths=2.5, zorder=4)
            seen += 1
        ax.text(W/2, 34, f'ROUND {int(round_num)+1}  ·  {player}  ·  {ct}v{t}  ·  KILLS {seen}',
                color='white', fontsize=13, ha='center', weight='bold',
                bbox=dict(boxstyle='round,pad=0.4', facecolor='black', alpha=0.8))
        ax.text(W/2, H-24, 'ONESHOT HIGHLIGHTS  ·  de_ancient  ·  FACEIT',
                color='#888888', fontsize=8, ha='center')
        fig.savefig(f'render/frames/{out_name}_{frame:05d}.png')
        plt.close(fig)
    out_path = f'render/{out_name}.mp4'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-framerate', str(FPS),
                    '-i', f'render/frames/{out_name}_%05d.png',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23',
                    '-movflags', '+faststart', out_path], check=True, capture_output=True)
    for f in os.listdir('render/frames'):
        if f.startswith(out_name): os.remove(os.path.join('render/frames', f))
    size = os.path.getsize(out_path)
    print(f'RENDERED {out_path}  {size/1024:.0f} KB')
    return out_path

meta = []
for _, r in gr.head(5).iterrows():
    rn = int(r['total_rounds_played'])
    player = r['attacker_name']
    safe = player.replace('-', '').replace('_', '')
    name = f'hl_r{rn+1}_{safe}'
    try:
        p = render_clip(rn, player, name)
        if p:
            meta.append({'round': rn + 1, 'player': player, 'kills': int(r['n']),
                         'file': os.path.basename(p), 'size': os.path.getsize(p)})
    except Exception as e:
        print('FAIL', player, repr(e))

json.dump(meta, open('render/rendered.json', 'w'), indent=2)
print('DONE:', json.dumps(meta, indent=2))

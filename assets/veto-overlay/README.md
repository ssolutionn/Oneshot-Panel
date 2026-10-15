# CyberClash live veto

1920×1080 full frame. New layout=strip&crop=1 links are a native 1920×400
bottom strip; place the source at X=0,Y=680 in a 1080p scene, with camera sources
below it in OBS layer order. Legacy strip URLs keep the transparent 1080p frame.
Local event artwork, team logos and maps. Tall condensed Oswald display type
(Latin/Cyrillic, SIL OFL) echoes the CyberClash wordmark; small captions retain
a readable sans-serif. The font is local and loads before canvas rendering/PNG.
 WebGL smoke with a moving Canvas2D
fallback. Reduced-motion settings disable smoke and card transitions.

## Add to OBS

1. In the panel copy «Ссылка на оверлей для OBS».
2. OBS → Sources → + → Browser; paste the URL, set 1920×1080.
3. Keep the panel open with «Оверлей вето в OBS вживую» enabled
   (copying the URL enables it).
4. Wait for «Оверлей получает вето», then make the manual veto moves.

The Oneshot dock controls cameras. The graphic is a separate browser source.
Its live link works independently of the OBS password and control connection.
After upgrading an old source URL, copy a fresh link containing `&r=`.

## State and delivery

- `#s=<base64url snapshot>` supplies the initial state.
- `&r=<display code>` starts a display-only encrypted VDO.Ninja data channel.
  The panel publishes (push); overlays view that stream and acknowledge valid
  applied snapshots. This code is separate from the OBS control pairing code.
- Messages: `veto-state {id,state}` and `veto-received {id}`. Only the latter
  matching the current revision marks the graphic as receiving updates.
- Every 2.5 seconds the panel repeats the latest full state. This covers a
  late source, reconnect or reload. Repeated state does not restart animations.
- Both computers need network access to VDO.Ninja. No OBS password is included
  in the overlay URL. CSP is unchanged.
- Native `oneshot-veto` events are accepted for compatibility. An accepted
  obs-websocket vendor request alone does not prove browser delivery.
- `window.vetoOverlay.setState(snapshot, {animate:true|false})`, getState,
  png, setLayout and stopMotion remain available.

Snapshot: `{version:1,teams:[A,B],format,first,actions,pending,stage}`.
Pick sides belong to the opposing team, matching core.js. Invalid updates
leave the previous state on air.

## Rendering

Seven fixed columns follow veto turns. BO3 is always BAN BAN PICK PICK BAN
BAN DECIDER. Empty slots wait for maps; pending side choice stays in its pick
column, undo clears its own slot. Other formats use existing core.js rules.

900ms bans desaturate the map and draw a red cross; picks have a cyan sweep,
border and brief PICK stamp. The stamp appears on the pending map choice,
before the opposing team selects CT/T; completing that choice preserves an
already running reveal and does not replay it. The decider waits 1500ms after
the final move; repeated snapshots preserve the deadline. Restored snapshots
and PNG exports show the settled outcome. Undo takes 650ms. PNG export uses settled
1920×1080 pixels, including alpha in strip mode.

Demo: `overlay.html?preview=1`, optionally layout=strip, step=0..6,
format=BO1/BO2/BO3/BO5, motion=off, animations=off. Demo data is labelled and
does not connect to a live display stream.

## Verification

`npm run check && npm test`
`python3 scripts/qa_veto_overlay.py`
`python3 scripts/qa_live.py`

The renderer QA checks real pixels, smoke movement/freeze, Canvas2D fallback,
fixed order, ban/pick/undo transitions, PNG dimensions/alpha, reduced motion
and missing artwork. Panel QA uses a simulated VDO network but the actual
encrypted sender and receiver.

`.github/workflows/obs-runtime.yml` additionally exercises official OBS with
its actual CEF browser plugin over real VDO.Ninja. It checks manual moves,
receiver acknowledgements, animated cards, moving smoke and source reload.

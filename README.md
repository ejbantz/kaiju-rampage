# Kaiju Rampage

An ASCII kaiju game that runs in your browser. Stomp the city, eat the
civilians, shoot down the helicopters, and try not to get blown up.

**▶ [Play it here](https://ejbantz.github.io/kaiju-rampage/)**

```
 WAVE 1   SCORE 775   x4   STANDING 7   EATEN 0
 HP #################### 100    ATOMIC ####################    COMBO 9

                        _________       ___+___                      ( )
                        |       |    v^<[ o o ]>
           _________    |. o . .|   |    \_/ |
           |       |    |       |   |o o o o |                     .----.
   ______  |o . . o|    |o o o .|   |o o o . |                    / o    \
   |    |  |       |    |       |   |        |          ^^       |   \__/
   |. o |  |o . o o|    |. o o o|   |. o o . |        ^^^^^^^^^^ |#####\
   |    |  |       |    |       |   |        |       /         \ |######\__
   |o o |  |o . . .|    |. . . o|   |o o . o |      <    /\      |######   /
   |    |  |       |    |       |   |        |       \__/  \     |######\_/
   |. o |  |o o o .|    |o o o .|   |. o . . |              \    |######|
   |    |oo|       |    |       |   |        |               \   |##||##|
   |o . //|\/|\ o .|    |. o /|\|   |. . . . |   <|>   /|\       |__||__|
====================================================================================
```

## Controls

| Key | Action |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> or <kbd>A</kbd> <kbd>D</kbd> | Walk |
| <kbd>Space</kbd> | Stomp — buildings *and* civilians underfoot |
| <kbd>F</kbd> | Atomic breath — costs energy, downs helicopters |
| <kbd>P</kbd> | Pause |
| <kbd>B</kbd> | Toggle sound |
| <kbd>M</kbd> | Toggle music |
| <kbd>-</kbd> <kbd>+</kbd> | Volume (or use the slider, top-right) |
| <kbd>R</kbd> | Restart (after game over) |

On phones and tablets, on-screen buttons appear automatically. Landscape
works much better than portrait.

## Difficulty

Pick one on the title screen; your choice is remembered. Measured against a
bot that seeks buildings, stomps, and breathes on cooldown but never dodges
-- a deliberate lower bound, since dodging is the main survival skill:

| | Bot survived | Wave reached |
|---|---|---|
| **EASY** | never died | 12 |
| **NORMAL** *(default)* | ~60s | 4 |
| **HARD** | ~34s | 2 |
| **NIGHTMARE** | ~16s | 1 |

Difficulty scales what actually creates pressure: missile and shell damage,
how fast the military arrives and how much of it there is, how much health a
civilian restores, energy regeneration, how many floors a stomp takes off,
and how much you recover between waves.

## How it plays

Flatten every building to clear a wave. Each wave adds another helicopter
(up to five) and tightens their fire rate, while granting you +25 HP, full
energy, and 200 points.

- **Tanks.** Ground armour rolls in, closes to a ~26 column standoff, and
  fires flat shells at body height. You cannot walk out from under them the
  way you can a helicopter: either breathe down the lane, which scorches
  every tank in its path regardless of height, or close in and stomp one --
  which means entering the range it is already shooting at.
- **Combos.** Every hit inside a 45-tick window builds a multiplier up to
  **×5**. Taking a hit resets it to zero. That's the core tension: press
  the rampage for score, or back off and survive.
- **Healing.** Eating a civilian restores 3 HP. They outrun a casual stroll
  but not a committed charge, so chasing them down is how you stay alive.
- **Atomic breath** costs 30 of 100 energy and regenerates at 0.8/tick —
  roughly one blast every two seconds. It cannot be spammed.
- **Stomping** has a 9-tick cooldown, so timing beats key-mashing.

## No sound?

The note icon by the volume slider turns **amber** when the audio context is
not actually running — tap or click anywhere to start it.

**On iPhone and iPad, check the physical silent/ringer switch first.** iOS
mutes Web Audio when that switch is engaged, even at full volume, and no
amount of JavaScript overrides it. The page plays a looping silent audio
element to promote itself to the "playback" audio session, which works around
this in most cases, but the switch can still win.

Other things worth knowing on WebKit: the audio context only truly starts if
a buffer is *played* inside a user gesture (`resume()` alone can leave it
suspended), and iOS suspends it again whenever the page is backgrounded or
the screen locks. The game handles both, re-arming on any tap, key, or
visibility change.

## Running locally

No build step, no dependencies, no package manager. Clone it and open
`index.html`, or serve the directory:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

## How it works

Everything is composed into a **character grid**, exactly like the terminal
original this was ported from, and that grid is blitted to a `<canvas>` in
colour-batched runs — consecutive same-colour cells become one `fillText`
call, which keeps a 30-row screen cheap to redraw at ~18 fps.

A few details worth calling out:

- **One sprite, both directions.** The kaiju is drawn facing right only. A
  `flip()` helper reverses each row and swaps directional glyphs
  (`/\`, `()`, `<>`, `[]`, `{}`) so the art bends the right way when mirrored.
- **Scanline occlusion.** Sprites blank each row only from its first to its
  last ink column, so the kaiju is opaque against the skyline without
  punching a rectangular hole around his silhouette.
- **Synthesised chiptune audio.** There are no sound files. Every effect and
  every note of the soundtrack are built live from square, pulse and triangle
  voices, filtered-noise percussion, and stepped arpeggios. The music is an
  original four-bar-per-pattern song in A minor with bass, arpeggio, lead and
  drum channels, arranged `A-A-B-A-C-C-B-A` so the loop runs about a minute,
  and the tempo climbs with each wave. Effects and music sit on separate gain
  buses under a master the player controls, so sound always cuts through. Voices are kept
  in the 200 Hz - 4 kHz band on purpose: an earlier version swept down to
  35 Hz and was inaudible on laptop and phone speakers, which roll off hard
  below ~200 Hz. The synth takes its `AudioContext` by injection, so the
  same code renders into an `OfflineAudioContext` and the output can be
  measured rather than guessed at.
- **Fixed timestep.** Simulation runs on a 55 ms accumulator independent of
  the display refresh rate, with a clamp so a backgrounded tab doesn't
  fast-forward the whole city on return.

## Origin

Ported from a Python/`curses` terminal game. The sprites, layout, and
mechanics are unchanged — only the rendering and audio backends differ.

## Licence

MIT — see [LICENSE](LICENSE).

/* Kaiju Rampage -- an ASCII kaiju game for the browser.
 *
 * Ported from a Python/curses original. The rendering model is deliberately
 * kept: everything is composed into a character grid, then that grid is
 * blitted to a canvas in colour-batched runs. Keeping the terminal model
 * means the sprites, occlusion and layout logic port over unchanged.
 */
'use strict';

// ----------------------------------------------------------------- tuning
const MAX_HP = 100;
const MAX_EN = 100;
const BREATH_COST = 30;
const EN_REGEN = 0.8;
const MISSILE_DAMAGE = 12;
const CIV_HEAL = 3;
const COMBO_WINDOW = 45;
const HELI_BASE_COOLDOWN = 70;
const STOMP_COOLDOWN = 9;
const TICK_MS = 55;

const COLOR = {
  kaiju:    '#5ee88a',
  concrete: '#9aa6b8',
  window:   '#ffd66b',
  fire:     '#ff5f56',
  hud:      '#5fd7ff',
  star:     '#e8eef7',
  civ:      '#e07bff',
  dim:      '#4a5568',
  dimWin:   '#6b5a2e',
  rubble:   '#8a3b36',
};

// ---------------------------------------------------------------- sprites
const sprite = (block) => {
  const rows = block.replace(/^\n+|\n+$/g, '').split('\n');
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => r.padEnd(w));
};

const MIRROR = { '/': '\\', '\\': '/', '(': ')', ')': '(', '<': '>', '>': '<',
                 '[': ']', ']': '[', '{': '}', '}': '{' };
const flip = (rows) =>
  rows.map((r) => [...r].reverse().map((c) => MIRROR[c] || c).join(''));

const WALK_R = [
  sprite(String.raw`
              .----.
             / o    \
        ^^  |   \__/
       ^^^^ |#####\
      ^^^^^^|######\__
     /     \|######   /
    /       |######\_/
   <   /\   |######|
    \_/  \  |##||##|
          \ |##||##|
            |__||__|
`),
  sprite(String.raw`
              .----.
             / o    \
        ^^  |   \__/
       ^^^^ |#####\
      ^^^^^^|######\__
     /     \|######   /
    /       |######\_/
   <   /\   |######|
    \_/  \  |##||##|
          \ |##| |##|
            |__| |__|
`),
];

const STOMP_R = sprite(String.raw`
              .----.
             / O    \
        ^^  |   \__/
       ^^^^ |#####\
      ^^^^^^|######\__
     /     \|######   /
    /       |######\_/
   <   /\   |######|
    \_/  \ /##||##\
         /##/  \##\
        |__/    \__|
`);

const ROAR_R = sprite(String.raw`
              .----.
             / O   =\
        ^^  |   \VV/
       ^^^^ |#####\
      ^^^^^^|######\__
     /     \|######   /
    /       |######\_/
   <   /\   |######|
    \_/  \  |##||##|
          \ |##||##|
            |__||__|
`);

const WALK_L = WALK_R.map(flip);
const STOMP_L = flip(STOMP_R);
const ROAR_L = flip(ROAR_R);
const GZ_H = WALK_R[0].length;
const GZ_W = WALK_R[0][0].length;

const HELI_R = [
  sprite(String.raw`
 ___+___
<[ o o ]>
   \_/
`),
  sprite(String.raw`
 ---+---
<[ o o ]>
   \_/
`),
];
const HELI_L = HELI_R.map(flip);
const HELI_W = HELI_R[0][0].length;

const CIV = [[' o ', '/|\\'], [' o ', '<|>']];

const BOOM = [
  [' \\|/ ', ' -*- ', ' /|\\ '],
  [' \\ / ', '  *  ', ' / \\ '],
  ['  .  ', ' . . ', '  .  '],
];

// ------------------------------------------------------------------ screen
class Screen {
  constructor(canvas, cols, rows) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cols = cols;
    this.rows = rows;
    this.ch = new Array(cols * rows).fill(' ');
    this.fg = new Array(cols * rows).fill(COLOR.concrete);
    this.layout();
  }

  layout() {
    const pad = 8;
    const availW = Math.max(240, window.innerWidth - pad * 2);
    const availH = Math.max(200, window.innerHeight - pad * 2);
    // monospace glyphs run about 0.6 as wide as they are tall
    let size = Math.min(availW / (this.cols * 0.6), availH / (this.rows * 1.08));
    size = Math.max(6, Math.floor(size));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
    this.cw = this.ctx.measureText('M').width;
    this.chh = size * 1.08;
    this.size = size;

    const w = Math.ceil(this.cw * this.cols);
    const h = Math.ceil(this.chh * this.rows);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.textBaseline = 'top';
    this.ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
  }

  clear() {
    this.ch.fill(' ');
  }

  /** Bounds-safe write of `text` at row y, column x. */
  put(y, x, text, color) {
    if (y < 0 || y >= this.rows) return;
    let s = String(text);
    if (x < 0) { s = s.slice(-x); x = 0; }
    if (x >= this.cols) return;
    s = s.slice(0, this.cols - x);
    const base = y * this.cols;
    for (let i = 0; i < s.length; i++) {
      this.ch[base + x + i] = s[i];
      this.fg[base + x + i] = color;
    }
  }

  /** Draw a sprite. When opaque, the silhouette blanks whatever is behind it.
   *  Blanking the full bounding box would punch a rectangular hole in the
   *  skyline, so each row only clears from its first to its last ink column. */
  blit(y, x, rows, color, opaque = true) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const right = row.replace(/\s+$/, '').length;
      if (!right) continue;
      const left = row.length - row.replace(/^\s+/, '').length;
      if (opaque) this.put(y + i, x + left, ' '.repeat(right - left), COLOR.dim);
      for (let j = left; j < right; j++) {
        if (row[j] !== ' ') this.put(y + i, x + j, row[j], color);
      }
    }
  }

  /** Blit the grid to canvas, batching consecutive same-colour runs. */
  flush() {
    const ctx = this.ctx;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (let y = 0; y < this.rows; y++) {
      const base = y * this.cols;
      let x = 0;
      while (x < this.cols) {
        const c = this.ch[base + x];
        if (c === ' ') { x++; continue; }
        const color = this.fg[base + x];
        let run = c;
        let k = x + 1;
        while (k < this.cols && this.ch[base + k] !== ' ' && this.fg[base + k] === color) {
          run += this.ch[base + k];
          k++;
        }
        ctx.fillStyle = color;
        ctx.fillText(run, x * this.cw, y * this.chh);
        x = k;
      }
    }
  }
}

// ------------------------------------------------------------------- audio
/* Chiptune synthesis. Everything is generated live -- there are no sound
 * files. Voices are deliberately pitched into the 200 Hz - 4 kHz band where
 * laptop and phone speakers actually reproduce sound; an earlier version
 * swept down to 35 Hz and was inaudible on anything without a woofer.
 *
 * `Chip` takes its AudioContext by injection so the exact same code can be
 * rendered into an OfflineAudioContext and measured in tests.
 */

const NOTE = {
  C2: 65.41,  E2: 82.41,  F2: 87.31,  G2: 98.00,  A2: 110.00, B2: 123.47,
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.00, B5: 987.77,
  C6: 1046.50, E6: 1318.51, G6: 1567.98,
};

class Chip {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.85;
    this.out.connect(destination || ctx.destination);
    this.music = ctx.createGain();
    this.music.gain.value = 0.30;      // sits under the effects
    this.music.connect(this.out);
    this._noiseBuf = null;
    this._timer = null;
    this._step = 0;
    this._next = 0;
  }

  get noiseBuf() {
    if (!this._noiseBuf) {
      const n = Math.floor(this.ctx.sampleRate * 1.0);
      this._noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._noiseBuf;
  }

  /** A square/pulse voice with an optional pitch bend and a snappy envelope. */
  tone(opts) {
    const { f0, f1 = null, t, dur, vol = 0.3, type = 'square',
            attack = 0.004, dest = this.out } = opts;
    const c = this.ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== null && f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Filtered noise -- percussion, explosions, breath texture. */
  noise(opts) {
    const { t, dur, vol = 0.3, f0 = 3000, f1 = null,
            type = 'bandpass', q = 1, dest = this.out } = opts;
    const c = this.ctx;
    const src = c.createBufferSource();
    const filt = c.createBiquadFilter();
    const g = c.createGain();
    src.buffer = this.noiseBuf;
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    if (f1 !== null) filt.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.out === dest ? this.out : dest);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** Stepped arpeggio -- the classic chiptune gesture. */
  arp(notes, t, step, dur, vol, type = 'square') {
    notes.forEach((f, i) => this.tone({ f0: f, t: t + i * step, dur, vol, type }));
  }

  play(name, when = 0) {
    const t = this.ctx.currentTime + when;
    switch (name) {
      case 'stomp':            // impact: mid thud + bright crunch
        this.tone({ f0: 260, f1: 90, t, dur: 0.13, vol: 0.42 });
        this.noise({ t, dur: 0.16, vol: 0.40, f0: 2200, f1: 420, type: 'bandpass', q: 0.7 });
        break;
      case 'eat':              // coin blip
        this.tone({ f0: NOTE.B5, t, dur: 0.06, vol: 0.26 });
        this.tone({ f0: NOTE.E6, t: t + 0.06, dur: 0.15, vol: 0.26 });
        break;
      case 'breath':           // descending laser + hiss
        this.tone({ f0: 1700, f1: 280, t, dur: 0.34, vol: 0.30, type: 'sawtooth' });
        this.tone({ f0: 1200, f1: 240, t, dur: 0.34, vol: 0.16 });
        this.noise({ t, dur: 0.32, vol: 0.22, f0: 4200, f1: 900, type: 'bandpass', q: 0.6 });
        break;
      case 'hit':              // taking damage: harsh descending buzz
        this.tone({ f0: 740, f1: 190, t, dur: 0.20, vol: 0.34, type: 'square' });
        this.noise({ t, dur: 0.14, vol: 0.34, f0: 3000, f1: 700, type: 'bandpass', q: 0.5 });
        break;
      case 'boom':             // helicopter kill
        this.noise({ t, dur: 0.34, vol: 0.42, f0: 4500, f1: 380, type: 'lowpass', q: 0.8 });
        this.tone({ f0: 420, f1: 110, t, dur: 0.28, vol: 0.26 });
        break;
      case 'death':            // descending minor run, then a low sting
        this.arp([NOTE.G5, NOTE.E5, NOTE.C5, NOTE.A4, NOTE.F4, NOTE.D4],
                 t, 0.085, 0.11, 0.30);
        this.tone({ f0: NOTE.C4, f1: NOTE.C2, t: t + 0.52, dur: 0.55, vol: 0.32, type: 'sawtooth' });
        this.noise({ t: t + 0.52, dur: 0.5, vol: 0.16, f0: 1200, f1: 260, type: 'lowpass' });
        break;
      case 'fanfare':          // wave cleared: ascending major arpeggio
        this.arp([NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6], t, 0.09, 0.12, 0.28);
        this.tone({ f0: NOTE.C6, t: t + 0.36, dur: 0.36, vol: 0.30 });
        this.tone({ f0: NOTE.E6, t: t + 0.36, dur: 0.36, vol: 0.18 });
        break;
    }
  }

  // ---- looping background riff (16 steps, driving minor) ----------------
  static BASS = ['A2','A2','A2','C3','A2','A2','G2','G2',
                 'F2','F2','F2','A2','G2','G2','E2','E2'];
  static LEAD = ['A4', null,'C5', null,'E5', null,'C5', null,
                 'F4', null,'A4', null,'G4', null,'B5', null];

  startMusic() {
    if (this._timer) return;
    this._step = 0;
    this._next = this.ctx.currentTime + 0.1;
    const stepDur = 0.125;                       // 120 bpm, eighth notes
    this._timer = setInterval(() => {
      while (this._next < this.ctx.currentTime + 0.2) {
        const i = this._step % 16;
        const bass = NOTE[Chip.BASS[i]];
        if (bass) this.tone({ f0: bass, t: this._next, dur: stepDur * 0.85,
                              vol: 0.30, type: 'triangle', dest: this.music });
        const lead = Chip.LEAD[i] && NOTE[Chip.LEAD[i]];
        if (lead) this.tone({ f0: lead, t: this._next, dur: stepDur * 0.5,
                              vol: 0.13, type: 'square', dest: this.music });
        this._next += stepDur;
        this._step++;
      }
    }, 40);
  }

  stopMusic() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

/** Live wrapper: owns the real AudioContext and the unlock dance. */
class Sfx {
  constructor() {
    this.ctx = null;
    this.chip = null;
    this.enabled = true;
    this.musicOn = true;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.chip = new Chip(this.ctx);
    if (this.musicOn) this.chip.startMusic();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }

  play(name) {
    if (!this.enabled || !this.chip) return;
    this.resume();
    this.chip.play(name);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.chip) return;
    if (on && this.musicOn) this.chip.startMusic();
    else this.chip.stopMusic();
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (!this.chip) return this.musicOn;
    if (this.musicOn && this.enabled) this.chip.startMusic();
    else this.chip.stopMusic();
    return this.musicOn;
  }
}

// ---------------------------------------------------------------- entities
const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];

class Building {
  constructor(x, w, h) {
    this.x = x; this.w = w; this.h = h; this.maxH = h;
    this.lit = new Set();
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        if (Math.random() < 0.55) this.lit.add(r + ',' + c);
  }
  get dead() { return this.h <= 0; }
  spans(col) { return col >= this.x && col < this.x + this.w; }
  hit(floors) { const taken = Math.min(floors, this.h); this.h -= taken; return taken; }
}

class Civilian {
  /* Spawning at the screen edge would send them straight back off it, so they
   * appear mid-street and only leave once they have actually fled that far. */
  constructor(x, groundY) {
    this.x = x; this.y = groundY - 2;
    this.frame = 0; this.dead = false;
    this.drift = choice([-1, 1]);
  }
  update(gzCenter, width, tick) {
    if (Math.abs(this.x - gzCenter) < 26) {
      if (tick % 2 === 0) { this.x += this.x >= gzCenter ? 1 : -1; this.frame++; }
    } else if (tick % 6 === 0) {
      if (Math.random() < 0.15) this.drift = -this.drift;
      this.x += this.drift * 0.5;
      this.frame++;
    }
    if (!(this.x > -4 && this.x < width + 4)) this.dead = true;
  }
  art() { return CIV[this.frame % 2]; }
}

class Helicopter {
  constructor(x, y, d, cooldown) {
    this.x = x; this.y = y; this.d = d;
    this.frame = 0; this.cooldown = cooldown;
    this.baseCooldown = cooldown; this.dead = false;
  }
  update(tick, width) {
    if (tick % 2 === 0) this.x += this.d;
    this.frame++;
    if (!(this.x > -HELI_W - 2 && this.x < width + 2)) this.dead = true;
    this.cooldown--;
  }
  wantsToFire(gzCenter) {
    if (this.cooldown > 0) return false;
    if (Math.abs(this.x + HELI_W / 2 - gzCenter) > 26) return false;
    this.cooldown = this.baseCooldown + randint(-15, 25);
    return true;
  }
  art() { return (this.d > 0 ? HELI_R : HELI_L)[Math.floor(this.frame / 2) % 2]; }
}

class Missile {
  constructor(x, y) { this.x = x; this.y = y; this.dead = false; }
  update(groundY) { this.y += 0.9; if (this.y >= groundY) this.dead = true; }
}

class Boom {
  constructor(x, y) { this.x = x; this.y = y; this.age = 0; }
  update() { this.age++; }
  get dead() { return this.age >= 9; }
  art() { return BOOM[Math.min(Math.floor(this.age / 3), 2)]; }
}

class Beam {
  constructor(x, y, d) { this.x = x; this.y = y; this.d = d; this.life = 14; this.dead = false; }
  update() { this.x += this.d * 4; if (--this.life <= 0) this.dead = true; }
}

// -------------------------------------------------------------------- game
const bar = (value, max, width) => {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '#'.repeat(filled) + '-'.repeat(width - filled);
};

class Game {
  constructor(screen, sfx) {
    this.s = screen;
    this.sfx = sfx;
    this.w = screen.cols;
    this.h = screen.rows;
    this.groundY = this.h - 3;
    this.skyTop = 3;
    this.sound = true;
    this.paused = false;
    this.reset();
  }

  reset() {
    this.wave = 1;
    this.score = 0;
    this.hp = MAX_HP;
    this.energy = MAX_EN;
    this.eaten = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.over = false;
    this.waveBanner = 40;
    this.startWave();
  }

  startWave() {
    this.buildings = [];
    let x = 3;
    const ceiling = Math.max(4, this.groundY - 5);
    while (x < this.w - 12) {
      const bw = randint(6, 11);
      this.buildings.push(new Building(x, bw, randint(4, ceiling)));
      x += bw + randint(2, 5);
    }
    this.gx = 2;
    this.facing = 1;
    this.frame = 0;
    this.walking = false;
    this.stomping = 0;
    this.stompCd = 0;
    this.roaring = 0;
    this.shake = 0;
    this.helis = [];
    this.missiles = [];
    this.civs = [];
    this.booms = [];
    this.beams = [];
    this.heliTimer = 70;
    this.stars = [];
    for (let i = 0; i < Math.floor(this.w / 7); i++) {
      this.stars.push([randint(this.skyTop, Math.max(this.skyTop, this.groundY - 14)),
                       randint(0, this.w - 1)]);
    }
  }

  get gzTop()   { return this.groundY - GZ_H; }
  get mouthY()  { return this.gzTop + 1; }
  get center()  { return this.gx + Math.floor(GZ_W / 2); }
  get feetLo()  { return this.gx + Math.floor(GZ_W / 3); }
  get feetHi()  { return this.gx + Math.floor((2 * GZ_W) / 3); }
  get multiplier() { return Math.min(5, 1 + Math.floor(this.combo / 3)); }

  beep(name) { if (this.sound) this.sfx.play(name); }
  addScore(base) { this.score += base * this.multiplier; }
  bumpCombo() { this.combo++; this.comboTimer = COMBO_WINDOW; }

  // -- actions ------------------------------------------------------------
  walk(d) {
    this.facing = d;
    this.gx = Math.max(0, Math.min(this.w - GZ_W, this.gx + d * 2));
    this.walking = true;
  }

  stomp() {
    if (this.stompCd > 0) return;      // mashing shouldn't beat rhythm
    this.stompCd = STOMP_COOLDOWN;
    this.stomping = 5;
    let hit = false;

    for (const b of this.buildings) {
      if (b.dead) continue;
      let over = false;
      for (let c = this.feetLo; c < this.feetHi; c++) if (b.spans(c)) { over = true; break; }
      if (!over) continue;
      const before = b.h;
      const floors = b.hit(randint(2, 4));
      if (floors) {
        hit = true;
        this.addScore(floors * 10);
        this.shake = 5;
        this.booms.push(new Boom(b.x + Math.floor(b.w / 2), this.groundY - b.h - 1));
        if (b.dead && before > 0) this.addScore(50);
      }
    }

    let ate = false;
    for (const c of this.civs) {
      if (c.dead) continue;
      if (c.x >= this.feetLo - 1 && c.x <= this.feetHi) {
        c.dead = true;
        hit = true;
        ate = true;
        this.eaten++;
        this.hp = Math.min(MAX_HP, this.hp + CIV_HEAL);
        this.addScore(15);
      }
    }

    if (hit) { this.bumpCombo(); this.beep('stomp'); }
    if (ate) this.beep('eat');
  }

  fire() {
    if (this.energy < BREATH_COST || this.beams.length) return;
    this.energy -= BREATH_COST;
    this.roaring = 8;
    const mx = this.gx + (this.facing > 0 ? GZ_W : -1);
    this.beams.push(new Beam(mx, this.mouthY, this.facing));
    this.beep('breath');
  }

  // -- simulation ---------------------------------------------------------
  spawn() {
    if (this.civs.length < 7 && Math.random() < 0.05) {
      for (let i = 0; i < 8; i++) {
        const x = randint(4, Math.max(5, this.w - 5));
        if (Math.abs(x - this.center) > 28) { this.civs.push(new Civilian(x, this.groundY)); break; }
      }
    }
    this.heliTimer--;
    const cap = Math.min(5, 1 + this.wave);
    if (this.heliTimer <= 0 && this.helis.length < cap) {
      const d = choice([1, -1]);
      const x = d > 0 ? -HELI_W : this.w;
      const y = randint(this.skyTop, Math.max(this.skyTop + 1, this.mouthY + 1));
      this.helis.push(new Helicopter(x, y, d, Math.max(25, HELI_BASE_COOLDOWN - this.wave * 8)));
      this.heliTimer = Math.max(40, 140 - this.wave * 15);
    }
  }

  update(tick) {
    this.spawn();
    this.energy = Math.min(MAX_EN, this.energy + EN_REGEN);
    if (this.comboTimer > 0 && --this.comboTimer === 0) this.combo = 0;

    for (const c of this.civs) c.update(this.center, this.w, tick);
    this.civs = this.civs.filter((c) => !c.dead);

    for (const hl of this.helis) {
      hl.update(tick, this.w);
      if (hl.wantsToFire(this.center)) {
        this.missiles.push(new Missile(hl.x + HELI_W / 2, hl.y + 2));
      }
    }
    this.helis = this.helis.filter((h) => !h.dead);

    for (const m of this.missiles) {
      m.update(this.groundY);
      const mx = Math.round(m.x), my = Math.round(m.y);
      if (my >= this.gzTop && my < this.groundY && mx >= this.gx && mx < this.gx + GZ_W) {
        m.dead = true;
        this.hp -= MISSILE_DAMAGE;
        this.shake = 6;
        this.combo = 0;
        this.booms.push(new Boom(mx, my));
        this.beep('hit');
      } else if (m.dead) {
        this.booms.push(new Boom(mx, this.groundY - 1));
      }
    }
    this.missiles = this.missiles.filter((m) => !m.dead);

    for (const beam of this.beams) {
      beam.update();
      const bx = Math.round(beam.x);
      for (const hl of this.helis) {
        if (!hl.dead && bx >= hl.x && bx <= hl.x + HELI_W && Math.abs(hl.y + 1 - beam.y) <= 2) {
          hl.dead = true;
          this.addScore(75);
          this.bumpCombo();
          this.booms.push(new Boom(hl.x + Math.floor(HELI_W / 2), hl.y + 1));
          this.beep('boom');
        }
      }
      for (const b of this.buildings) {
        if (!b.dead && b.spans(bx) && this.groundY - b.h <= beam.y) {
          const before = b.h;
          const floors = b.hit(randint(1, 3));
          if (floors) {
            this.addScore(floors * 10);
            this.bumpCombo();
            this.booms.push(new Boom(bx, this.groundY - b.h - 1));
            if (b.dead && before > 0) this.addScore(50);
          }
          beam.dead = true;
        }
      }
      if (!(bx >= 0 && bx < this.w)) beam.dead = true;
    }
    this.beams = this.beams.filter((b) => !b.dead);

    for (const e of this.booms) e.update();
    this.booms = this.booms.filter((e) => !e.dead);

    if (this.hp <= 0) { this.hp = 0; this.over = true; this.beep('death'); }

    if (!this.over && this.buildings.every((b) => b.dead)) {
      this.wave++;
      this.hp = Math.min(MAX_HP, this.hp + 25);
      this.energy = MAX_EN;
      this.score += 200;
      this.waveBanner = 40;
      this.startWave();
      this.beep('fanfare');
    }
  }

  // -- rendering ----------------------------------------------------------
  draw(tick) {
    const s = this.s;
    s.clear();
    const dy = this.shake && tick % 2 === 0 ? 1 : 0;

    for (const [y, x] of this.stars) s.put(y + dy, x, '.', COLOR.dim);
    s.put(this.skyTop + dy, this.w - 8, '( )', COLOR.star);

    for (const b of this.buildings) {
      if (b.dead) {
        s.put(this.groundY - 1 + dy, b.x, '^v^'.repeat(Math.floor(b.w / 3) + 1).slice(0, b.w), COLOR.rubble);
        continue;
      }
      const top = this.groundY - b.h;
      if (b.h < b.maxH) {
        let jag = '';
        for (let i = 0; i < b.w; i++) jag += choice(['^', 'v', '.']);
        s.put(top - 1 + dy, b.x, jag, COLOR.rubble);
      } else {
        s.put(top - 1 + dy, b.x, '_'.repeat(b.w), COLOR.concrete);
      }
      for (let row = 0; row < b.h; row++) {
        const y = this.groundY - 1 - row + dy;
        for (let c = 0; c < b.w; c++) {
          if (c === 0 || c === b.w - 1) s.put(y, b.x + c, '|', COLOR.concrete);
          else if (row % 2 === 0 && c % 2 === 1) {
            const on = b.lit.has(row + ',' + c);
            s.put(y, b.x + c, on ? 'o' : '.', on ? COLOR.window : COLOR.dimWin);
          }
        }
      }
    }

    for (const c of this.civs) s.blit(c.y + dy, Math.round(c.x), c.art(), COLOR.civ, false);
    for (const hl of this.helis) s.blit(hl.y + dy, Math.round(hl.x), hl.art(), COLOR.hud);
    for (const m of this.missiles) s.put(Math.round(m.y) + dy, Math.round(m.x), '!', COLOR.fire);

    for (const beam of this.beams) {
      const bx = Math.round(beam.x);
      s.put(beam.y + dy, beam.d > 0 ? bx : bx - 5, '======', COLOR.window);
      s.put(beam.y + dy, bx + (beam.d > 0 ? 6 : -6), '*', COLOR.fire);
    }

    let art;
    if (this.roaring) art = this.facing > 0 ? ROAR_R : ROAR_L;
    else if (this.stomping) art = this.facing > 0 ? STOMP_R : STOMP_L;
    else art = (this.facing > 0 ? WALK_R : WALK_L)[this.frame % 2];
    s.blit(this.gzTop + dy, this.gx, art, COLOR.kaiju);

    for (const e of this.booms) s.blit(e.y + dy, e.x - 2, e.art(), COLOR.fire, false);

    s.put(this.groundY + dy, 0, '='.repeat(this.w), COLOR.dim);
    this.drawHud();

    if (this.over) {
      this.banner('*** G A M E   O V E R ***',
                  `wave ${this.wave}   score ${this.score}   press R to restart`);
    } else if (this.waveBanner > 0) {
      this.waveBanner--;
      this.banner(`~~~ WAVE ${this.wave} ~~~`, 'flatten every building');
    } else if (this.paused) {
      this.banner('|| PAUSED ||', 'press P to resume');
    }
    s.flush();
  }

  drawHud() {
    const s = this.s;
    const standing = this.buildings.filter((b) => !b.dead).length;
    const line = ` WAVE ${this.wave}   SCORE ${this.score}   x${this.multiplier}` +
                 `   STANDING ${standing}   EATEN ${this.eaten}`;
    s.put(0, 0, line.padEnd(this.w), COLOR.hud);

    const wide = this.w >= 78;
    const bw = wide ? 20 : 12;
    const hpCol = this.hp <= 30 ? COLOR.fire : COLOR.kaiju;
    s.put(1, 1, 'HP ', COLOR.concrete);
    s.put(1, 4, bar(this.hp, MAX_HP, bw), hpCol);
    s.put(1, 5 + bw, String(Math.round(this.hp)).padStart(3), hpCol);

    const ax = 11 + bw;
    s.put(1, ax, 'ATOMIC ', COLOR.concrete);
    s.put(1, ax + 7, bar(this.energy, MAX_EN, bw),
          this.energy >= BREATH_COST ? COLOR.window : COLOR.dim);
    if (this.combo >= 3) s.put(1, ax + 9 + bw, ` COMBO ${this.combo} `, COLOR.fire);
  }

  banner(l1, l2) {
    const y = Math.floor(this.groundY / 2);
    [l1, l2].forEach((text, i) => {
      const x = Math.max(0, Math.floor((this.w - text.length) / 2));
      this.s.put(y + i, x, ' ' + text + ' ', i === 0 ? COLOR.fire : COLOR.concrete);
    });
  }

  tick(n) {
    if (this.over || this.paused) return;
    if (this.walking && n % 2 === 0) this.frame++;
    if (this.stomping) this.stomping--;
    if (this.stompCd) this.stompCd--;
    if (this.roaring) this.roaring--;
    if (this.shake) this.shake--;
    this.update(n);
  }
}

// ------------------------------------------------------------------- boot
(function () {
  const canvas = document.getElementById('screen');
  const overlay = document.getElementById('overlay');
  const touch = document.getElementById('touch');
  const startBtn = document.getElementById('start');

  // Pick a logical grid that suits the viewport, once, at load. Recomputing
  // mid-game would relayout the city under the player's feet.
  const ROWS = 30;
  const aspect = window.innerWidth / window.innerHeight;
  const COLS = Math.max(60, Math.min(130, Math.round((ROWS * aspect) / 0.6)));

  const screen = new Screen(canvas, COLS, ROWS);
  const sfx = new Sfx();
  let game = new Game(screen, sfx);
  let running = false;
  let tickCount = 0;
  let acc = 0;
  let last = performance.now();

  const held = { left: false, right: false };

  function begin() {
    sfx.init();
    sfx.resume();
    overlay.classList.add('hidden');
    if (matchMedia('(pointer: coarse)').matches) touch.classList.remove('hidden');
    running = true;
    last = performance.now();
  }

  startBtn.addEventListener('click', begin);

  // Browsers only allow audio to start from a user gesture, and a context can
  // be re-suspended by the OS (tab switch, screen lock). Nudge it on anything.
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    addEventListener(ev, () => { sfx.init(); sfx.resume(); }, { passive: true }));

  window.addEventListener('resize', () => { screen.layout(); game.draw(tickCount); });

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ([' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) e.preventDefault();
    if (!running) { if (k === ' ' || k === 'enter') begin(); return; }
    if (k === 'arrowleft' || k === 'a') held.left = true;
    else if (k === 'arrowright' || k === 'd') held.right = true;
    else if (k === ' ') game.stomp();
    else if (k === 'f') game.fire();
    else if (k === 'p') game.paused = !game.paused;
    else if (k === 'b') { game.sound = !game.sound; sfx.setEnabled(game.sound); }
    else if (k === 'm') sfx.toggleMusic();
    else if (k === 'r' && game.over) game.reset();
  });

  addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') held.left = false;
    else if (k === 'arrowright' || k === 'd') held.right = false;
  });

  touch.querySelectorAll('button').forEach((btn) => {
    const key = btn.dataset.key;
    const down = (e) => {
      e.preventDefault();
      if (key === 'left') held.left = true;
      else if (key === 'right') held.right = true;
      else if (key === 'stomp') game.over ? game.reset() : game.stomp();
      else if (key === 'fire') game.fire();
    };
    const up = (e) => {
      e.preventDefault();
      if (key === 'left') held.left = false;
      if (key === 'right') held.right = false;
    };
    btn.addEventListener('touchstart', down, { passive: false });
    btn.addEventListener('touchend', up, { passive: false });
    btn.addEventListener('mousedown', down);
    btn.addEventListener('mouseup', up);
    btn.addEventListener('mouseleave', up);
  });

  function loop(now) {
    requestAnimationFrame(loop);
    acc += now - last;
    last = now;
    if (acc > TICK_MS * 5) acc = TICK_MS;      // don't spiral after a tab switch
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      if (running) {
        game.walking = false;
        if (held.left) game.walk(-1);
        if (held.right) game.walk(1);
        game.tick(tickCount);
        tickCount++;
      }
      game.draw(tickCount);
    }
  }
  game.draw(0);
  overlay.classList.remove('hidden');
  requestAnimationFrame(loop);
})();

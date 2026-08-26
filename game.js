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
/* The terminal original synthesised WAVs because Ubuntu blacklists the PC
 * speaker. Here the same recipes are rebuilt live with Web Audio nodes. */
class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.noiseBuf = null;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    const n = this.ctx.sampleRate * 1.2;
    this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _sweep(f0, f1, dur, vol, type = 'sawtooth') {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  _noise(dur, vol, cutoff = 1800) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    src.buffer = this.noiseBuf;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  _note(freq, dur, when, vol = 0.25) {
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  play(name) {
    if (!this.enabled || !this.ctx) return;
    this.resume();
    switch (name) {
      case 'stomp':
        this._sweep(150, 35, 0.22, 0.55);
        this._noise(0.16, 0.28, 700);
        break;
      case 'breath':
        this._sweep(1100, 220, 0.40, 0.30, 'sawtooth');
        this._noise(0.38, 0.30, 3200);
        break;
      case 'hit':
        this._noise(0.18, 0.45, 5000);
        this._sweep(400, 90, 0.16, 0.35, 'square');
        break;
      case 'boom':
        this._noise(0.12, 0.40, 2600);
        this._sweep(300, 60, 0.26, 0.35);
        break;
      case 'death':
        this._sweep(320, 45, 1.1, 0.45);
        this._noise(0.9, 0.18, 900);
        break;
      case 'fanfare':
        this._note(392, 0.14, 0.00);
        this._note(523, 0.14, 0.13);
        this._note(659, 0.32, 0.26);
        this._note(784, 0.32, 0.26, 0.18);
        break;
    }
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

    for (const c of this.civs) {
      if (c.dead) continue;
      if (c.x >= this.feetLo - 1 && c.x <= this.feetHi) {
        c.dead = true;
        hit = true;
        this.eaten++;
        this.hp = Math.min(MAX_HP, this.hp + CIV_HEAL);
        this.addScore(15);
      }
    }

    if (hit) { this.bumpCombo(); this.beep('stomp'); }
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
    else if (k === 'b') { game.sound = !game.sound; sfx.enabled = game.sound; }
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

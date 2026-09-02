"use strict";
/* ============================================================
   STIKKAOS — server-side authoritative simulation.
   Pure JS, no DOM/canvas/audio. The client only renders what
   this module computes; the browser never decides the outcome
   of a hit, so all connected players see the same result.
   ============================================================ */

const WORLD = { width: 1280, height: 720 };
const HALF_W = 15, FOOT_OFFSET = 34, HEAD_TOP_OFFSET = -56;
const GRAVITY = 1650, MAX_FALL = 1500;
const GROUND_ACCEL = 3400, AIR_ACCEL = 1900, MAX_SPEED = 360;
const JUMP_VEL = -820, WALL_JUMP_VX = 440, WALL_JUMP_VY = -760, WALL_SLIDE_CAP = 240;
const ROUNDS_TO_WIN = 3;
const TICK_DT = 1 / 30;

const COLORS = ['#4cc9f0', '#f72585', '#52d97a', '#ff8c42'];
const NAMES_FALLBACK = ['P1', 'P2', 'P3', 'P4'];

const WEAPONS = {
  fists:   { name: 'Næver', type: 'melee', dmg: 6, cooldown: 0.42, range: 50, knockback: 230 },
  bat:     { name: 'Bat', type: 'melee', dmg: 15, cooldown: 0.5, range: 60, knockback: 430 },
  pistol:  { name: 'Pistol', type: 'ranged', dmg: 9, cooldown: 0.26, ammo: 12, speed: 920, gravity: 0.12, spread: 0.03 },
  smg:     { name: 'Maskinpistol', type: 'ranged', dmg: 4.2, cooldown: 0.085, ammo: 32, speed: 970, gravity: 0.08, spread: 0.10 },
  shotgun: { name: 'Haglgevær', type: 'ranged', dmg: 6, cooldown: 0.62, ammo: 6, speed: 800, gravity: 0.18, spread: 0.24, pellets: 6 },
  sniper:  { name: 'Riffel', type: 'ranged', dmg: 30, cooldown: 0.85, ammo: 5, speed: 1500, gravity: 0.04, spread: 0.004 },
  rocket:  { name: 'Raketkaster', type: 'ranged', dmg: 2, splashDmg: 36, splashRadius: 150, cooldown: 1.05, ammo: 3, speed: 640, gravity: 0.3, spread: 0.015, explosive: true }
};
const PICKUP_POOL = ['bat', 'pistol', 'smg', 'shotgun', 'sniper', 'rocket'];

function mkPlatform(x, y, w, h, opts) {
  const p = { x, y, w, h, baseX: x, baseY: y };
  if (opts) Object.assign(p, opts);
  return p;
}
function ARENAS_DEF() { return [
  {
    id: 'dock', name: 'Havneterminal',
    platforms: [
      mkPlatform(0, 650, 520, 70),
      mkPlatform(760, 650, 520, 70),
      mkPlatform(530, 430, 220, 24),
      mkPlatform(50, 480, 150, 24),
      mkPlatform(1080, 480, 150, 24),
      mkPlatform(560, 240, 160, 24),
      mkPlatform(500, 430, 24, 220, { wall: true }),
      mkPlatform(756, 430, 24, 220, { wall: true })
    ],
    spawnPoints: [{ x: 150, y: 600 }, { x: 1130, y: 600 }, { x: 600, y: 380 }, { x: 680, y: 380 }]
  },
  {
    id: 'towers', name: 'Tårnene',
    platforms: [
      mkPlatform(440, 650, 400, 70),
      mkPlatform(140, 520, 220, 22),
      mkPlatform(920, 520, 220, 22),
      mkPlatform(40, 360, 200, 22),
      mkPlatform(1040, 360, 200, 22),
      mkPlatform(430, 250, 200, 22, { moving: { axis: 'x', range: 230, speed: 1.1, phase: 0 } }),
      mkPlatform(520, 110, 240, 22),
      mkPlatform(340, 130, 20, 230, { wall: true }),
      mkPlatform(920, 130, 20, 230, { wall: true })
    ],
    spawnPoints: [{ x: 200, y: 470 }, { x: 980, y: 470 }, { x: 90, y: 310 }, { x: 1090, y: 310 }]
  },
  {
    id: 'bridge', name: 'Broen',
    platforms: [
      mkPlatform(30, 620, 260, 40),
      mkPlatform(380, 620, 260, 40),
      mkPlatform(720, 620, 260, 40),
      mkPlatform(1060, 620, 190, 40),
      mkPlatform(150, 440, 190, 22),
      mkPlatform(930, 440, 190, 22),
      mkPlatform(440, 320, 200, 22, { moving: { axis: 'x', range: 180, speed: 0.9, phase: 1.6 } }),
      mkPlatform(640, 655, 80, 20, { bouncePad: true, bounceForce: 1350 }),
      mkPlatform(605, 500, 20, 155, { wall: true }),
      mkPlatform(755, 500, 20, 155, { wall: true })
    ],
    spawnPoints: [{ x: 150, y: 560 }, { x: 1100, y: 560 }, { x: 220, y: 380 }, { x: 1000, y: 380 }]
  }
];}

function randomArena() { const l = ARENAS_DEF(); return l[Math.floor(Math.random() * l.length)]; }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function rectsOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function getBox(e) { return { x: e.x - HALF_W, y: e.y + HEAD_TOP_OFFSET, w: HALF_W * 2, h: FOOT_OFFSET - HEAD_TOP_OFFSET }; }

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player state
    this.order = [];          // join order of ids
    this.state = 'LOBBY';     // LOBBY | COUNTDOWN | FIGHT | ROUNDEND | SCOREBOARD | MATCHEND
    this.arena = null;
    this.stateTimer = 0;
    this.elapsed = 0;
    this.projectiles = [];
    this.pickups = [];
    this.fallingCrates = [];
    this.dropTimer = 0;
    this.events = [];
    this.roundMessage = '';
    this.hazardAccum = new Map();
  }

  addPlayer(id, name) {
    if (this.order.length >= 4) return null;
    const idx = this.order.length;
    const p = {
      id, idx, name: (name || NAMES_FALLBACK[idx]).slice(0, 14), color: COLORS[idx],
      ready: false, connected: true,
      x: 100, y: 100, vx: 0, vy: 0, facing: 1, grounded: false, standingPlatform: null, touchWallDir: 0,
      damage: 0, alive: true, weapon: 'fists', ammo: 0, attackCooldown: 0, ragdollTimer: 0,
      invuln: 0, walkPhase: 0, roundWins: 0, aimUp: false, aimDown: false,
      input: { left: false, right: false, jump: false, down: false, attack: false },
      prevInput: { jump: false, attack: false }
    };
    this.players.set(id, p);
    this.order.push(id);
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (p) p.connected = false, p.alive = false;
  }
  aliveCount() { return this.order.filter(id => { const p = this.players.get(id); return p && p.connected && p.alive; }).length; }
  connectedCount() { return this.order.filter(id => this.players.get(id) && this.players.get(id).connected).length; }

  startMatch() {
    this.order.forEach(id => { const p = this.players.get(id); if (p) p.roundWins = 0; });
    this.arena = JSON.parse(JSON.stringify(randomArena()));
    this.arena.platforms.forEach(pl => { pl.baseX = pl.x; pl.baseY = pl.y; });
    this.elapsed = 0;
    this.resetRound();
    this.state = 'COUNTDOWN';
    this.stateTimer = 3.0;
  }

  resetRound() {
    const sp = this.arena.spawnPoints;
    this.order.forEach((id, i) => {
      const p = this.players.get(id);
      if (!p) return;
      const spawn = sp[i % sp.length];
      p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0; p.grounded = false; p.standingPlatform = null;
      p.touchWallDir = 0; p.damage = 0; p.alive = p.connected; p.weapon = 'fists'; p.ammo = 0;
      p.attackCooldown = 0; p.ragdollTimer = 0; p.invuln = 1.2;
      p.facing = spawn.x < WORLD.width / 2 ? 1 : -1;
    });
    this.projectiles = []; this.fallingCrates = []; this.pickups = [];
    this.dropTimer = 1.2 + Math.random() * 1.8;
    this.arena.platforms.forEach(pl => { pl.x = pl.baseX; pl.y = pl.baseY; });
    this.hazardAccum.clear();
  }

  applyHazardTick(player, plat) {
    const acc = (this.hazardAccum.get(player.id) || 0) + TICK_DT;
    this.hazardAccum.set(player.id, acc);
    if (acc >= 0.35) {
      this.hazardAccum.set(player.id, 0);
      this.dealDamage(player, plat.dps * 0.35, { x: player.x, y: player.y + 40 }, null, 60);
    }
  }

  launch(player, dirx, diry, power) {
    const mag = Math.hypot(dirx, diry) || 1;
    player.vx += (dirx / mag) * power;
    player.vy += (diry / mag) * power - power * 0.18;
    player.ragdollTimer = Math.min(1.5, 0.4 + power * 0.0018);
    this.events.push({ t: 'hit', id: player.id, dirx, diry, power });
  }

  dealDamage(target, amount, sourcePos, sourceVel, baseKnock) {
    if (!target.alive || target.invuln > 0) return;
    target.damage += amount;
    let ndx = target.x - sourcePos.x, ndy = (target.y - 40) - sourcePos.y - 40;
    if (sourceVel && (Math.abs(sourceVel.x) > 1 || Math.abs(sourceVel.y) > 1)) { ndx = sourceVel.x; ndy = sourceVel.y - 120; }
    const power = (baseKnock || 220) + target.damage * (baseKnock || 220) * 0.028;
    this.launch(target, ndx || (Math.random() < 0.5 ? -1 : 1), ndy || -200, power);
    this.checkElimination(target);
  }

  explode(x, y, radius, dmg) {
    this.events.push({ t: 'explosion', x, y, radius });
    this.order.forEach(id => {
      const p = this.players.get(id);
      if (!p || !p.alive) return;
      const d = dist(x, y, p.x, p.y - 25);
      if (d < radius && p.invuln <= 0) {
        const falloff = 1 - d / radius;
        p.damage += dmg * falloff + 4;
        const dirx = (p.x - x) || (Math.random() < 0.5 ? -1 : 1), diry = (p.y - 25 - y) - 60;
        this.launch(p, dirx, diry, 300 * falloff + 260);
        this.checkElimination(p);
      }
    });
  }

  checkElimination(p) {
    if (p.y > WORLD.height + 220 || p.x < -180 || p.x > WORLD.width + 180) {
      if (p.alive) {
        p.alive = false;
        this.events.push({ t: 'ko', id: p.id, x: Math.max(-60, Math.min(WORLD.width + 60, p.x)), y: Math.min(WORLD.height - 40, p.y) });
      }
    }
  }

  meleeAttack(p) {
    const w = WEAPONS[p.weapon];
    this.events.push({ t: 'melee', id: p.id, weapon: p.weapon });
    this.order.forEach(id => {
      if (id === p.id) return;
      const target = this.players.get(id);
      if (!target || !target.alive) return;
      const forward = (target.x - p.x) * p.facing;
      if (forward > -10 && forward < w.range && Math.abs((target.y - 30) - (p.y - 30)) < 70) {
        this.dealDamage(target, w.dmg, { x: p.x - p.facing * 40, y: p.y - 30 }, { x: p.facing * 380, y: -160 }, w.knockback);
      }
    });
  }

  shootWeapon(p) {
    const w = WEAPONS[p.weapon];
    const originX = p.x + p.facing * 22, originY = p.y - 42;
    let baseAngle = 0;
    if (p.aimUp) baseAngle = -0.62; else if (p.aimDown && !p.grounded) baseAngle = 0.62;
    const pellets = w.pellets || 1;
    this.events.push({ t: 'shot', id: p.id, weapon: p.weapon, x: originX, y: originY });
    for (let i = 0; i < pellets; i++) {
      const spread = (Math.random() * 2 - 1) * w.spread + (pellets > 1 ? (i - (pellets - 1) / 2) * 0.055 : 0);
      const angle = baseAngle + spread;
      const dirx = Math.cos(angle) * p.facing, diry = Math.sin(angle);
      this.projectiles.push({
        id: Math.random().toString(36).slice(2, 9),
        x: originX, y: originY, vx: dirx * w.speed, vy: diry * w.speed,
        gravity: w.gravity * 1400, owner: p.id, weapon: p.weapon, life: 2.2,
        dmg: w.dmg, explosive: !!w.explosive, splashDmg: w.splashDmg, splashRadius: w.splashRadius
      });
    }
    p.ammo--;
    if (p.ammo <= 0) { p.weapon = 'fists'; p.ammo = 0; }
  }

  tryAttack(p) {
    if (p.attackCooldown > 0 || !p.input.attack) return;
    const w = WEAPONS[p.weapon];
    p.attackCooldown = w.cooldown;
    if (w.type === 'melee') this.meleeAttack(p); else this.shootWeapon(p);
  }

  updateMovingPlatforms(dt) {
    for (const pl of this.arena.platforms) {
      if (!pl.moving) continue;
      const old = pl.x;
      if (pl.moving.axis === 'x') {
        pl.x = pl.baseX + Math.sin(this.elapsed * pl.moving.speed + pl.moving.phase) * pl.moving.range;
        pl.deltaX = pl.x - old; pl.deltaY = 0;
      } else {
        const oldY = pl.y;
        pl.y = pl.baseY + Math.sin(this.elapsed * pl.moving.speed + pl.moving.phase) * pl.moving.range;
        pl.deltaY = pl.y - oldY; pl.deltaX = 0;
      }
    }
  }

  moveAndCollide(e, dt) {
    if (e.grounded && e.standingPlatform && e.standingPlatform.moving) {
      e.x += e.standingPlatform.deltaX || 0;
      e.y += e.standingPlatform.deltaY || 0;
    }
    e.touchWallDir = 0;
    e.x += e.vx * dt;
    let box = getBox(e);
    for (const pl of this.arena.platforms) {
      if (rectsOverlap(box, pl)) {
        if (e.vx > 0) { e.x = pl.x - HALF_W - 0.01; e.touchWallDir = 1; }
        else if (e.vx < 0) { e.x = pl.x + pl.w + HALF_W + 0.01; e.touchWallDir = -1; }
        e.vx = 0;
        box = getBox(e);
      }
    }
    e.grounded = false; e.standingPlatform = null;
    e.y += e.vy * dt;
    box = getBox(e);
    for (const pl of this.arena.platforms) {
      if (rectsOverlap(box, pl)) {
        if (e.vy >= 0) {
          if (pl.bouncePad) {
            e.y = pl.y - FOOT_OFFSET - 0.01;
            e.vy = -pl.bounceForce;
            e.grounded = false; e.standingPlatform = null;
            this.events.push({ t: 'bounce', id: e.id, x: e.x, y: pl.y });
          } else {
            e.y = pl.y - FOOT_OFFSET - 0.01; e.vy = 0; e.grounded = true; e.standingPlatform = pl;
            if (pl.hazard) this.applyHazardTick(e, pl);
          }
        } else {
          e.y = pl.y + pl.h - HEAD_TOP_OFFSET + 0.01; e.vy = 0;
        }
        box = getBox(e);
      }
    }
    if (!e.grounded && e.touchWallDir !== 0 && e.vy > 0) e.vy = Math.min(e.vy, WALL_SLIDE_CAP);
  }

  spawnFallingCrate() {
    this.fallingCrates.push({
      x: 70 + Math.random() * (WORLD.width - 140), y: -40, vy: 60 + Math.random() * 60,
      type: PICKUP_POOL[Math.floor(Math.random() * PICKUP_POOL.length)]
    });
  }
  updateFallingCrates(dt) {
    for (let i = this.fallingCrates.length - 1; i >= 0; i--) {
      const c = this.fallingCrates[i];
      c.vy += 1500 * dt; c.vy = Math.min(c.vy, 1100);
      c.y += c.vy * dt;
      let landed = false;
      for (const pl of this.arena.platforms) {
        if (c.x > pl.x && c.x < pl.x + pl.w && c.y >= pl.y - 6 && c.y <= pl.y + pl.h && c.vy >= 0) {
          this.pickups.push({ x: c.x, y: pl.y - 10, type: c.type });
          this.events.push({ t: 'crateland', x: c.x, y: pl.y });
          landed = true; break;
        }
      }
      if (landed || c.y > WORLD.height + 150) this.fallingCrates.splice(i, 1);
    }
  }

  tick(dt) {
    this.events = [];
    if (this.state === 'COUNTDOWN') {
      const prevCeil = Math.ceil(this.stateTimer);
      this.stateTimer -= dt;
      if (Math.ceil(this.stateTimer) !== prevCeil) this.events.push({ t: 'tick3' });
      if (this.stateTimer <= 0) { this.state = 'FIGHT'; this.events.push({ t: 'go' }); }
      return;
    }
    if (this.state === 'ROUNDEND') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        const champ = this.order.map(id => this.players.get(id)).find(p => p && p.roundWins >= ROUNDS_TO_WIN);
        if (champ) { this.state = 'MATCHEND'; this.champion = champ.id; this.events.push({ t: 'win' }); }
        else this.state = 'SCOREBOARD';
      }
      return;
    }
    if (this.state !== 'FIGHT') return;

    this.elapsed += dt;
    this.updateMovingPlatforms(dt);

    this.order.forEach(id => {
      const p = this.players.get(id);
      if (!p) return;
      if (p.attackCooldown > 0) p.attackCooldown -= dt;
      if (p.invuln > 0) p.invuln -= dt;
      if (!p.alive) return;

      const input = p.input, prev = p.prevInput;
      const accel = p.grounded ? GROUND_ACCEL : AIR_ACCEL;
      if (input.left && !input.right) { p.vx -= accel * dt; p.facing = -1; }
      else if (input.right && !input.left) { p.vx += accel * dt; p.facing = 1; }
      else if (p.grounded) { p.vx *= 0.78; if (Math.abs(p.vx) < 8) p.vx = 0; }
      p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx));

      if (input.jump && !prev.jump && p.ragdollTimer <= 0) {
        if (p.grounded) { p.vy = JUMP_VEL; p.grounded = false; this.events.push({ t: 'jump', id: p.id }); }
        else if (p.touchWallDir !== 0) {
          p.vx = -p.touchWallDir * WALL_JUMP_VX; p.vy = WALL_JUMP_VY; p.facing = -p.touchWallDir; p.touchWallDir = 0;
          this.events.push({ t: 'jump', id: p.id });
        }
      }
      p.aimDown = !!(input.down && !p.grounded);
      p.aimUp = !!(input.jump && !input.down);

      p.vy += GRAVITY * dt; p.vy = Math.min(p.vy, MAX_FALL);
      this.moveAndCollide(p, dt);
      if (p.ragdollTimer > 0) p.ragdollTimer -= dt;
      p.walkPhase += dt * (p.grounded ? Math.abs(p.vx) * 0.02 : 0);

      this.tryAttack(p);

      if (p.weapon === 'fists') {
        for (let i = this.pickups.length - 1; i >= 0; i--) {
          const pu = this.pickups[i];
          if (Math.abs(pu.x - p.x) < 34 && Math.abs(pu.y - p.y) < 50) {
            p.weapon = pu.type; p.ammo = WEAPONS[pu.type].ammo || 0;
            this.events.push({ t: 'pickup', id: p.id });
            this.pickups.splice(i, 1);
            break;
          }
        }
      }
      this.checkElimination(p);
      p.prevInput = { jump: input.jump, attack: input.attack };
    });

    this.dropTimer -= dt;
    if (this.dropTimer <= 0) {
      if (this.pickups.length + this.fallingCrates.length < 5) this.spawnFallingCrate();
      this.dropTimer = 3.5 + Math.random() * 4.5;
    }
    this.updateFallingCrates(dt);

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      pr.vy += pr.gravity * dt;
      pr.x += pr.vx * dt; pr.y += pr.vy * dt;
      let removed = false;
      for (const pl of this.arena.platforms) {
        if (pr.x > pl.x && pr.x < pl.x + pl.w && pr.y > pl.y && pr.y < pl.y + pl.h) {
          if (pr.explosive) this.explode(pr.x, pr.y, pr.splashRadius, pr.splashDmg);
          else this.events.push({ t: 'impact', x: pr.x, y: pr.y, weapon: pr.weapon });
          removed = true; break;
        }
      }
      if (!removed) {
        for (const id of this.order) {
          const target = this.players.get(id);
          if (!target || !target.alive || id === pr.owner) continue;
          if (dist(pr.x, pr.y, target.x, target.y - 30) < 26) {
            if (pr.explosive) this.explode(pr.x, pr.y, pr.splashRadius, pr.splashDmg);
            else this.dealDamage(target, pr.dmg, { x: pr.x - pr.vx * 0.02, y: pr.y - pr.vy * 0.02 }, { x: pr.vx * 0.5, y: pr.vy * 0.5 - 140 }, 240);
            removed = true; break;
          }
        }
      }
      if (pr.life <= 0 || pr.x < -100 || pr.x > WORLD.width + 100 || pr.y > WORLD.height + 300) removed = true;
      if (removed) this.projectiles.splice(i, 1);
    }

    const alivePlayers = this.order.map(id => this.players.get(id)).filter(p => p && p.connected && p.alive);
    if (alivePlayers.length <= 1 && this.order.length > 1) {
      this.state = 'ROUNDEND'; this.stateTimer = 2.2;
      if (alivePlayers.length === 1) {
        alivePlayers[0].roundWins++;
        this.roundMessage = alivePlayers[0].name + ' vinder runden!';
        this.winnerId = alivePlayers[0].id;
      } else { this.roundMessage = 'Uafgjort!'; this.winnerId = null; }
      this.events.push({ t: 'roundend', winnerId: this.winnerId, message: this.roundMessage });
    }
  }

  snapshot() {
    return {
      state: this.state, stateTimer: this.stateTimer, arenaId: this.arena ? this.arena.id : null,
      arenaName: this.arena ? this.arena.name : null, elapsed: this.elapsed,
      roundMessage: this.roundMessage, champion: this.champion || null,
      players: this.order.map(id => {
        const p = this.players.get(id); if (!p) return null;
        return {
          id: p.id, idx: p.idx, name: p.name, color: p.color, connected: p.connected,
          x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing, grounded: p.grounded,
          damage: Math.round(p.damage), alive: p.alive, weapon: p.weapon, ammo: p.ammo,
          ragdollTimer: p.ragdollTimer, walkPhase: p.walkPhase, roundWins: p.roundWins,
          aimUp: p.aimUp, aimDown: p.aimDown, invuln: p.invuln
        };
      }).filter(Boolean),
      projectiles: this.projectiles.map(pr => ({ x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, weapon: pr.weapon, explosive: pr.explosive })),
      pickups: this.pickups.map(pu => ({ x: pu.x, y: pu.y, type: pu.type })),
      fallingCrates: this.fallingCrates.map(c => ({ x: c.x, y: c.y, type: c.type }))
    };
  }
}

module.exports = { Room, WORLD, ARENAS_DEF, WEAPONS, PICKUP_POOL, TICK_DT, ROUNDS_TO_WIN };

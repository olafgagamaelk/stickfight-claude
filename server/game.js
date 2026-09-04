"use strict";
/* ============================================================
   STIKKAOS — server-side simulation.
   Movement is now fully client-owned: each client simulates its
   own walking/jumping/wall-jumping/bounce-pads locally and just
   reports its position here. The server never overrides that —
   it only takes control during combat (weapons, projectiles,
   explosions, damage/knockback) and round/match flow, which stay
   fully authoritative so nobody can fake being hit or fake a kill.
   ============================================================ */

const WORLD = { width: 1280, height: 720 };
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
const MELEE_CONE = 0.95; // radians either side of aim angle

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
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function angleDiff(a, b) { let d = Math.abs(a - b) % (Math.PI * 2); if (d > Math.PI) d = Math.PI * 2 - d; return d; }

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
  }

  addPlayer(id, name) {
    if (this.order.length >= 4) return null;
    const idx = this.order.length;
    const p = {
      id, idx, name: (name || NAMES_FALLBACK[idx]).slice(0, 14), color: COLORS[idx],
      ready: false, connected: true,
      x: 100, y: 100, vx: 0, vy: 0, facing: 1, grounded: false, aimAngle: 0,
      damage: 0, alive: true, weapon: 'fists', ammo: 0, attackCooldown: 0, ragdollTimer: 0,
      invuln: 0, walkPhase: 0, roundWins: 0, attackHeld: false
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
      p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0; p.grounded = false;
      p.damage = 0; p.alive = p.connected; p.weapon = 'fists'; p.ammo = 0;
      p.attackCooldown = 0; p.ragdollTimer = 0; p.invuln = 1.2; p.attackHeld = false;
      p.facing = spawn.x < WORLD.width / 2 ? 1 : -1;
      p.aimAngle = p.facing > 0 ? 0 : Math.PI;
    });
    this.projectiles = []; this.fallingCrates = []; this.pickups = [];
    this.dropTimer = 1.2 + Math.random() * 1.8;
    this.arena.platforms.forEach(pl => { pl.x = pl.baseX; pl.y = pl.baseY; });
  }

  /** Called whenever a client reports its own movement/pose. Trusted, lightly sanity-clamped. */
  reportMove(playerId, data) {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return;
    p.x = clamp(Number(data.x) || 0, -400, WORLD.width + 400);
    p.y = clamp(Number(data.y) || 0, -1200, WORLD.height + 1200);
    p.vx = clamp(Number(data.vx) || 0, -2200, 2200);
    p.vy = clamp(Number(data.vy) || 0, -2600, 2600);
    p.facing = data.facing === -1 ? -1 : 1;
    p.grounded = !!data.grounded;
    if (typeof data.aimAngle === 'number' && isFinite(data.aimAngle)) p.aimAngle = data.aimAngle;
    if (typeof data.walkPhase === 'number' && isFinite(data.walkPhase)) p.walkPhase = data.walkPhase;
    p.attackHeld = !!data.attack;
  }

  launch(player, dirx, diry, power) {
    const mag = Math.hypot(dirx, diry) || 1;
    player.ragdollTimer = Math.min(1.5, 0.4 + power * 0.0018);
    this.events.push({ t: 'hit', id: player.id, dirx: dirx / mag, diry: diry / mag, power });
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
    const originX = p.x, originY = p.y - 26;
    this.order.forEach(id => {
      if (id === p.id) return;
      const target = this.players.get(id);
      if (!target || !target.alive) return;
      const dx = target.x - originX, dy = (target.y - 26) - originY;
      const d = Math.hypot(dx, dy);
      if (d > w.range + 22) return;
      if (angleDiff(Math.atan2(dy, dx), p.aimAngle) > MELEE_CONE) return;
      this.dealDamage(target, w.dmg, { x: originX, y: originY },
        { x: Math.cos(p.aimAngle) * 380, y: Math.sin(p.aimAngle) * 380 - 100 }, w.knockback);
    });
  }

  shootWeapon(p) {
    const w = WEAPONS[p.weapon];
    const originX = p.x + Math.cos(p.aimAngle) * 28, originY = (p.y - 26) + Math.sin(p.aimAngle) * 28;
    const pellets = w.pellets || 1;
    this.events.push({ t: 'shot', id: p.id, weapon: p.weapon, x: originX, y: originY });
    for (let i = 0; i < pellets; i++) {
      const spread = (Math.random() * 2 - 1) * w.spread + (pellets > 1 ? (i - (pellets - 1) / 2) * 0.055 : 0);
      const angle = p.aimAngle + spread;
      const dirx = Math.cos(angle), diry = Math.sin(angle);
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
    if (p.attackCooldown > 0) return;
    const w = WEAPONS[p.weapon];
    p.attackCooldown = w.cooldown;
    if (w.type === 'melee') this.meleeAttack(p); else this.shootWeapon(p);
  }

  updateMovingPlatforms(dt) {
    for (const pl of this.arena.platforms) {
      if (!pl.moving) continue;
      if (pl.moving.axis === 'x') pl.x = pl.baseX + Math.sin(this.elapsed * pl.moving.speed + pl.moving.phase) * pl.moving.range;
      else pl.y = pl.baseY + Math.sin(this.elapsed * pl.moving.speed + pl.moving.phase) * pl.moving.range;
    }
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
    this.updateMovingPlatforms(dt); // kept accurate server-side so projectiles still hit moving platforms correctly

    this.order.forEach(id => {
      const p = this.players.get(id);
      if (!p) return;
      if (p.attackCooldown > 0) p.attackCooldown -= dt;
      if (p.invuln > 0) p.invuln -= dt;
      if (p.ragdollTimer > 0) p.ragdollTimer -= dt;
      if (!p.alive) return;

      if (p.attackHeld) this.tryAttack(p);

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
          x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing, grounded: p.grounded, aimAngle: p.aimAngle,
          damage: Math.round(p.damage), alive: p.alive, weapon: p.weapon, ammo: p.ammo,
          ragdollTimer: p.ragdollTimer, walkPhase: p.walkPhase, roundWins: p.roundWins, invuln: p.invuln
        };
      }).filter(Boolean),
      projectiles: this.projectiles.map(pr => ({ x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, weapon: pr.weapon, explosive: pr.explosive })),
      pickups: this.pickups.map(pu => ({ x: pu.x, y: pu.y, type: pu.type })),
      fallingCrates: this.fallingCrates.map(c => ({ x: c.x, y: c.y, type: c.type }))
    };
  }
}

module.exports = { Room, WORLD, ARENAS_DEF, WEAPONS, PICKUP_POOL, TICK_DT, ROUNDS_TO_WIN };

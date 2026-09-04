(function(){
"use strict";

/* ============================================================
   SETUP
   ============================================================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const WORLD = {width:1280, height:720};
const TICK_MS = 1000/30;

function fitStage(){
  const stage = document.getElementById('stage');
  const maxW = window.innerWidth*0.96, maxH = window.innerHeight*0.92;
  const scale = Math.min(maxW/WORLD.width, maxH/WORLD.height);
  stage.style.width = (WORLD.width*scale)+'px';
  stage.style.height = (WORLD.height*scale)+'px';
}
window.addEventListener('resize', fitStage);
fitStage();

/* ============================================================
   AUDIO (procedural, no external assets)
   ============================================================ */
let actx = null;
function ensureAudio(){ if(!actx){ try{ actx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } }
function tone(freq,dur,type,vol,slideTo){
  if(!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type||'square'; o.frequency.value = freq;
  if(slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20,slideTo), actx.currentTime+dur);
  g.gain.value = vol||0.15;
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime+dur);
  o.connect(g); g.connect(actx.destination);
  o.start(); o.stop(actx.currentTime+dur);
}
function noiseBurst(dur,vol){
  if(!actx) return;
  const bufferSize = actx.sampleRate*dur;
  const buffer = actx.createBuffer(1,bufferSize,actx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i=0;i<bufferSize;i++) data[i]=(Math.random()*2-1)*(1-i/bufferSize);
  const src = actx.createBufferSource(); src.buffer=buffer;
  const g = actx.createGain(); g.gain.value = vol||0.2;
  src.connect(g); g.connect(actx.destination);
  src.start();
}
const sfx = {
  jump(){ tone(300,0.12,'square',0.12,520); },
  land(){ tone(120,0.08,'square',0.10,60); },
  shoot(w){
    if(w==='rocket'){ tone(90,0.25,'sawtooth',0.18,40); noiseBurst(0.2,0.1); }
    else if(w==='sniper'){ tone(700,0.15,'sawtooth',0.2,150); noiseBurst(0.12,0.15); }
    else if(w==='shotgun'){ noiseBurst(0.18,0.25); tone(140,0.15,'square',0.15,60); }
    else { tone(520,0.06,'square',0.12,260); noiseBurst(0.05,0.08); }
  },
  meleeSwing(){ tone(220,0.08,'triangle',0.12,180); },
  hit(){ tone(160,0.09,'square',0.16,60); noiseBurst(0.07,0.12); },
  explosion(){ noiseBurst(0.4,0.35); tone(70,0.4,'sawtooth',0.25,25); },
  pickup(){ tone(440,0.08,'square',0.12,880); },
  ko(){ tone(500,0.35,'sawtooth',0.2,50); noiseBurst(0.25,0.2); },
  countdown(){ tone(400,0.1,'square',0.15); },
  go(){ tone(700,0.25,'square',0.2,1000); },
  win(){ tone(523,0.15,'square',0.18); setTimeout(()=>tone(659,0.15,'square',0.18),120); setTimeout(()=>tone(784,0.3,'square',0.2),260); }
};

/* ============================================================
   ARENA GEOMETRY (mirrors server/game.js — render + cosmetic only)
   ============================================================ */
function mkPlatform(x,y,w,h,opts){ const p={x,y,w,h,baseX:x,baseY:y}; if(opts) Object.assign(p,opts); return p; }
const ARENA_DEFS = {
  dock: { name:'Havneterminal', platforms:[
    mkPlatform(0,650,520,70), mkPlatform(760,650,520,70),
    mkPlatform(530,430,220,24), mkPlatform(50,480,150,24), mkPlatform(1080,480,150,24),
    mkPlatform(560,240,160,24),
    mkPlatform(500,430,24,220,{wall:true}), mkPlatform(756,430,24,220,{wall:true})
  ]},
  towers: { name:'Tårnene', platforms:[
    mkPlatform(440,650,400,70), mkPlatform(140,520,220,22), mkPlatform(920,520,220,22),
    mkPlatform(40,360,200,22), mkPlatform(1040,360,200,22),
    mkPlatform(430,250,200,22,{moving:{axis:'x',range:230,speed:1.1,phase:0}}),
    mkPlatform(520,110,240,22),
    mkPlatform(340,130,20,230,{wall:true}), mkPlatform(920,130,20,230,{wall:true})
  ]},
  bridge: { name:'Broen', platforms:[
    mkPlatform(30,620,260,40), mkPlatform(380,620,260,40), mkPlatform(720,620,260,40), mkPlatform(1060,620,190,40),
    mkPlatform(150,440,190,22), mkPlatform(930,440,190,22),
    mkPlatform(440,320,200,22,{moving:{axis:'x',range:180,speed:0.9,phase:1.6}}),
    mkPlatform(640,655,80,20,{bouncePad:true,bounceForce:1350}),
    mkPlatform(605,500,20,155,{wall:true}), mkPlatform(755,500,20,155,{wall:true})
  ]}
};
let currentArena = null; // set when arenaId known

function syncMovingPlatforms(elapsed){
  if(!currentArena) return;
  for(const pl of currentArena.platforms){
    if(!pl.moving) continue;
    if(pl.moving.axis==='x') pl.x = pl.baseX + Math.sin(elapsed*pl.moving.speed+pl.moving.phase)*pl.moving.range;
    else pl.y = pl.baseY + Math.sin(elapsed*pl.moving.speed+pl.moving.phase)*pl.moving.range;
  }
}

const WEAPON_VISUALS = {
  fists:   {name:'Næver', type:'melee', color:'#dfe3e8', cooldown:0.42},
  bat:     {name:'Bat', type:'melee', color:'#c98a4b', cooldown:0.5},
  pistol:  {name:'Pistol', type:'ranged', color:'#9ad1ff', cooldown:0.26},
  smg:     {name:'Maskinpistol', type:'ranged', color:'#ffd166', cooldown:0.085},
  shotgun: {name:'Haglgevær', type:'ranged', color:'#ff8c42', cooldown:0.62},
  sniper:  {name:'Riffel', type:'ranged', color:'#8be38b', cooldown:0.85},
  rocket:  {name:'Raketkaster', type:'ranged', color:'#ff5566', cooldown:1.05}
};

/* ============================================================
   RAGDOLL SKELETON (cosmetic, client-simulated)
   ============================================================ */
const HALF_W=15, FOOT_OFFSET=34, HEAD_TOP_OFFSET=-56;
const SKELETON_STICKS = [
  ['head','neck',14],['neck','hip',26],
  ['neck','lElbow',12],['lElbow','lHand',12],
  ['neck','rElbow',12],['rElbow','rHand',12],
  ['hip','lKnee',18],['lKnee','lFoot',18],
  ['hip','rKnee',18],['rKnee','rFoot',18]
];
function skelPoint(x,y){ return {x,y,px:x,py:y}; }
function initSkeleton(p){
  const hx=p.x, hy=p.y;
  p.skeleton = {
    hip:skelPoint(hx,hy), neck:skelPoint(hx,hy-26), head:skelPoint(hx,hy-40),
    lElbow:skelPoint(hx-10,hy-20), lHand:skelPoint(hx-20,hy-14),
    rElbow:skelPoint(hx+10,hy-20), rHand:skelPoint(hx+20,hy-14),
    lKnee:skelPoint(hx-8,hy+16), lFoot:skelPoint(hx-10,hy+34),
    rKnee:skelPoint(hx+8,hy+16), rFoot:skelPoint(hx+10,hy+34)
  };
  p.limbLoose = 0;
}
function poseTargets(p){
  const hx=p.x, hy=p.y, f=p.facing;
  const neck = {x:hx,y:hy-26};
  const t = { hip:{x:hx,y:hy}, neck, head:{x:hx,y:hy-40} };
  const swingA = Math.sin(p.walkPhase), swingB = Math.sin(p.walkPhase+Math.PI);
  const airSpread = p.grounded ? 0 : 10;
  t.lKnee = {x:hx-10+swingA*8, y:hy+16};
  t.lFoot = {x:hx-12+swingA*17-airSpread, y:hy+34};
  t.rKnee = {x:hx+10+swingB*8, y:hy+16};
  t.rFoot = {x:hx+12+swingB*17+airSpread, y:hy+34};
  const aimAngle = p.aimAngle||0;
  if(p.weapon!=='fists'){
    t.rElbow={x:neck.x+Math.cos(aimAngle)*16, y:neck.y+Math.sin(aimAngle)*16};
    t.rHand ={x:neck.x+Math.cos(aimAngle)*32, y:neck.y+Math.sin(aimAngle)*32};
    t.lElbow={x:neck.x-f*6, y:neck.y+8};
    t.lHand ={x:neck.x+Math.cos(aimAngle)*20, y:neck.y+Math.sin(aimAngle)*20+6};
  } else if(p.attackFlash>0){
    t.rElbow={x:neck.x+Math.cos(aimAngle)*16, y:neck.y+Math.sin(aimAngle)*16};
    t.rHand ={x:neck.x+Math.cos(aimAngle)*32, y:neck.y+Math.sin(aimAngle)*32};
    t.lElbow={x:neck.x-f*4, y:neck.y+6}; t.lHand={x:neck.x-f*10, y:neck.y+16};
  } else {
    t.lElbow={x:neck.x-f*4+swingB*4, y:neck.y+8}; t.lHand={x:neck.x-f*10+swingB*11, y:neck.y+22};
    t.rElbow={x:neck.x+f*4+swingA*4, y:neck.y+8}; t.rHand={x:neck.x+f*10+swingA*11, y:neck.y+22};
  }
  return t;
}
function resolvePointCollision(pt){
  if(!currentArena) return;
  for(const plat of currentArena.platforms){
    if(pt.x>plat.x && pt.x<plat.x+plat.w && pt.y>plat.y && pt.y<plat.y+plat.h){
      const distTop = pt.y-plat.y;
      if(distTop < plat.h*0.7) pt.y = plat.y-0.5;
      else if(pt.x < plat.x+plat.w/2) pt.x = plat.x-0.5;
      else pt.x = plat.x+plat.w+0.5;
    }
  }
}
function updateSkeleton(p, dt){
  const pts = p.skeleton, targets = poseTargets(p);
  if(p.ragdollTimer>0) p.limbLoose = Math.min(1, p.limbLoose*0.999 + 0.03);
  else p.limbLoose *= Math.exp(-dt*2.4);
  p.limbLoose = Math.max(p.limbLoose, 0.26);

  const spring = 0.022 + 0.10*(1-p.limbLoose);
  const grav = 480 + 1650*p.limbLoose;

  pts.hip.px=pts.hip.x; pts.hip.py=pts.hip.y; pts.hip.x=p.x; pts.hip.y=p.y;

  for(const k in pts){
    if(k==='hip') continue;
    const pt=pts[k];
    const vx=(pt.x-pt.px)*0.965, vy=(pt.y-pt.py)*0.965;
    pt.px=pt.x; pt.py=pt.y;
    pt.x+=vx; pt.y+=vy+grav*dt*dt;
  }
  for(let iter=0; iter<3; iter++){
    for(const [a,b,len] of SKELETON_STICKS){
      const p1=pts[a], p2=pts[b];
      const dx=p2.x-p1.x, dy=p2.y-p1.y;
      const d=Math.hypot(dx,dy)||0.0001;
      const diff=(len-d)/d*0.5;
      const ox=dx*diff, oy=dy*diff;
      if(a==='hip'){ p2.x+=ox*2; p2.y+=oy*2; }
      else if(b==='hip'){ p1.x-=ox*2; p1.y-=oy*2; }
      else { p1.x-=ox; p1.y-=oy; p2.x+=ox; p2.y+=oy; }
    }
    for(const k in pts){
      if(k==='hip') continue;
      const pt=pts[k], t=targets[k];
      pt.x += (t.x-pt.x)*spring*0.34;
      pt.y += (t.y-pt.y)*spring*0.34;
      resolvePointCollision(pt);
    }
  }
}
function ragdollImpulse(p, dirx, diry, power){
  const mag = Math.hypot(dirx,diry)||1;
  const nx=dirx/mag, ny=diry/mag;
  for(const k in p.skeleton){
    if(k==='hip') continue;
    const pt = p.skeleton[k];
    const kick = power*0.018*(0.6+Math.random()*0.8);
    pt.px = pt.x - (nx*kick + (Math.random()*2-1)*7);
    pt.py = pt.y - (ny*kick - 6 + (Math.random()*2-1)*7);
  }
}

/* ============================================================
   LOCAL MOVEMENT PREDICTION (self only — mirrors server physics
   exactly so the local player feels instant with zero network
   delay; the server remains authoritative and we reconcile on
   every snapshot, so nobody can cheat by predicting wrongly).
   ============================================================ */
const GRAVITY=1650, MAX_FALL=1500, GROUND_ACCEL=3400, AIR_ACCEL=1900, MAX_SPEED=360;
const JUMP_VEL=-820, WALL_JUMP_VX=440, WALL_JUMP_VY=-760, WALL_SLIDE_CAP=240;
function sendFx(kind,x,y){ send({t:'fx', kind, x, y}); }
function localGetBox(e){ return {x:e.x-HALF_W, y:e.y+HEAD_TOP_OFFSET, w:HALF_W*2, h:FOOT_OFFSET-HEAD_TOP_OFFSET}; }
function localRectsOverlap(a,b){ return a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y; }
function localMoveAndCollide(e, dt){
  if(!currentArena) return;
  e.touchWallDir = 0;
  e.x += e.vx*dt;
  let box = localGetBox(e);
  for(const pl of currentArena.platforms){
    if(localRectsOverlap(box,pl)){
      if(e.vx>0){ e.x = pl.x-HALF_W-0.01; e.touchWallDir=1; }
      else if(e.vx<0){ e.x = pl.x+pl.w+HALF_W+0.01; e.touchWallDir=-1; }
      e.vx=0; box=localGetBox(e);
    }
  }
  const wasGrounded = e.grounded;
  e.grounded=false;
  e.y += e.vy*dt;
  box = localGetBox(e);
  for(const pl of currentArena.platforms){
    if(localRectsOverlap(box,pl)){
      if(e.vy>=0){
        if(pl.bouncePad){
          e.y=pl.y-FOOT_OFFSET-0.01; e.vy=-pl.bounceForce; e.grounded=false;
          sfx.jump(); sfx.land(); spawnParticles(e.x, pl.y, 14, '#7CFC00', 260, 0.4, 500);
          sendFx('bounce', e.x, pl.y);
        } else { e.y=pl.y-FOOT_OFFSET-0.01; e.vy=0; e.grounded=true; }
      } else { e.y = pl.y+pl.h-HEAD_TOP_OFFSET+0.01; e.vy=0; }
      box = localGetBox(e);
    }
  }
  if(!wasGrounded && e.grounded && e._prevVy>650){ sfx.land(); spawnDust(e.x,e.y); }
  e._prevVy = e.vy;
  if(!e.grounded && e.touchWallDir!==0 && e.vy>0) e.vy=Math.min(e.vy, WALL_SLIDE_CAP);
}
function stepLocalPlayer(lp, input, dt){
  const accel = lp.grounded ? GROUND_ACCEL : AIR_ACCEL;
  if(input.left && !input.right) lp.vx -= accel*dt;
  else if(input.right && !input.left) lp.vx += accel*dt;
  else if(lp.grounded){ lp.vx *= 0.78; if(Math.abs(lp.vx)<8) lp.vx=0; }
  lp.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, lp.vx));

  if(input.jump && !lp._prevJump && lp.ragdollTimer<=0){
    if(lp.grounded){ lp.vy=JUMP_VEL; lp.grounded=false; sfx.jump(); spawnDust(lp.x,lp.y); sendFx('jump',lp.x,lp.y); }
    else if(lp.touchWallDir!==0){
      lp.vx = -lp.touchWallDir*WALL_JUMP_VX; lp.vy = WALL_JUMP_VY; lp.touchWallDir=0;
      sfx.jump(); spawnDust(lp.x,lp.y); sendFx('jump',lp.x,lp.y);
    }
  }
  lp._prevJump = input.jump;

  lp.vy += GRAVITY*dt; lp.vy = Math.min(lp.vy, MAX_FALL);
  localMoveAndCollide(lp, dt);
  lp.walkPhase += dt*(lp.grounded?Math.abs(lp.vx)*0.02:0);

  if(lp.attackCooldownLocal>0) lp.attackCooldownLocal -= dt;
  if(input.attack && lp.attackCooldownLocal<=0){
    const wv = WEAPON_VISUALS[lp.weapon];
    if(wv){
      lp.attackCooldownLocal = wv.cooldown;
      lp.attackFlash = 0.12;
      if(wv.type==='melee') sfx.meleeSwing(); else sfx.shoot(lp.weapon);
    }
  }
}

/* ============================================================
   PARTICLES / CAMERA SHAKE (cosmetic, client-local)
   ============================================================ */
let particles = [];
let camShake = {x:0,y:0,timer:0,mag:0};
function spawnParticles(x,y,count,color,spd,life,grav){
  for(let i=0;i<count;i++){
    const ang = Math.random()*Math.PI*2;
    const sp = spd*(0.4+Math.random()*0.9);
    particles.push({x,y,vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp-sp*0.2, life:life*(0.6+Math.random()*0.6), maxLife:life, color, grav:grav!==undefined?grav:1400, size:2+Math.random()*3});
  }
}
function spawnDust(x,y){ spawnParticles(x,y+34,6,'#888',120,0.4,600); }
function shake(mag,dur){ camShake.mag=Math.max(camShake.mag,mag); camShake.timer=Math.max(camShake.timer,dur); }

/* ============================================================
   NETWORK STATE
   ============================================================ */
let ws = null, myId = null, myIdx = -1, roomCode = null;
let netPlayers = new Map(); // id -> local render/cosmetic state
let latestSnap = null;
let latestEvents = [];
let uiState = 'MENU'; // MENU | LOBBY | GAME
let gameState = 'LOBBY';
let stateTimer = 0, roundMessage='', championName='';
let elapsedServerTime = 0;

function wsUrl(){
  const proto = location.protocol==='https:' ? 'wss://' : 'ws://';
  return proto + location.host;
}
function connect(){
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', ()=>{});
  ws.addEventListener('message', (ev)=>{
    let msg; try{ msg = JSON.parse(ev.data); }catch(e){ return; }
    handleMessage(msg);
  });
  ws.addEventListener('close', ()=>{
    if(uiState!=='MENU'){ showMenuError('Forbindelsen blev afbrudt.'); showScreen('menu'); uiState='MENU'; }
  });
  ws.addEventListener('error', ()=>{});
}
function send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

function handleMessage(msg){
  if(msg.t==='joined'){
    myId = msg.id; myIdx = msg.you; roomCode = msg.code;
    document.getElementById('roomCodeDisplay').textContent = roomCode;
    uiState='LOBBY'; showScreen('lobby');
  } else if(msg.t==='error'){
    showMenuError(msg.message);
  } else if(msg.t==='lobby'){
    renderLobby(msg);
  } else if(msg.t==='roomList'){
    renderRoomList(msg.rooms);
  } else if(msg.t==='fx'){
    if(msg.id!==myId){
      if(msg.kind==='jump'){ spawnDust(msg.x,msg.y); sfx.jump(); }
      else if(msg.kind==='land'){ spawnDust(msg.x,msg.y); sfx.land(); }
      else if(msg.kind==='bounce'){ spawnParticles(msg.x,msg.y,14,'#7CFC00',260,0.4,500); sfx.jump(); sfx.land(); }
    }
  } else if(msg.t==='state'){
    latestSnap = msg.snap;
    latestSnap._recvAt = performance.now();
    latestEvents = msg.events || [];
    applySnapshot(latestSnap);
    processEvents(latestEvents);
    if(uiState!=='GAME'){ uiState='GAME'; showScreen(null); document.getElementById('hud').classList.remove('hidden'); buildHUD(latestSnap.players); }
  }
}

function applySnapshot(snap){
  gameState = snap.state; stateTimer = snap.stateTimer; roundMessage = snap.roundMessage;
  elapsedServerTime = snap.elapsed;
  if(snap.arenaId && (!currentArena || currentArena._id!==snap.arenaId)){
    currentArena = JSON.parse(JSON.stringify(ARENA_DEFS[snap.arenaId]));
    currentArena._id = snap.arenaId;
    currentArena.platforms.forEach(p=>{ p.baseX=p.x; p.baseY=p.y; });
  }
  syncMovingPlatforms(elapsedServerTime);
  const now = performance.now();
  const seen = new Set();
  snap.players.forEach(sp=>{
    seen.add(sp.id);
    let lp = netPlayers.get(sp.id);
    const isSelf = sp.id===myId;
    if(!lp){
      lp = { id:sp.id, idx:sp.idx, name:sp.name, color:sp.color,
        x:sp.x, y:sp.y, vx:sp.vx||0, vy:sp.vy||0, prevX:sp.x, prevY:sp.y, targetX:sp.x, targetY:sp.y, recvTime:now,
        facing:sp.facing, grounded:sp.grounded, aimAngle:sp.aimAngle||0, touchWallDir:0, _prevJump:false, attackCooldownLocal:0,
        weapon:sp.weapon, ammo:sp.ammo, damage:sp.damage,
        alive:sp.alive, ragdollTimer:sp.ragdollTimer, walkPhase:sp.walkPhase, roundWins:sp.roundWins,
        invuln:sp.invuln, hitFlash:0, attackFlash:0 };
      initSkeleton(lp);
      netPlayers.set(sp.id, lp);
    } else {
      if(!isSelf){
        // remote player: position comes purely from what they reported — interpolate for smoothness
        lp.prevX = lp.targetX; lp.prevY = lp.targetY;
        lp.targetX = sp.x; lp.targetY = sp.y; lp.recvTime = now;
        lp.facing=sp.facing; lp.grounded=sp.grounded; lp.aimAngle=sp.aimAngle||0;
        lp.walkPhase=sp.walkPhase;
      }
      // self: x/y/vx/vy/facing/grounded/walkPhase/aimAngle are fully owned by local prediction —
      // the server never overrides normal movement, only combat outcomes (via events below).
      lp.name=sp.name; lp.color=sp.color;
      lp.weapon=sp.weapon; lp.ammo=sp.ammo; lp.damage=sp.damage; lp.alive=sp.alive;
      lp.ragdollTimer=sp.ragdollTimer; lp.roundWins=sp.roundWins; lp.invuln=sp.invuln;
    }
  });
  netPlayers.forEach((lp,id)=>{ if(!seen.has(id)) netPlayers.delete(id); });
  updateHUD(snap.players);
}

function processEvents(events){
  for(const e of events){
    if(e.t==='hit'){
      const lp = netPlayers.get(e.id);
      if(lp){
        ragdollImpulse(lp, e.dirx, e.diry, e.power); lp.hitFlash=0.15;
        spawnParticles(lp.x, lp.y-30, 10, '#fff', 260, 0.35, 900);
        if(e.id===myId){
          // this is the one place the server overrides local movement: a confirmed hit's knockback.
          lp.vx += e.dirx*e.power; lp.vy += e.diry*e.power - e.power*0.18;
        }
      }
      sfx.hit();
    } else if(e.t==='ko'){
      spawnParticles(e.x,e.y,20,'#ddd',300,0.6,500); sfx.ko(); shake(10,0.3);
    } else if(e.t==='shot'){
      const lp = netPlayers.get(e.id);
      spawnParticles(e.x,e.y,4,'#ffe8a3',180,0.12,300);
      if(lp) lp.attackFlash = 0.12;
      if(e.id!==myId) sfx.shoot(e.weapon);
    } else if(e.t==='melee'){
      const lp = netPlayers.get(e.id);
      if(lp){ lp.attackFlash=0.12; spawnParticles(lp.x+lp.facing*30, lp.y-30, 4, '#fff', 150, 0.2, 200); }
      if(e.id!==myId) sfx.meleeSwing();
    } else if(e.t==='impact'){
      spawnParticles(e.x,e.y,5,'#ccc',150,0.25,400);
    } else if(e.t==='explosion'){
      spawnParticles(e.x,e.y,26,'#ffb347',420,0.6,700);
      spawnParticles(e.x,e.y,14,'#ff5566',300,0.45,700);
      sfx.explosion(); shake(18,0.35);
    } else if(e.t==='bounce'){
      spawnParticles(e.x,e.y,14,'#7CFC00',260,0.4,500); sfx.jump(); sfx.land();
    } else if(e.t==='pickup'){
      const lp = netPlayers.get(e.id);
      if(lp) spawnParticles(lp.x,lp.y-30,8,WEAPON_VISUALS[lp.weapon]?WEAPON_VISUALS[lp.weapon].color:'#fff',180,0.3,300);
      sfx.pickup();
    } else if(e.t==='crateland'){
      spawnParticles(e.x,e.y,12,'#fff',220,0.4,700); spawnDust(e.x,e.y-34); sfx.land();
    } else if(e.t==='tick3'){ sfx.countdown(); }
    else if(e.t==='go'){ sfx.go(); }
    else if(e.t==='win'){ sfx.win(); }
    else if(e.t==='roundend'){ if(e.winnerId) sfx.win(); }
  }
}

/* ============================================================
   MENU / LOBBY UI
   ============================================================ */
const screens = { menu:document.getElementById('screen-menu'), howto:document.getElementById('screen-howto'), lobby:document.getElementById('screen-lobby'), findrooms:document.getElementById('screen-findrooms') };
let roomListPoll = null;
function showScreen(name){
  Object.values(screens).forEach(s=>s.classList.add('hidden'));
  if(name) screens[name].classList.remove('hidden');
  if(name!=='findrooms' && roomListPoll){ clearInterval(roomListPoll); roomListPoll=null; }
}
function showMenuError(msg){
  document.getElementById('menuError').textContent = msg||'';
  const fe = document.getElementById('findRoomsError'); if(fe) fe.textContent = msg||'';
}
function withConnection(fn){
  if(!ws || ws.readyState!==1){ connect(); ws.addEventListener('open', fn, {once:true}); }
  else fn();
}

document.getElementById('btn-create').onclick = ()=>{
  ensureAudio(); showMenuError('');
  withConnection(()=> send({t:'create', name:document.getElementById('nameInput').value, public:document.getElementById('publicCheck').checked}));
};
document.getElementById('btn-join').onclick = ()=>{
  ensureAudio(); showMenuError('');
  const code = document.getElementById('codeInput').value.trim();
  if(code.length<4){ showMenuError('Indtast en 4-tegns kode.'); return; }
  withConnection(()=> send({t:'join', code, name:document.getElementById('nameInput').value}));
};
document.getElementById('btn-findrooms').onclick = ()=>{
  ensureAudio(); showMenuError('');
  document.getElementById('findNameInput').value = document.getElementById('nameInput').value;
  showScreen('findrooms');
  document.getElementById('roomList').innerHTML='';
  document.getElementById('roomListEmpty').classList.add('hidden');
  withConnection(()=> send({t:'listRooms'}));
  if(roomListPoll) clearInterval(roomListPoll);
  roomListPoll = setInterval(()=> withConnection(()=> send({t:'listRooms'})), 2500);
};
document.getElementById('btn-refresh-rooms').onclick = ()=> withConnection(()=> send({t:'listRooms'}));
document.getElementById('btn-back-findrooms').onclick = ()=> showScreen('menu');
function renderRoomList(rooms){
  const wrap = document.getElementById('roomList');
  wrap.innerHTML='';
  document.getElementById('roomListEmpty').classList.toggle('hidden', rooms.length>0);
  rooms.forEach(r=>{
    const row = document.createElement('div');
    row.className='roomRow';
    row.innerHTML = '<div class="info"><div class="code">'+escapeHtml(r.code)+'</div><div class="host">Vært: '+escapeHtml(r.host)+'</div></div>'+
      '<div><span class="count">'+r.count+'/4</span><button>Deltag</button></div>';
    row.querySelector('button').onclick = ()=>{
      showMenuError('');
      withConnection(()=> send({t:'join', code:r.code, name:document.getElementById('findNameInput').value}));
    };
    wrap.appendChild(row);
  });
}
document.getElementById('btn-howto').onclick = ()=> showScreen('howto');
document.getElementById('btn-back-howto').onclick = ()=> showScreen(uiState==='LOBBY'?'lobby':'menu');
document.getElementById('btn-leave').onclick = ()=>{
  send({t:'leave'}); uiState='MENU'; showScreen('menu'); document.getElementById('hud').classList.add('hidden');
};
let iAmReady = false;
document.getElementById('btn-ready').onclick = ()=>{
  iAmReady = !iAmReady; send({t:'ready', ready:iAmReady});
  document.getElementById('btn-ready').classList.toggle('active', iAmReady);
  document.getElementById('btn-ready').textContent = iAmReady ? 'Klar ✓' : 'Klar';
};
document.getElementById('btn-start').onclick = ()=> send({t:'start'});

function renderLobby(msg){
  roomCode = msg.code;
  document.getElementById('roomCodeDisplay').textContent = roomCode;
  const wrap = document.getElementById('lobbyPlayers');
  wrap.innerHTML='';
  msg.players.forEach(p=>{
    const el = document.createElement('div');
    el.className = 'lobbyCard'+(p.ready?' isready':'');
    el.innerHTML = '<span class="dot" style="background:'+p.color+'"></span><div class="nm">'+escapeHtml(p.name)+(p.id===myId?' (dig)':'')+'</div><div class="st">'+(p.connected?(p.ready?'Klar':'Venter...'):'Afbrudt')+'</div>';
    wrap.appendChild(el);
  });
  const allReady = msg.players.length>=2 && msg.players.every(p=>p.ready);
  const iAmHost = msg.players[0] && msg.players[0].id===myId;
  document.getElementById('btn-start').classList.toggle('hidden', !(iAmHost && allReady));
  document.getElementById('lobbyHint').textContent = msg.players.length<2 ? 'Venter på flere spillere (min. 2)...' : (allReady ? (iAmHost ? 'Alle er klar — tryk Start kamp!' : 'Alle er klar — venter på værten...') : 'Venter på at alle spillere trykker "Klar"...');
}
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

/* ============================================================
   HUD
   ============================================================ */
function buildHUD(players){
  const hud = document.getElementById('hud');
  hud.innerHTML='';
  players.forEach(p=>{
    const el = document.createElement('div');
    el.className='hudplayer';
    el.style.borderBottom='3px solid '+p.color;
    el.innerHTML = '<span class="playerdot" style="width:16px;height:16px;border-radius:50%;display:inline-block;background:'+p.color+'"></span>'+
      '<div><div class="hudname">'+escapeHtml(p.name)+'</div><div class="hudwins" id="wins-'+p.id+'">Sejre: 0</div></div>'+
      '<div class="huddmg display" id="dmg-'+p.id+'" style="color:'+p.color+'">0%</div>';
    hud.appendChild(el);
  });
}
function updateHUD(players){
  players.forEach(p=>{
    const d = document.getElementById('dmg-'+p.id);
    if(d) d.textContent = Math.min(999, p.damage)+'%';
    const w = document.getElementById('wins-'+p.id);
    if(w) w.textContent = 'Sejre: '+p.roundWins + (p.alive?'':'  ✖');
  });
}

/* ============================================================
   INPUT — keyboard/gamepad for movement, mouse for aiming
   ============================================================ */
const heldKeys = new Set();
window.addEventListener('keydown', e=>{ heldKeys.add(e.code); if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault(); });
window.addEventListener('keyup', e=>{ heldKeys.delete(e.code); });

let mouseWorld = {x:WORLD.width/2, y:WORLD.height/2};
let mouseHeld = false;
function updateMouseWorld(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  mouseWorld.x = (clientX-rect.left)/rect.width*WORLD.width;
  mouseWorld.y = (clientY-rect.top)/rect.height*WORLD.height;
}
canvas.addEventListener('mousemove', e=> updateMouseWorld(e.clientX, e.clientY));
canvas.addEventListener('mousedown', e=>{ if(e.button===0){ mouseHeld=true; ensureAudio(); } });
window.addEventListener('mouseup', e=>{ if(e.button===0) mouseHeld=false; });
canvas.addEventListener('contextmenu', e=> e.preventDefault());
canvas.addEventListener('touchmove', e=>{ if(e.touches[0]){ updateMouseWorld(e.touches[0].clientX, e.touches[0].clientY); } }, {passive:true});
canvas.addEventListener('touchstart', e=>{ if(e.touches[0]){ updateMouseWorld(e.touches[0].clientX, e.touches[0].clientY); mouseHeld=true; ensureAudio(); } }, {passive:true});
window.addEventListener('touchend', ()=>{ mouseHeld=false; });

function readLocalInput(){
  const left = heldKeys.has('KeyA')||heldKeys.has('ArrowLeft');
  const right = heldKeys.has('KeyD')||heldKeys.has('ArrowRight');
  const jump = heldKeys.has('KeyW')||heldKeys.has('ArrowUp')||heldKeys.has('Space');
  const attack = heldKeys.has('KeyF')||heldKeys.has('Enter')||heldKeys.has('KeyJ')||mouseHeld;
  let g = {left:false,right:false,jump:false,attack:false};
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads[0];
  if(pad){
    const axis = pad.axes[0]||0;
    g.left = axis<-0.35 || (pad.buttons[14]&&pad.buttons[14].pressed);
    g.right = axis>0.35 || (pad.buttons[15]&&pad.buttons[15].pressed);
    g.jump = !!(pad.buttons[0]&&pad.buttons[0].pressed);
    g.attack = !!((pad.buttons[2]&&pad.buttons[2].pressed)||(pad.buttons[7]&&pad.buttons[7].pressed));
  }
  return { left:left||g.left, right:right||g.right, jump:jump||g.jump, attack:attack||g.attack };
}
setInterval(()=>{
  if(uiState==='GAME' && myId){
    const lp = netPlayers.get(myId);
    if(lp) send({t:'move', x:lp.x, y:lp.y, vx:lp.vx, vy:lp.vy, facing:lp.facing, grounded:lp.grounded, aimAngle:lp.aimAngle, walkPhase:lp.walkPhase, attack:readLocalInput().attack});
  }
}, 33);
window.addEventListener('keydown', e=>{
  if(e.code==='Enter' || e.code==='KeyF' || e.code==='Space'){
    if(gameState==='SCOREBOARD' || gameState==='MATCHEND') send({t:'continue'});
  }
});

/* ============================================================
   RENDERING
   ============================================================ */
function drawBackground(){
  const g = ctx.createLinearGradient(0,0,0,WORLD.height);
  g.addColorStop(0,'#181c26'); g.addColorStop(1,'#0a0b10');
  ctx.fillStyle = g; ctx.fillRect(0,0,WORLD.width,WORLD.height);
  ctx.save(); ctx.globalAlpha=0.06;
  for(let i=0;i<WORLD.width;i+=60){ ctx.strokeStyle='#fff'; ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,WORLD.height); ctx.stroke(); }
  ctx.restore();
}
function drawPlatform(p){
  if(p.wall){
    ctx.fillStyle='#20242e'; ctx.fillRect(p.x,p.y,p.w,p.h);
    ctx.fillStyle='#3c4152'; ctx.fillRect(p.x,p.y,p.w*0.4,p.h);
    ctx.save(); ctx.globalAlpha=0.5; ctx.strokeStyle='#f2c230'; ctx.lineWidth=2;
    for(let yy=p.y+6; yy<p.y+p.h; yy+=16){ ctx.beginPath(); ctx.moveTo(p.x+2,yy); ctx.lineTo(p.x+p.w-2,yy); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle='#000'; ctx.lineWidth=2; ctx.strokeRect(p.x+1,p.y+1,p.w-2,p.h-2);
    return;
  }
  if(p.bouncePad){
    ctx.fillStyle='#2b2e38'; ctx.fillRect(p.x,p.y,p.w,p.h);
    const pulse = 0.7+0.3*Math.sin(performance.now()*0.007);
    ctx.save(); ctx.globalAlpha=pulse; ctx.fillStyle='#7CFC00'; ctx.fillRect(p.x+2,p.y-6,p.w-4,p.h+6); ctx.restore();
    ctx.fillStyle='#000'; ctx.beginPath();
    const cx=p.x+p.w/2, cy=p.y-14;
    ctx.moveTo(cx,cy-10); ctx.lineTo(cx+9,cy+4); ctx.lineTo(cx-9,cy+4); ctx.closePath(); ctx.fill();
    return;
  }
  ctx.fillStyle = '#2b2e38'; ctx.fillRect(p.x,p.y,p.w,p.h);
  ctx.fillStyle = '#4a4f5e'; ctx.fillRect(p.x,p.y,p.w,5);
  ctx.save(); ctx.beginPath(); ctx.rect(p.x,p.y,p.w,4); ctx.clip(); ctx.fillStyle='#000'; ctx.fillRect(p.x,p.y,p.w,4); ctx.restore();
}
function drawPickup(pu){
  const w = WEAPON_VISUALS[pu.type]; if(!w) return;
  const bob = Math.sin(performance.now()*0.003 + pu.x)*4;
  ctx.save(); ctx.translate(pu.x, pu.y-14+bob);
  ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0,18,16,5,0,0,Math.PI*2); ctx.fill();
  ctx.fillStyle=w.color; ctx.strokeStyle='#000'; ctx.lineWidth=2; ctx.beginPath();
  if(w.type==='melee'){ ctx.fillRect(-4,-16,8,32); ctx.strokeRect(-4,-16,8,32); }
  else { ctx.fillRect(-16,-6,32,12); ctx.strokeRect(-16,-6,32,12); }
  ctx.restore();
  ctx.fillStyle='#fff'; ctx.font='bold 11px Oswald'; ctx.textAlign='center';
  ctx.fillText(w.name, pu.x, pu.y-34+bob);
}
function drawFallingCrate(c){
  const w = WEAPON_VISUALS[c.type]; if(!w) return;
  ctx.save(); ctx.globalAlpha=0.3; ctx.strokeStyle=w.color; ctx.lineWidth=3;
  ctx.beginPath(); ctx.moveTo(c.x, Math.max(0,c.y-40)); ctx.lineTo(c.x, c.y-14); ctx.stroke();
  ctx.globalAlpha=1; ctx.restore();
  ctx.save(); ctx.translate(c.x,c.y); ctx.rotate(performance.now()*0.002);
  ctx.strokeStyle='#000'; ctx.lineWidth=2.5; ctx.fillStyle=w.color;
  ctx.fillRect(-11,-11,22,22); ctx.strokeRect(-11,-11,22,22);
  ctx.restore();
}
function drawArena(snap){
  drawBackground();
  if(!currentArena) return;
  ctx.save(); ctx.translate(camShake.x||0, camShake.y||0);
  for(const p of currentArena.platforms) drawPlatform(p);
  ctx.restore();
  (snap.fallingCrates||[]).forEach(drawFallingCrate);
  (snap.pickups||[]).forEach(drawPickup);
}
const LIMB_SEGMENTS = [
  ['hip','lKnee',9],['lKnee','lFoot',8], ['hip','rKnee',9],['rKnee','rFoot',8],
  ['hip','neck',11], ['neck','lElbow',7],['lElbow','lHand',7], ['neck','rElbow',7],['rElbow','rHand',7]
];
function drawStick(p){
  const pts = p.skeleton;
  const sx = camShake.x||0, sy = camShake.y||0;
  const flash = p.hitFlash>0;
  const bodyColor = flash ? '#ffffff' : p.color;
  const alpha = p.alive ? (p.invuln>0 ? (0.5+0.5*Math.sin(performance.now()*0.02)) : 1) : 0;
  if(alpha<=0) return;
  ctx.save(); ctx.translate(sx,sy); ctx.globalAlpha=alpha;
  ctx.fillStyle='rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.ellipse(pts.hip.x, Math.min(WORLD.height-4,pts.hip.y+40), 18,6,0,0,Math.PI*2); ctx.fill();
  ctx.lineCap='round';
  for(const [a,b,w] of LIMB_SEGMENTS){ ctx.strokeStyle='#000'; ctx.lineWidth=w+3; ctx.beginPath(); ctx.moveTo(pts[a].x,pts[a].y); ctx.lineTo(pts[b].x,pts[b].y); ctx.stroke(); }
  for(const [a,b,w] of LIMB_SEGMENTS){
    const isTorso = (a==='hip'&&b==='neck');
    ctx.strokeStyle = isTorso ? bodyColor : '#d9dce2'; ctx.lineWidth=w-2;
    ctx.beginPath(); ctx.moveTo(pts[a].x,pts[a].y); ctx.lineTo(pts[b].x,pts[b].y); ctx.stroke();
  }
  const w = WEAPON_VISUALS[p.weapon];
  if(w && p.weapon!=='fists'){
    const dx=pts.rHand.x-pts.neck.x, dy=pts.rHand.y-pts.neck.y, ang=Math.atan2(dy,dx);
    ctx.save(); ctx.translate(pts.rHand.x,pts.rHand.y); ctx.rotate(ang);
    ctx.fillStyle='#000';
    if(w.type==='melee') ctx.fillRect(0,-5,30,10); else ctx.fillRect(0,-5,26,10);
    ctx.fillStyle=w.color;
    if(w.type==='melee') ctx.fillRect(1,-3.5,27,7); else ctx.fillRect(1,-3.5,23,7);
    ctx.restore();
  }
  const hd=pts.head, nk=pts.neck;
  const headAngle = Math.atan2(hd.y-nk.y, hd.x-nk.x);
  ctx.fillStyle='#000'; ctx.beginPath(); ctx.arc(hd.x,hd.y,13,0,Math.PI*2); ctx.fill();
  ctx.fillStyle= flash?'#333':'#1c1c1c'; ctx.beginPath(); ctx.arc(hd.x,hd.y,11,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(hd.x+Math.cos(headAngle+(p.facing>0?0.7:-0.7))*5, hd.y+3, 2.4,0,Math.PI*2); ctx.fill();
  ctx.save(); ctx.translate(hd.x,hd.y); ctx.rotate(headAngle+Math.PI/2);
  ctx.fillStyle=bodyColor; ctx.fillRect(-11,-6,22,5); ctx.restore();
  ctx.restore(); ctx.globalAlpha=1;
  if(p.alive){
    ctx.save(); ctx.translate(sx,sy);
    ctx.fillStyle=p.color; ctx.font='bold 13px Oswald'; ctx.textAlign='center';
    ctx.fillText(p.name, pts.head.x, pts.head.y-24);
    ctx.restore();
  }
}
function drawParticles(){
  for(const pt of particles){
    ctx.globalAlpha = Math.max(0,pt.life/pt.maxLife);
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x+(camShake.x||0)-pt.size/2, pt.y+(camShake.y||0)-pt.size/2, pt.size, pt.size);
  }
  ctx.globalAlpha=1;
}
function drawProjectiles(snap){
  for(const pr of (snap.projectiles||[])){
    const w = WEAPON_VISUALS[pr.weapon];
    ctx.save(); ctx.translate(pr.x+(camShake.x||0), pr.y+(camShake.y||0));
    ctx.rotate(Math.atan2(pr.vy,pr.vx));
    ctx.fillStyle = w?w.color:'#fff';
    if(pr.explosive){ ctx.beginPath(); ctx.arc(0,0,7,0,Math.PI*2); ctx.fill(); }
    else ctx.fillRect(-8,-2,16,4);
    ctx.restore();
  }
}
function drawOverlayPanel(lines, sub){
  ctx.save();
  ctx.fillStyle='rgba(5,6,9,0.72)'; ctx.fillRect(0,0,WORLD.width,WORLD.height);
  ctx.textAlign='center';
  ctx.fillStyle='#f2c230'; ctx.font='700 18px Oswald'; ctx.fillText(sub||'', WORLD.width/2, WORLD.height/2-70);
  ctx.fillStyle='#eef0f3'; ctx.font='900 54px Archivo Black, sans-serif';
  lines.forEach((line,i)=> ctx.fillText(line, WORLD.width/2, WORLD.height/2+i*60));
  ctx.restore();
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
let lastT = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  let dt = (now-lastT)/1000; lastT = now; dt = Math.min(dt,1/20);

  ctx.clearRect(0,0,WORLD.width,WORLD.height);

  if(latestSnap && (uiState==='GAME')){
    syncMovingPlatforms(elapsedServerTime + (now-(latestSnap._recvAt||now))/1000);
    // self: instant local prediction. others: smooth interpolation between snapshots.
    const localInput = uiState==='GAME' ? readLocalInput() : null;
    netPlayers.forEach(lp=>{
      const isSelf = lp.id===myId;
      if(isSelf && lp.alive){
        const ang = Math.atan2(mouseWorld.y-(lp.y-26), mouseWorld.x-lp.x);
        lp.aimAngle = ang; lp.facing = Math.cos(ang)>=0 ? 1 : -1;
      }
      if(isSelf && lp.alive && gameState==='FIGHT'){
        stepLocalPlayer(lp, localInput, dt);
      } else if(!isSelf){
        const alpha = Math.max(0, Math.min(1.4, (now-lp.recvTime)/TICK_MS));
        lp.x = lp.prevX + (lp.targetX-lp.prevX)*alpha;
        lp.y = lp.prevY + (lp.targetY-lp.prevY)*alpha;
      }
      if(lp.hitFlash>0) lp.hitFlash-=dt;
      if(lp.attackFlash>0) lp.attackFlash-=dt;
      updateSkeleton(lp, dt);
    });
    for(let i=particles.length-1;i>=0;i--){
      const pt=particles[i]; pt.life-=dt; if(pt.life<=0){ particles.splice(i,1); continue; }
      pt.vy+=pt.grav*dt; pt.x+=pt.vx*dt; pt.y+=pt.vy*dt;
    }
    if(camShake.timer>0){ camShake.timer-=dt; camShake.x=(Math.random()*2-1)*camShake.mag; camShake.y=(Math.random()*2-1)*camShake.mag; camShake.mag*=0.9; }
    else { camShake.x=0; camShake.y=0; }

    drawArena(latestSnap);
    drawProjectiles(latestSnap);
    netPlayers.forEach(lp=>drawStick(lp));
    drawParticles();

    if(gameState==='COUNTDOWN'){
      const n = Math.ceil(stateTimer);
      drawOverlayPanel([n>0?String(n):'KÆMP!'], currentArena.name.toUpperCase());
    } else if(gameState==='ROUNDEND'){
      drawOverlayPanel([roundMessage], 'RUNDE SLUT');
    } else if(gameState==='SCOREBOARD'){
      ctx.save(); ctx.fillStyle='rgba(5,6,9,0.85)'; ctx.fillRect(0,0,WORLD.width,WORLD.height);
      ctx.textAlign='center'; ctx.fillStyle='#f2c230'; ctx.font='700 18px Oswald'; ctx.fillText('STILLING', WORLD.width/2, 150);
      latestSnap.players.forEach((p,i)=>{
        const y = 230+i*70;
        ctx.fillStyle=p.color; ctx.beginPath(); ctx.arc(WORLD.width/2-180,y-8,14,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#eef0f3'; ctx.font='700 26px Oswald'; ctx.textAlign='left'; ctx.fillText(p.name, WORLD.width/2-150, y);
        ctx.textAlign='right'; ctx.fillText('Sejre: '+p.roundWins, WORLD.width/2+220, y);
        ctx.textAlign='center';
      });
      ctx.fillStyle='#9aa0ab'; ctx.font='500 15px Oswald'; ctx.fillText('Tryk angreb for at fortsætte', WORLD.width/2, WORLD.height-70);
      ctx.restore();
    } else if(gameState==='MATCHEND'){
      const champ = latestSnap.players.find(p=>p.id===latestSnap.champion);
      drawOverlayPanel([champ?champ.name+' VINDER!':'KAMP SLUT'], 'MESTERSKAB');
      ctx.save(); ctx.textAlign='center'; ctx.fillStyle='#9aa0ab'; ctx.font='500 15px Oswald';
      ctx.fillText('Tryk angreb for revanche', WORLD.width/2, WORLD.height/2+110);
      ctx.restore();
    }
  }
}
requestAnimationFrame(frame);
showScreen('menu');
connect();
})();

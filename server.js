const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── State ──────────────────────────────────────────────────────────────────────
const STATE = {
  globalClicks: 0,
  totalUsers: 0,
  chaosMode: false,
  chaosModeEndsAt: null,
  lastChaosAt: 0,
  clickMultiplier: 1,
  milestone: 1_000_000,
  endgameReached: false,
  secretPhase: 0,         // 0-4, ramps up hints
  connectedSockets: new Set(),
  userRegistry: new Map(), // userId -> { clicks, joinTime, title, clickerNumber }
  clickerCount: 0,
};

// Cryptic hints that surface at secret thresholds
const SECRET_HINTS = [
  { at: 1000,    msg: "The button remembers you." },
  { at: 5000,    msg: "Something stirs beneath the surface." },
  { at: 10000,   msg: "You are not the first. You will not be the last." },
  { at: 25000,   msg: "Every click feeds the void. Keep going." },
  { at: 50000,   msg: "The Pattern is almost complete. Don't stop now." },
  { at: 100000,  msg: "ÿÿÿ — SIGNAL DETECTED — ÿÿÿ" },
  { at: 250000,  msg: "We see you. All of you. Together." },
  { at: 500000,  msg: "THE THRESHOLD APPROACHES. IT CANNOT BE STOPPED." },
  { at: 750000,  msg: "99.7% of the sequence complete. The old world ends soon." },
  { at: 999999,  msg: "ONE MORE." },
];
let hintIndex = 0;

// ── Title System ───────────────────────────────────────────────────────────────
function getTitle(clicks, clickerNumber, joinTime) {
  const age = Date.now() - joinTime;
  if (STATE.endgameReached) return "Chaos Incarnate";
  if (clickerNumber <= 10) return "Pioneer of the Void";
  if (clickerNumber <= 100) return "Early Witness";
  if (clicks >= 10000) return "Entropy God";
  if (clicks >= 5000) return "Chaos Architect";
  if (clicks >= 1000) return "Entropy Agent";
  if (clicks >= 500) return "Chaos Acolyte";
  if (clicks >= 100) return "Button Disciple";
  if (clicks >= 10) return "Curious Clicker";
  return "Newcomer";
}

// ── Rate limiting ──────────────────────────────────────────────────────────────
const clickLimiter = new Map(); // socketId -> { count, resetAt }
const CLICK_LIMIT = 20;
const CLICK_WINDOW = 1000; // ms

function isRateLimited(socketId) {
  const now = Date.now();
  let entry = clickLimiter.get(socketId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + CLICK_WINDOW };
    clickLimiter.set(socketId, entry);
  }
  entry.count++;
  return entry.count > CLICK_LIMIT;
}

// ── Reward System ─────────────────────────────────────────────────────────────
const REWARDS = [
  { id: 'golden_click',   chance: 0.02,  worth: 10,  label: '✦ GOLDEN CLICK',    desc: 'Worth 10x! The void smiles upon you.' },
  { id: 'triple_click',   chance: 0.05,  worth: 3,   label: '⚡ TRIPLE STRIKE',   desc: 'Three for the price of one.' },
  { id: 'chaos_herald',   chance: 0.008, worth: 1,   label: '🌀 CHAOS HERALD',    desc: 'You summoned chaos early.' },
  { id: 'title_unlock',   chance: 0.01,  worth: 1,   label: '👁 TITLE REVEALED',  desc: null }, // desc generated at runtime
  { id: 'secret_msg',     chance: 0.005, worth: 1,   label: '📡 SIGNAL RECEIVED', desc: null },
  { id: 'theme_unlock',   chance: 0.008, worth: 1,   label: '🎨 THEME UNLOCKED',  desc: 'A new skin for the button.' },
];

const SECRET_MESSAGES = [
  "The button has always existed.",
  "You are clickerNumber: prime.",
  "404: Reality not found.",
  "The counter is a lie. Or is it?",
  "Your ID was chosen before you were born.",
  "Every 13th click echoes forever.",
  "The void clicked back.",
  "This message will self-destruct. It didn't.",
  "Behind the button: nothing. Or everything.",
  "You clicked. Something listened.",
];

function rollReward(userId) {
  const roll = Math.random();
  let cumulative = 0;
  for (const reward of REWARDS) {
    cumulative += reward.chance;
    if (roll < cumulative) {
      const r = { ...reward };
      if (r.id === 'secret_msg') r.desc = SECRET_MESSAGES[Math.floor(Math.random() * SECRET_MESSAGES.length)];
      if (r.id === 'title_unlock') r.desc = "A new title has been inscribed in the void.";
      return r;
    }
  }
  return null;
}

// ── Chaos Mode ─────────────────────────────────────────────────────────────────
function triggerChaos(durationMs = 15000) {
  STATE.chaosMode = true;
  STATE.chaosModeEndsAt = Date.now() + durationMs;
  STATE.clickMultiplier = 5;
  STATE.lastChaosAt = Date.now();

  io.emit('chaos_start', {
    duration: durationMs,
    multiplier: STATE.clickMultiplier,
    endsAt: STATE.chaosModeEndsAt,
  });

  setTimeout(() => {
    STATE.chaosMode = false;
    STATE.clickMultiplier = 1;
    io.emit('chaos_end', { globalClicks: STATE.globalClicks });
  }, durationMs);
}

// Random server-side chaos every 2-5 minutes
function scheduleChaos() {
  const delay = 120_000 + Math.random() * 180_000;
  setTimeout(() => {
    if (!STATE.chaosMode && STATE.connectedSockets.size > 0) {
      triggerChaos(12000 + Math.random() * 8000);
    }
    scheduleChaos();
  }, delay);
}

// ── Check Hints ────────────────────────────────────────────────────────────────
function checkHints() {
  while (hintIndex < SECRET_HINTS.length && STATE.globalClicks >= SECRET_HINTS[hintIndex].at) {
    io.emit('secret_hint', { msg: SECRET_HINTS[hintIndex].msg, clicks: STATE.globalClicks });
    hintIndex++;
  }
}

// ── Socket.io ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  STATE.connectedSockets.add(socket.id);

  // Send initial state
  socket.emit('init', {
    globalClicks: STATE.globalClicks,
    totalUsers: STATE.clickerCount,
    chaosMode: STATE.chaosMode,
    chaosModeEndsAt: STATE.chaosModeEndsAt,
    multiplier: STATE.clickMultiplier,
    endgameReached: STATE.endgameReached,
  });

  // Register or re-register user
  socket.on('register', ({ userId }) => {
    let user = STATE.userRegistry.get(userId);
    if (!user) {
      STATE.clickerCount++;
      user = {
        clicks: 0,
        joinTime: Date.now(),
        clickerNumber: STATE.clickerCount,
        title: 'Newcomer',
        socketId: socket.id,
      };
      STATE.userRegistry.set(userId, user);
    } else {
      user.socketId = socket.id;
    }
    user.title = getTitle(user.clicks, user.clickerNumber, user.joinTime);
    socket.emit('identity', {
      clickerNumber: user.clickerNumber,
      clicks: user.clicks,
      title: user.title,
      joinTime: user.joinTime,
    });
  });

  // Handle click
  socket.on('click', ({ userId, isChaosClick }) => {
    if (STATE.endgameReached) return;
    if (isRateLimited(socket.id)) {
      socket.emit('rate_limited');
      return;
    }

    const user = STATE.userRegistry.get(userId);
    if (!user) return;

    const multiplier = STATE.chaosMode ? STATE.clickMultiplier : 1;
    const worth = multiplier;

    STATE.globalClicks += worth;
    user.clicks += worth;
    user.title = getTitle(user.clicks, user.clickerNumber, user.joinTime);

    // Roll for reward
    const reward = rollReward(userId);

    // Roll for click-triggered chaos (low probability, not during chaos)
    let chaosTriggered = false;
    if (!STATE.chaosMode && Math.random() < 0.003) {
      triggerChaos(10000 + Math.random() * 10000);
      chaosTriggered = true;
    }

    // Reward: chaos herald triggers chaos immediately
    if (reward && reward.id === 'chaos_herald' && !STATE.chaosMode) {
      triggerChaos(8000);
    }

    // Extra worth from golden/triple
    if (reward && reward.worth > 1) {
      STATE.globalClicks += reward.worth - 1;
      user.clicks += reward.worth - 1;
    }

    // Send ACK to clicker
    socket.emit('click_ack', {
      globalClicks: STATE.globalClicks,
      yourClicks: user.clicks,
      worth,
      reward,
      title: user.title,
    });

    // Broadcast global update
    io.emit('global_update', {
      globalClicks: STATE.globalClicks,
      activeUsers: STATE.connectedSockets.size,
    });

    // Check hints
    checkHints();

    // Check endgame
    if (!STATE.endgameReached && STATE.globalClicks >= STATE.milestone) {
      STATE.endgameReached = true;
      io.emit('endgame', {
        globalClicks: STATE.globalClicks,
        message: "THE SEQUENCE IS COMPLETE. THE VOID OPENS.",
      });
    }
  });

  socket.on('disconnect', () => {
    STATE.connectedSockets.delete(socket.id);
    io.emit('global_update', {
      globalClicks: STATE.globalClicks,
      activeUsers: STATE.connectedSockets.size,
    });
  });
});

// ── Static files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/status', (req, res) => {
  res.json({
    globalClicks: STATE.globalClicks,
    totalUsers: STATE.clickerCount,
    chaosMode: STATE.chaosMode,
    endgameReached: STATE.endgameReached,
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔴 Global Chaos Button server running on http://localhost:${PORT}`);
  scheduleChaos();
});

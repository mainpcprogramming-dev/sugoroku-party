const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Neon PostgreSQL 接続設定
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  pool.query(`
    CREATE TABLE IF NOT EXISTS match_history (
      id SERIAL PRIMARY KEY,
      room_id VARCHAR(10),
      winner_name VARCHAR(50),
      final_money INTEGER,
      played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `).catch(err => console.error('DB Init Error:', err));
}

// プレイヤー識別用カラーパレット
const PLAYER_COLORS = [
  '#e74c3c', // レッド
  '#3498db', // ブルー
  '#2ecc71', // グリーン
  '#f39c12', // オレンジ
  '#9b59b6', // パープル
  '#1abc9c', // ターコイズ
  '#e84393', // ピンク
  '#34495e'  // ネイビー
];

// 職業リスト（ランクアップ対応）
const JOBS = [
  { name: 'フリーター', rankUpName: '店長', salary: 2000, rankUpSalary: 4500 },
  { name: '会社員', rankUpName: '部長', salary: 4000, rankUpSalary: 7500 },
  { name: 'エンジニア', rankUpName: 'CTO', salary: 6000, rankUpSalary: 11000 },
  { name: '医者', rankUpName: '院長', salary: 9000, rankUpSalary: 16000 },
  { name: '社長', rankUpName: '大富豪会長', salary: 12000, rankUpSalary: 22000 },
  { name: 'YouTuber', rankUpName: 'トップクリエイター', salary: 5000, rankUpSalary: 10000 }
];

const PROPERTIES = [
  { id: 'p1', name: 'コンビニ経営権', price: 5000, sellValue: 8000 },
  { id: 'p2', name: '都心マンション', price: 12000, sellValue: 20000 },
  { id: 'p3', name: 'ITベンチャー株', price: 15000, sellValue: 30000 },
  { id: 'p4', name: '南の島の別荘', price: 25000, sellValue: 45000 },
  { id: 'p5', name: '宇宙旅行ツアー会社', price: 40000, sellValue: 75000 }
];

const QUIZZES = [
  { q: '日本の初代内閣総理大臣は？', options: ['伊藤博文', '黒田清隆', '山縣有朋'], ans: 0 },
  { q: '太陽系で一番大きい惑星は？', options: ['土星', '木星', '海王星'], ans: 1 },
  { q: '1000円札の肖像画（2024年〜）は誰？', options: ['野口英世', '渋沢栄一', '北里柴三郎'], ans: 2 },
  { q: 'ダイヤモンドの主成分の元素は？', options: ['炭素', 'ケイ素', '窒素'], ans: 0 },
  { q: '世界で一番面積が大きい国は？', options: ['カナダ', 'アメリカ', 'ロシア'], ans: 2 },
  { q: '富士山の標高は約何メートル？', options: ['3,776m', '3,556m', '3,996m'], ans: 0 },
  { q: '1オクターブは何音ある？', options: ['7音', '8音', '12音'], ans: 1 }
];

const rooms = {};
let autoMatchQueue = [];

// ランダム盤面生成（新マス追加版）
function generateBoard() {
  const board = [];
  const totalTiles = 48;

  for (let i = 0; i < totalTiles; i++) {
    if (i === 0) {
      board.push({ index: i, type: 'START', label: 'START', desc: '人生の始まり！' });
      continue;
    }
    if (i === totalTiles - 1) {
      board.push({ index: i, type: 'GOAL', label: 'GOAL!', desc: '人生のゴール！' });
      continue;
    }
    // 強制ストップマス（給料日・分岐・結婚）
    if (i === 9 || i === 24 || i === 38) {
      board.push({ index: i, type: 'PAYDAY', label: '給料日(STOP)', desc: '必ずストップ！お給料をもらう', stop: true });
      continue;
    }
    if (i === 14) {
      board.push({ index: i, type: 'MARRIAGE', label: '結婚(STOP)', desc: '人生の節目！ご祝儀をもらう', stop: true });
      continue;
    }
    if (i === 20) {
      board.push({ index: i, type: 'BRANCH', label: '人生の分岐(STOP)', desc: '堅実ルートか勝負ルートか選択！', stop: true });
      continue;
    }

    const multiplier = Math.floor(i / 8) + 1;
    const baseAmount = 1000 * multiplier;
    const rand = Math.random();

    if (rand < 0.16) {
      // なにもない通常マス
      board.push({ index: i, type: 'NORMAL', label: '通常マス', desc: '穏やかな一日。特に何も起きない。' });
    } else if (rand < 0.36) {
      const val = baseAmount * (Math.floor(Math.random() * 3) + 1);
      board.push({ index: i, type: 'PLUS', label: `+$${val}`, amount: val, desc: `臨時収入！$${val}ゲット` });
    } else if (rand < 0.54) {
      const val = baseAmount * (Math.floor(Math.random() * 2) + 1);
      board.push({ index: i, type: 'MINUS', label: `-$${val}`, amount: val, desc: `思わぬ出費…$${val}失う` });
    } else if (rand < 0.66) {
      const val = baseAmount * 3;
      board.push({ index: i, type: 'QUIZ', label: 'クイズ', amount: val, desc: `正解で+$${val} / 不正解で-$${Math.floor(val / 2)}` });
    } else if (rand < 0.78) {
      const winVal = baseAmount * 3;
      const loseVal = Math.floor(winVal / 2);
      board.push({ index: i, type: 'JANKEN', label: 'じゃんけん', winAmount: winVal, loseAmount: loseVal });
    } else if (rand < 0.86) {
      const val = baseAmount * 2;
      board.push({ index: i, type: 'BABY', label: '出産祝い', amount: val, desc: `赤ちゃん誕生！お祝い金+$${val}` });
    } else if (rand < 0.93) {
      board.push({ index: i, type: 'RANKUP', label: '職業昇進', desc: '仕事が評価され職業ランクアップ！' });
    } else {
      const prop = PROPERTIES[Math.min(PROPERTIES.length - 1, Math.floor(i / 10))];
      board.push({ index: i, type: 'PROPERTY', label: '物件購入', property: prop });
    }
  }
  return board;
}

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

function sendSystemChat(roomId, text) {
  io.to(roomId).emit('chatMessage', { sender: 'SYSTEM', text, isSystem: true });
}

function createRoomState(roomId, isAutoMatch = false) {
  return {
    id: roomId,
    isAutoMatch,
    status: 'LOBBY', // LOBBY, COUNTDOWN, JOB_ROULETTE, PLAYING, FINISHED
    timeLimit: 30,
    players: [],
    board: [],
    turnIndex: 0,
    goalOrder: [],
    turnTimer: null,
    timeLeft: 30,
    rematchVotes: {}
  };
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const sanitizedPlayers = room.players.map(p => ({
    ...p,
    displayMoney: (room.status === 'PLAYING' && p.finished) ? '???' : `$${p.money.toLocaleString()}`
  }));

  io.to(roomId).emit('roomStateUpdate', {
    id: room.id,
    isAutoMatch: room.isAutoMatch,
    status: room.status,
    timeLimit: room.timeLimit,
    players: sanitizedPlayers,
    board: room.board,
    turnIndex: room.turnIndex,
    timeLeft: room.timeLeft
  });
}

// 結果バナーを全員に2.2秒表示してから次の処理へ進むヘルパー
function showResultBannerAndProceed(roomId, bannerData, nextCallback) {
  io.to(roomId).emit('showResultBanner', bannerData);
  setTimeout(() => {
    io.to(roomId).emit('hideResultBanner');
    if (nextCallback) nextCallback();
  }, 2200);
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'PLAYING') return;
  clearInterval(room.turnTimer);

  room.timeLeft = room.timeLimit;
  io.to(roomId).emit('timerUpdate', room.timeLeft);

  room.turnTimer = setInterval(() => {
    room.timeLeft--;
    io.to(roomId).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.turnTimer);
      const currentPlayer = room.players[room.turnIndex];
      if (currentPlayer && !currentPlayer.isSpinning) {
        sendSystemChat(roomId, `時間切れ！${currentPlayer.name}さんのルーレットが自動で回ります。`);
        executeSpin(roomId, currentPlayer.id);
      }
    }
  }, 1000);
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'PLAYING') return;

  // 全員ゴールしたら終了
  if (room.players.every(p => p.finished)) {
    finishGame(roomId);
    return;
  }

  // ゴール済みのプレイヤーにもターンを回す（出た目×$100ボーナス）
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  broadcastRoomState(roomId);
  startTurnTimer(roomId);
}

function executeSpin(roomId, playerId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'PLAYING') return;
  const player = room.players[room.turnIndex];
  if (!player || player.id !== playerId || player.isSpinning) return;

  clearInterval(room.turnTimer);
  player.isSpinning = true;

  const result = Math.floor(Math.random() * 6) + 1;
  io.to(roomId).emit('rouletteStart', { playerId: player.id, targetNumber: result });

  setTimeout(() => {
    if (!rooms[roomId]) return;

    // すでにゴールしているプレイヤーのボーナスターン処理
    if (player.finished) {
      const bonus = result * 100;
      player.money += bonus;
      player.isSpinning = false;
      sendSystemChat(roomId, `🌟 ゴール済みボーナス！${player.name}さんは「${result}」を出し、$${bonus.toLocaleString()}獲得しました！`);
      broadcastRoomState(roomId);
      setTimeout(() => nextTurn(roomId), 1200);
      return;
    }

    sendSystemChat(roomId, `${player.name}さんが「${result}」を出しました。`);
    movePlayerStepByStep(roomId, player, result);
  }, 2400);
}

function movePlayerStepByStep(roomId, player, stepsRemaining) {
  const room = rooms[roomId];
  if (!room) return;

  if (stepsRemaining <= 0 || player.position >= room.board.length - 1) {
    player.isSpinning = false;
    handleTileLanding(roomId, player);
    return;
  }

  player.position++;
  broadcastRoomState(roomId);

  const currentTile = room.board[player.position];

  if (currentTile.type === 'GOAL') {
    player.isSpinning = false;
    handleGoal(roomId, player);
    return;
  }

  // 強制ストップ判定
  if (currentTile.stop && stepsRemaining > 1) {
    sendSystemChat(roomId, `${player.name}さんは「${currentTile.label}」で強制ストップ！`);
    player.isSpinning = false;
    handleTileLanding(roomId, player);
    return;
  }

  setTimeout(() => {
    movePlayerStepByStep(roomId, player, stepsRemaining - 1);
  }, 320);
}

function handleGoal(roomId, player) {
  const room = rooms[roomId];
  player.finished = true;
  room.goalOrder.push(player.id);
  const rank = room.goalOrder.length;

  let bonus = 3000;
  if (rank === 1) bonus = 20000;
  else if (rank === 2) bonus = 12000;
  else if (rank === 3) bonus = 6000;

  player.money += bonus;
  sendSystemChat(roomId, `🎉 ${player.name}さんが${rank}位でゴール！ボーナス$${bonus.toLocaleString()}を獲得！（所持金は結果発表まで？？？になります）`);
  broadcastRoomState(roomId);
  setTimeout(() => nextTurn(roomId), 1500);
}

function handleTileLanding(roomId, player) {
  const room = rooms[roomId];
  const tile = room.board[player.position];
  broadcastRoomState(roomId);

  if (tile.type === 'NORMAL') {
    sendSystemChat(roomId, `${player.name}さんは通常マスに止まりました。何も起きませんでした。`);
    setTimeout(() => nextTurn(roomId), 1000);

  } else if (tile.type === 'PLUS') {
    player.money += tile.amount;
    sendSystemChat(roomId, `${player.name}さんが$${tile.amount.toLocaleString()}獲得しました！`);
    broadcastRoomState(roomId);
    setTimeout(() => nextTurn(roomId), 1200);

  } else if (tile.type === 'MINUS') {
    player.money = Math.max(0, player.money - tile.amount);
    sendSystemChat(roomId, `${player.name}さんが$${tile.amount.toLocaleString()}失いました…。`);
    broadcastRoomState(roomId);
    setTimeout(() => nextTurn(roomId), 1200);

  } else if (tile.type === 'PAYDAY') {
    const pay = player.job.currentSalary;
    player.money += pay;
    sendSystemChat(roomId, `💰 給料日！${player.name}さん（${player.job.currentName}）は給料$${pay.toLocaleString()}を獲得しました！`);
    broadcastRoomState(roomId);
    setTimeout(() => nextTurn(roomId), 1400);

  } else if (tile.type === 'MARRIAGE') {
    const gift = player.married ? 3000 : 10000;
    const msg = player.married ? '結婚記念日のお祝い！' : 'ご結婚おめでとうございます！';
    player.married = true;
    player.money += gift;
    sendSystemChat(roomId, `💒 ${msg}${player.name}さんがご祝儀$${gift.toLocaleString()}を獲得！`);
    broadcastRoomState(roomId);
    showResultBannerAndProceed(roomId, {
      title: '💒 HAPPY WEDDING!',
      subtitle: `${player.name}さんが結婚！+$${gift.toLocaleString()}`,
      theme: 'win'
    }, () => nextTurn(roomId));

  } else if (tile.type === 'BABY') {
    player.childrenCount++;
    player.money += tile.amount;
    sendSystemChat(roomId, `👶 赤ちゃん誕生（現在${player.childrenCount}人）！${player.name}さんがお祝い金$${tile.amount.toLocaleString()}を獲得！`);
    broadcastRoomState(roomId);
    showResultBannerAndProceed(roomId, {
      title: '👶 赤ちゃん誕生！',
      subtitle: `${player.name}さんにお祝い金 +$${tile.amount.toLocaleString()}！`,
      theme: 'win'
    }, () => nextTurn(roomId));

  } else if (tile.type === 'RANKUP') {
    if (!player.job.isRankedUp) {
      player.job.isRankedUp = true;
      player.job.currentName = player.job.rankUpName;
      player.job.currentSalary = player.job.rankUpSalary;
      sendSystemChat(roomId, `🎊 昇進！${player.name}さんが「${player.job.currentName}」にランクアップ！給料が$${player.job.currentSalary.toLocaleString()}にUP！`);
      broadcastRoomState(roomId);
      showResultBannerAndProceed(roomId, {
        title: '🎊 職業ランクアップ！',
        subtitle: `${player.name}さんが「${player.job.currentName}」に昇進！`,
        theme: 'win'
      }, () => nextTurn(roomId));
    } else {
      player.money += 5000;
      sendSystemChat(roomId, `✨ すでに最高ランクの${player.name}さんに特別ボーナス$5,000支給！`);
      broadcastRoomState(roomId);
      setTimeout(() => nextTurn(roomId), 1200);
    }

  } else if (tile.type === 'BRANCH') {
    io.to(roomId).emit('interactiveEvent', {
      type: 'BRANCH',
      playerId: player.id,
      playerName: player.name,
      title: '人生の分岐点！どちらの道に進む？',
      desc: '堅実コース（確実に+$5,000）か、ギャンブルコース（50%で+$20,000 / 50%で-$8,000）'
    });

  } else if (tile.type === 'QUIZ') {
    const quiz = QUIZZES[Math.floor(Math.random() * QUIZZES.length)];
    player.pendingEvent = { type: 'QUIZ', quiz, amount: tile.amount };
    io.to(roomId).emit('interactiveEvent', {
      type: 'QUIZ',
      playerId: player.id,
      playerName: player.name,
      question: quiz.q,
      options: quiz.options,
      amount: tile.amount
    });

  } else if (tile.type === 'JANKEN') {
    player.pendingEvent = { type: 'JANKEN', winAmount: tile.winAmount, loseAmount: tile.loseAmount };
    io.to(roomId).emit('interactiveEvent', {
      type: 'JANKEN',
      playerId: player.id,
      playerName: player.name,
      winAmount: tile.winAmount,
      loseAmount: tile.loseAmount
    });

  } else if (tile.type === 'PROPERTY') {
    player.pendingEvent = { type: 'PROPERTY', property: tile.property };
    io.to(roomId).emit('interactiveEvent', {
      type: 'PROPERTY',
      playerId: player.id,
      playerName: player.name,
      property: tile.property,
      canAfford: player.money >= tile.property.price
    });

  } else {
    setTimeout(() => nextTurn(roomId), 1000);
  }
}

async function finishGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.status = 'FINISHED';
  clearInterval(room.turnTimer);

  const results = room.players.map(p => {
    const propertyTotal = p.properties.reduce((sum, prop) => sum + prop.sellValue, 0);
    const familyBonus = (p.married ? 5000 : 0) + (p.childrenCount * 4000);
    const totalAssets = p.money + propertyTotal + familyBonus;
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      job: p.job.currentName,
      cash: p.money,
      propertyCount: p.properties.length,
      propertyValue: propertyTotal,
      familyBonus,
      totalAssets
    };
  });

  results.sort((a, b) => b.totalAssets - a.totalAssets);

  if (pool && results.length > 0) {
    try {
      await pool.query(
        'INSERT INTO match_history (room_id, winner_name, final_money) VALUES ($1, $2, $3)',
        [roomId, results[0].name, results[0].totalAssets]
      );
    } catch (e) {
      console.error('Failed to save match history:', e);
    }
  }

  io.to(roomId).emit('gameFinished', {
    results,
    isAutoMatch: room.isAutoMatch
  });
}

// Socket.io イベントハンドラ
io.on('connection', (socket) => {
  socket.on('createRoom', ({ playerName }) => {
    const roomId = generateRoomCode();
    const room = createRoomState(roomId, false);
    rooms[roomId] = room;

    const player = createPlayerObj(socket.id, playerName || 'ゲスト', true, 0);
    room.players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('joinedRoom', { roomId, playerId: socket.id });
    broadcastRoomState(roomId);
  });

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', '指定された部屋番号が見つかりません。');
    if (room.status !== 'LOBBY') return socket.emit('errorMsg', 'この部屋はすでにゲームが開始されています。');

    const player = createPlayerObj(socket.id, playerName || 'ゲスト', false, room.players.length);
    room.players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('joinedRoom', { roomId, playerId: socket.id });
    sendSystemChat(roomId, `${player.name}さんが入室しました。`);
    broadcastRoomState(roomId);
  });

  socket.on('joinAutoMatch', ({ playerName }) => {
    autoMatchQueue = autoMatchQueue.filter(item => item.socket.id !== socket.id);
    autoMatchQueue.push({ socket, playerName: playerName || 'プレイヤー' });
    autoMatchQueue.forEach(m => m.socket.emit('matchingStatus', { count: autoMatchQueue.length }));

    if (autoMatchQueue.length >= 4) {
      const matched = autoMatchQueue.splice(0, 4);
      const roomId = generateRoomCode();
      const room = createRoomState(roomId, true);
      rooms[roomId] = room;

      matched.forEach((m, idx) => {
        const player = createPlayerObj(m.socket.id, m.playerName, idx === 0, idx);
        player.ready = true;
        room.players.push(player);
        m.socket.join(roomId);
        m.socket.roomId = roomId;
        m.socket.emit('joinedRoom', { roomId, playerId: m.socket.id });
      });

      startGameSequence(roomId);
    }
  });

  socket.on('cancelAutoMatch', () => {
    autoMatchQueue = autoMatchQueue.filter(item => item.socket.id !== socket.id);
    autoMatchQueue.forEach(m => m.socket.emit('matchingStatus', { count: autoMatchQueue.length }));
  });

  socket.on('toggleReady', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = !player.ready;
      broadcastRoomState(room.id);
    }
  });

  socket.on('changeTimeLimit', (newLimit) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && player.isHost && newLimit >= 10 && newLimit <= 90) {
      room.timeLimit = newLimit;
      broadcastRoomState(room.id);
    }
  });

  socket.on('shufflePlayers', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && player.isHost) {
      for (let i = room.players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
      }
      sendSystemChat(room.id, 'ホストがプレイヤーの順番をシャッフルしました！');
      broadcastRoomState(room.id);
    }
  });

  socket.on('startGame', ({ force }) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;

    if (!force && !room.players.every(p => p.ready)) {
      return socket.emit('errorMsg', '全員が「準備OK」になるまでスタートできません。');
    }
    startGameSequence(room.id);
  });

  function startGameSequence(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.status = 'COUNTDOWN';
    room.board = generateBoard();
    room.turnIndex = 0;
    room.goalOrder = [];
    room.rematchVotes = {};

    room.players.forEach((p, idx) => {
      p.color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
      p.job = { currentName: '未定', currentSalary: 0, isRankedUp: false };
      p.jobDecided = false;
      p.money = 5000;
      p.position = 0;
      p.properties = [];
      p.married = false;
      p.childrenCount = 0;
      p.finished = false;
      p.isSpinning = false;
    });

    broadcastRoomState(roomId);
    io.to(roomId).emit('startCountdown', 3);

    // カウントダウン終了後、職業ルーレットフェーズへ移行
    setTimeout(() => {
      if (!rooms[roomId]) return;
      room.status = 'JOB_ROULETTE';
      broadcastRoomState(roomId);
      io.to(roomId).emit('startJobRoulettePhase', JOBS.map(j => j.name));
    }, 3200);
  }

  // 各自が職業ルーレットをストップした時の処理
  socket.on('stopJobRoulette', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'JOB_ROULETTE') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.jobDecided) return;

    const chosen = JOBS[Math.floor(Math.random() * JOBS.length)];
    player.job = {
      currentName: chosen.name,
      rankUpName: chosen.rankUpName,
      currentSalary: chosen.salary,
      rankUpSalary: chosen.rankUpSalary,
      isRankedUp: false
    };
    player.jobDecided = true;

    io.to(room.id).emit('playerJobDecided', {
      playerId: player.id,
      playerName: player.name,
      jobName: chosen.name,
      salary: chosen.salary
    });

    // 全員の職業が決まったらゲーム開始！
    if (room.players.every(p => p.jobDecided)) {
      setTimeout(() => {
        if (!rooms[room.id]) return;
        room.status = 'PLAYING';
        io.to(room.id).emit('allJobsDecided');
        sendSystemChat(room.id, `🎮 全員の職業が決定！最初は${room.players[0].name}さんのターンです！`);
        broadcastRoomState(room.id);
        startTurnTimer(room.id);
      }, 1800);
    }
  });

  socket.on('spinRoulette', () => {
    if (socket.roomId) {
      executeSpin(socket.roomId, socket.id);
    }
  });

  socket.on('submitEventChoice', (choice) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id) return;

    const tile = room.board[player.position];
    io.to(room.id).emit('closeInteractiveEvent');

    if (tile.type === 'BRANCH') {
      if (choice === 'SAFE') {
        player.money += 5000;
        sendSystemChat(room.id, `${player.name}さんは堅実ルートを選び、確実に$5,000獲得しました！`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '🛡️ 堅実ルート成功！',
          subtitle: `${player.name}さんが確実に +$5,000 獲得！`,
          theme: 'win'
        }, () => nextTurn(room.id));
      } else {
        if (Math.random() < 0.5) {
          player.money += 20000;
          sendSystemChat(room.id, `🎊 大成功！${player.name}さんは勝負ルートで$20,000獲得しました！`);
          broadcastRoomState(room.id);
          showResultBannerAndProceed(room.id, {
            title: '🎊 ギャンブル大勝利！！',
            subtitle: `${player.name}さんが +$20,000 獲得！`,
            theme: 'win'
          }, () => nextTurn(room.id));
        } else {
          player.money = Math.max(0, player.money - 8000);
          sendSystemChat(room.id, `😱 失敗…${player.name}さんは勝負ルートで$8,000失いました。`);
          broadcastRoomState(room.id);
          showResultBannerAndProceed(room.id, {
            title: '😱 勝負ルート敗北…',
            subtitle: `${player.name}さんが -$8,000 失いました…`,
            theme: 'lose'
          }, () => nextTurn(room.id));
        }
      }
    } else if (tile.type === 'QUIZ' && player.pendingEvent) {
      const { quiz, amount } = player.pendingEvent;
      if (choice === quiz.ans) {
        player.money += amount;
        sendSystemChat(room.id, `⭕ クイズ正解！${player.name}さんが$${amount.toLocaleString()}獲得しました！`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '⭕ クイズ大正解！',
          subtitle: `${player.name}さんが +$${amount.toLocaleString()} 獲得！`,
          theme: 'win'
        }, () => nextTurn(room.id));
      } else {
        const loss = Math.floor(amount / 2);
        player.money = Math.max(0, player.money - loss);
        sendSystemChat(room.id, `❌ クイズ不正解…${player.name}さんが$${loss.toLocaleString()}失いました。`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '❌ クイズ不正解…',
          subtitle: `正解は「${quiz.options[quiz.ans]}」でした (-$${loss.toLocaleString()})`,
          theme: 'lose'
        }, () => nextTurn(room.id));
      }
    } else if (tile.type === 'JANKEN' && player.pendingEvent) {
      if (choice === 'DECLINE') {
        sendSystemChat(room.id, `${player.name}さんはじゃんけん勝負を見送りました。`);
        player.pendingEvent = null;
        return setTimeout(() => nextTurn(room.id), 800);
      }

      const hands = ['グー✊', 'チョキ✌️', 'パー✋'];
      const cpuHand = Math.floor(Math.random() * 3);
      const { winAmount, loseAmount } = player.pendingEvent;

      if (choice === cpuHand) {
        sendSystemChat(room.id, `✊✌️✋ じゃんけんあいこ！（CPU:${hands[cpuHand]}）お金の変動なし！`);
        showResultBannerAndProceed(room.id, {
          title: '🤝 あいこ！',
          subtitle: `お互い ${hands[cpuHand]}！お金の変動なし`,
          theme: 'draw'
        }, () => nextTurn(room.id));
      } else if ((choice === 0 && cpuHand === 1) || (choice === 1 && cpuHand === 2) || (choice === 2 && cpuHand === 0)) {
        player.money += winAmount;
        sendSystemChat(room.id, `🎉 じゃんけん勝利！（CPU:${hands[cpuHand]}）${player.name}さんが$${winAmount.toLocaleString()}獲得しました！`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '🎉 じゃんけん勝利！',
          subtitle: `CPU(${hands[cpuHand]})に勝利！+$${winAmount.toLocaleString()}`,
          theme: 'win'
        }, () => nextTurn(room.id));
      } else {
        player.money = Math.max(0, player.money - loseAmount);
        sendSystemChat(room.id, `😭 じゃんけん敗北…（CPU:${hands[cpuHand]}）${player.name}さんが$${loseAmount.toLocaleString()}失いました。`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '😭 じゃんけん敗北…',
          subtitle: `CPU(${hands[cpuHand]})に敗北… -$${loseAmount.toLocaleString()}`,
          theme: 'lose'
        }, () => nextTurn(room.id));
      }
    } else if (tile.type === 'PROPERTY' && player.pendingEvent) {
      const prop = player.pendingEvent.property;
      if (choice === 'BUY' && player.money >= prop.price) {
        player.money -= prop.price;
        player.properties.push(prop);
        sendSystemChat(room.id, `🏢 ${player.name}さんが「${prop.name}」を$${prop.price.toLocaleString()}で購入しました！`);
      } else {
        sendSystemChat(room.id, `${player.name}さんは物件を購入しませんでした。`);
      }
      broadcastRoomState(room.id);
      setTimeout(() => nextTurn(room.id), 1000);
    }

    player.pendingEvent = null;
  });

  socket.on('sendChat', (text) => {
    const room = rooms[socket.roomId];
    if (!room || !text.trim()) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      io.to(room.id).emit('chatMessage', {
        sender: player.name,
        color: player.color,
        text: text.trim(),
        isSystem: false
      });
    }
  });

  socket.on('returnToRoomSettings', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.status = 'LOBBY';
    room.players.forEach(p => { p.ready = false; });
    broadcastRoomState(room.id);
  });

  socket.on('voteRematch', (wantsRematch) => {
    const room = rooms[socket.roomId];
    if (!room || !room.isAutoMatch) return;

    if (!wantsRematch) {
      io.to(room.id).emit('forceReturnLobby', '対戦相手が再戦をキャンセルしたためロビーに戻ります。');
      delete rooms[room.id];
      return;
    }

    room.rematchVotes[socket.id] = true;
    const voteCount = Object.keys(room.rematchVotes).length;
    io.to(room.id).emit('rematchStatus', `${voteCount} / ${room.players.length} 人が再戦を希望しています...`);

    if (voteCount >= room.players.length) {
      startGameSequence(room.id);
    }
  });

  socket.on('leaveRoom', () => handleDisconnect(socket));
  socket.on('disconnect', () => handleDisconnect(socket));

  function createPlayerObj(id, name, isHost, idx) {
    return {
      id,
      name,
      color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
      isHost,
      ready: false,
      job: { currentName: '未定', currentSalary: 0, isRankedUp: false },
      jobDecided: false,
      money: 5000,
      position: 0,
      properties: [],
      married: false,
      childrenCount: 0,
      finished: false,
      isSpinning: false
    };
  }

  function handleDisconnect(sock) {
    autoMatchQueue = autoMatchQueue.filter(item => item.socket.id !== sock.id);
    const roomId = sock.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const idx = room.players.findIndex(p => p.id === sock.id);
    if (idx !== -1) {
      const leftPlayer = room.players[idx];
      room.players.splice(idx, 1);
      sock.leave(roomId);
      sock.roomId = null;

      if (room.players.length === 0) {
        clearInterval(room.turnTimer);
        delete rooms[roomId];
      } else {
        if (leftPlayer.isHost) room.players[0].isHost = true;
        sendSystemChat(roomId, `${leftPlayer.name}さんが退出しました。`);
        if (room.status === 'PLAYING') {
          if (room.turnIndex >= room.players.length) room.turnIndex = 0;
          nextTurn(roomId);
        } else {
          broadcastRoomState(roomId);
        }
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
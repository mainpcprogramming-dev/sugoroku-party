const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Neon PostgreSQL 接続設定（環境変数 DATABASE_URL が設定されている場合のみ有効化）
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

// ゲームデータ定義
const JOBS = [
  { name: 'フリーター', salary: 2000 },
  { name: '会社員', salary: 4000 },
  { name: 'エンジニア', salary: 6000 },
  { name: '医者', salary: 9000 },
  { name: '社長', salary: 12000 },
  { name: 'YouTuber', salary: 5000 }
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
  { q: '世界で一番面積が大きい国は？', options: ['カナダ', 'アメリカ', 'ロシア'], ans: 2 }
];

// ルーム・マッチング管理
const rooms = {};
let autoMatchQueue = [];

// ランダム盤面生成（全45マス：序盤は少額、終盤はダイナミック）
function generateBoard() {
  const board = [];
  const totalTiles = 45;

  for (let i = 0; i < totalTiles; i++) {
    if (i === 0) {
      board.push({ index: i, type: 'START', label: 'START', desc: '人生の始まり！' });
      continue;
    }
    if (i === totalTiles - 1) {
      board.push({ index: i, type: 'GOAL', label: 'GOAL!', desc: '人生のゴール！' });
      continue;
    }
    // 強制ストップ（給料日・分岐・イベント）
    if (i === 10 || i === 22 || i === 34) {
      board.push({ index: i, type: 'PAYDAY', label: '給料日(STOP)', desc: '必ずストップ！お給料をもらう', stop: true });
      continue;
    }
    if (i === 15) {
      board.push({ index: i, type: 'BRANCH', label: '人生の分岐(STOP)', desc: '堅実ルートか勝負ルートか選択！', stop: true });
      continue;
    }

    // 進行度に応じた金額倍率（序盤:1倍 〜 終盤:6倍）
    const multiplier = Math.floor(i / 8) + 1;
    const baseAmount = 1000 * multiplier;

    const rand = Math.random();
    if (rand < 0.30) {
      const val = baseAmount * (Math.floor(Math.random() * 3) + 1);
      board.push({ index: i, type: 'PLUS', label: `+$${val}`, amount: val, desc: `臨時収入！$${val}ゲット` });
    } else if (rand < 0.55) {
      const val = baseAmount * (Math.floor(Math.random() * 2) + 1);
      board.push({ index: i, type: 'MINUS', label: `-$${val}`, amount: val, desc: `思わぬ出費…$${val}失う` });
    } else if (rand < 0.72) {
      const val = baseAmount * 3;
      board.push({ index: i, type: 'QUIZ', label: 'クイズ', amount: val, desc: `正解で+$${val} / 不正解で-$${Math.floor(val/2)}` });
    } else if (rand < 0.88) {
      const val = baseAmount * 3;
      board.push({ index: i, type: 'JANKEN', label: 'じゃんけん', amount: val, desc: `CPUに勝てば+$${val} / 負けたら-$${Math.floor(val/2)}` });
    } else {
      const prop = PROPERTIES[Math.min(PROPERTIES.length - 1, Math.floor(i / 9))];
      board.push({ index: i, type: 'PROPERTY', label: '物件購入', property: prop, desc: `${prop.name}($${prop.price})を購入できる` });
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
    status: 'LOBBY', // LOBBY, COUNTDOWN, PLAYING, FINISHED
    timeLimit: 30,   // 10〜90秒
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
  // ゴール済みプレイヤーの所持金をマスクしたデータを送信
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

  // 全員ゴールしたか確認
  if (room.players.every(p => p.finished)) {
    finishGame(roomId);
    return;
  }

  // 次の未ゴールプレイヤーを探す
  let nextIdx = (room.turnIndex + 1) % room.players.length;
  while (room.players[nextIdx].finished) {
    nextIdx = (nextIdx + 1) % room.players.length;
  }
  room.turnIndex = nextIdx;
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
  // 全員にルーレット回転開始と出目を通知（クライアント側で高速ルーレット演出）
  io.to(roomId).emit('rouletteStart', { playerId: player.id, targetNumber: result });

  // ルーレット演出（2.5秒）後に移動処理
  setTimeout(() => {
    if (!rooms[roomId]) return;
    sendSystemChat(roomId, `${player.name}さんが「${result}」を出しました。`);
    movePlayerStepByStep(roomId, player, result);
  }, 2500);
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

  // ゴール到達
  if (currentTile.type === 'GOAL') {
    player.isSpinning = false;
    handleGoal(roomId, player);
    return;
  }

  // 強制ストップマス判定（残り歩数があっても止まる）
  if (currentTile.stop && stepsRemaining > 1) {
    sendSystemChat(roomId, `${player.name}さんは「${currentTile.label}」で強制ストップ！`);
    player.isSpinning = false;
    handleTileLanding(roomId, player);
    return;
  }

  setTimeout(() => {
    movePlayerStepByStep(roomId, player, stepsRemaining - 1);
  }, 350);
}

function handleGoal(roomId, player) {
  const room = rooms[roomId];
  player.finished = true;
  room.goalOrder.push(player.id);
  const rank = room.goalOrder.length;

  // ゴール順位ボーナス（1位:20000, 2位:12000, 3位:6000, 4位以下:3000）
  let bonus = 3000;
  if (rank === 1) bonus = 20000;
  else if (rank === 2) bonus = 12000;
  else if (rank === 3) bonus = 6000;

  player.money += bonus;
  sendSystemChat(roomId, `🎉 ${player.name}さんが${rank}位でゴール！ボーナス$${bonus.toLocaleString()}を獲得！（所持金は結果発表までヒミツになります）`);
  broadcastRoomState(roomId);
  setTimeout(() => nextTurn(roomId), 1500);
}

function handleTileLanding(roomId, player) {
  const room = rooms[roomId];
  const tile = room.board[player.position];
  broadcastRoomState(roomId);

  if (tile.type === 'PLUS') {
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
    const pay = player.job.salary;
    player.money += pay;
    sendSystemChat(roomId, `💰 給料日！${player.name}さん（${player.job.name}）は給料$${pay.toLocaleString()}を獲得しました！`);
    broadcastRoomState(roomId);
    setTimeout(() => nextTurn(roomId), 1500);

  } else if (tile.type === 'BRANCH') {
    // 分岐選択イベントを全員の画面に同期表示
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
    player.pendingEvent = { type: 'JANKEN', amount: tile.amount };
    io.to(roomId).emit('interactiveEvent', {
      type: 'JANKEN',
      playerId: player.id,
      playerName: player.name,
      amount: tile.amount
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

  // 総決算（物件の売却処理）
  const results = room.players.map(p => {
    const propertyTotal = p.properties.reduce((sum, prop) => sum + prop.sellValue, 0);
    const totalAssets = p.money + propertyTotal;
    return {
      id: p.id,
      name: p.name,
      job: p.job.name,
      cash: p.money,
      propertyCount: p.properties.length,
      propertyValue: propertyTotal,
      totalAssets
    };
  });

  // 総資産順にソート
  results.sort((a, b) => b.totalAssets - a.totalAssets);

  // Neon DBへ結果保存
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
  // 部屋作成（Partyモード：人数無制限）
  socket.on('createRoom', ({ playerName }) => {
    const roomId = generateRoomCode();
    const room = createRoomState(roomId, false);
    rooms[roomId] = room;

    const player = {
      id: socket.id,
      name: playerName || 'ゲスト',
      isHost: true,
      ready: false,
      job: JOBS[Math.floor(Math.random() * JOBS.length)],
      money: 5000,
      position: 0,
      properties: [],
      finished: false,
      isSpinning: false
    };
    room.players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('joinedRoom', { roomId, playerId: socket.id });
    broadcastRoomState(roomId);
  });

  // 部屋番号入力で参加
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      return socket.emit('errorMsg', '指定された部屋番号が見つかりません。');
    }
    if (room.status !== 'LOBBY') {
      return socket.emit('errorMsg', 'この部屋はすでにゲームが開始されています。');
    }

    const player = {
      id: socket.id,
      name: playerName || 'ゲスト',
      isHost: false,
      ready: false,
      job: JOBS[Math.floor(Math.random() * JOBS.length)],
      money: 5000,
      position: 0,
      properties: [],
      finished: false,
      isSpinning: false
    };
    room.players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('joinedRoom', { roomId, playerId: socket.id });
    sendSystemChat(roomId, `${player.name}さんが入室しました。`);
    broadcastRoomState(roomId);
  });

  // オンライン自動マッチング（4人固定）
  socket.on('joinAutoMatch', ({ playerName }) => {
    // すでに待機中なら重複防止
    autoMatchQueue = autoMatchQueue.filter(item => item.socket.id !== socket.id);
    autoMatchQueue.push({ socket, playerName: playerName || 'プレイヤー' });

    socket.emit('matchingStatus', { count: autoMatchQueue.length });

    // 4人揃ったら自動で部屋を作成して即カウントダウン開始
    if (autoMatchQueue.length >= 4) {
      const matched = autoMatchQueue.splice(0, 4);
      const roomId = generateRoomCode();
      const room = createRoomState(roomId, true);
      rooms[roomId] = room;

      matched.forEach((m, idx) => {
        const player = {
          id: m.socket.id,
          name: m.playerName,
          isHost: idx === 0,
          ready: true,
          job: JOBS[Math.floor(Math.random() * JOBS.length)],
          money: 5000,
          position: 0,
          properties: [],
          finished: false,
          isSpinning: false
        };
        room.players.push(player);
        m.socket.join(roomId);
        m.socket.roomId = roomId;
        m.socket.emit('joinedRoom', { roomId, playerId: m.socket.id });
      });

      startGameSequence(roomId);
    } else {
      // キュー内の全員に現在の待機人数を通知
      autoMatchQueue.forEach(m => m.socket.emit('matchingStatus', { count: autoMatchQueue.length }));
    }
  });

  socket.on('cancelAutoMatch', () => {
    autoMatchQueue = autoMatchQueue.filter(item => item.socket.id !== socket.id);
    autoMatchQueue.forEach(m => m.socket.emit('matchingStatus', { count: autoMatchQueue.length }));
  });

  // 準備OKトグル
  socket.on('toggleReady', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = !player.ready;
      broadcastRoomState(room.id);
    }
  });

  // 制限時間変更（10〜90秒、10秒刻み）
  socket.on('changeTimeLimit', (newLimit) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && player.isHost && newLimit >= 10 && newLimit <= 90) {
      room.timeLimit = newLimit;
      broadcastRoomState(room.id);
    }
  });

  // 順番シャッフル
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

  // ゲーム開始（通常スタート / 強制スタート）
  socket.on('startGame', ({ force }) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;

    if (!force && !room.players.every(p => p.ready)) {
      return socket.emit('errorMsg', '全員が「準備OK」になるまでスタートできません（強制スタートは可能です）。');
    }
    startGameSequence(room.id);
  });

  function startGameSequence(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.status = 'COUNTDOWN';
    room.board = generateBoard(); // ラウンドごとにランダム盤面生成
    room.turnIndex = 0;
    room.goalOrder = [];
    room.rematchVotes = {};

    // プレイヤー状態初期化
    room.players.forEach(p => {
      p.job = JOBS[Math.floor(Math.random() * JOBS.length)];
      p.money = 5000;
      p.position = 0;
      p.properties = [];
      p.finished = false;
      p.isSpinning = false;
    });

    broadcastRoomState(roomId);
    io.to(roomId).emit('startCountdown', 3);

    setTimeout(() => {
      if (!rooms[roomId]) return;
      room.status = 'PLAYING';
      sendSystemChat(roomId, '🎮 ゲームスタート！最初は' + room.players[0].name + 'さんのターンです！');
      broadcastRoomState(roomId);
      startTurnTimer(roomId);
    }, 3200);
  }

  // ルーレットストップ（プレイヤー操作）
  socket.on('spinRoulette', () => {
    if (socket.roomId) {
      executeSpin(socket.roomId, socket.id);
    }
  });

  // インタラクティブマス（クイズ・じゃんけん・分岐・物件）の回答処理
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
      } else {
        if (Math.random() < 0.5) {
          player.money += 20000;
          sendSystemChat(room.id, `🎊 大成功！${player.name}さんは勝負ルートで$20,000獲得しました！`);
        } else {
          player.money = Math.max(0, player.money - 8000);
          sendSystemChat(room.id, `😱 失敗…${player.name}さんは勝負ルートで$8,000失いました。`);
        }
      }
    } else if (tile.type === 'QUIZ' && player.pendingEvent) {
      const { quiz, amount } = player.pendingEvent;
      if (choice === quiz.ans) {
        player.money += amount;
        sendSystemChat(room.id, `⭕ クイズ正解！${player.name}さんが$${amount.toLocaleString()}獲得しました！`);
      } else {
        const loss = Math.floor(amount / 2);
        player.money = Math.max(0, player.money - loss);
        sendSystemChat(room.id, `❌ クイズ不正解…${player.name}さんが$${loss.toLocaleString()}失いました。`);
      }
    } else if (tile.type === 'JANKEN' && player.pendingEvent) {
      const hands = ['グー', 'チョキ', 'パー'];
      const cpuHand = Math.floor(Math.random() * 3);
      const amount = player.pendingEvent.amount;
      // 0:グー, 1:チョキ, 2:パー
      if (choice === cpuHand) {
        sendSystemChat(room.id, `✊✌️✋ じゃんけんあいこ！（CPU:${hands[cpuHand]}）お金の変動なし！`);
      } else if ((choice === 0 && cpuHand === 1) || (choice === 1 && cpuHand === 2) || (choice === 2 && cpuHand === 0)) {
        player.money += amount;
        sendSystemChat(room.id, `🎉 じゃんけん勝利！（CPU:${hands[cpuHand]}）${player.name}さんが$${amount.toLocaleString()}獲得しました！`);
      } else {
        const loss = Math.floor(amount / 2);
        player.money = Math.max(0, player.money - loss);
        sendSystemChat(room.id, `😭 じゃんけん敗北…（CPU:${hands[cpuHand]}）${player.name}さんが$${loss.toLocaleString()}失いました。`);
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
    }

    player.pendingEvent = null;
    broadcastRoomState(room.id);
    setTimeout(() => nextTurn(room.id), 1200);
  });

  // チャット送信
  socket.on('sendChat', (text) => {
    const room = rooms[socket.roomId];
    if (!room || !text.trim()) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      io.to(room.id).emit('chatMessage', {
        sender: player.name,
        text: text.trim(),
        isSystem: false
      });
    }
  });

  // ゲーム終了後の部屋設定画面へ戻る（Partyモード）
  socket.on('returnToRoomSettings', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.status = 'LOBBY';
    room.players.forEach(p => { p.ready = false; });
    broadcastRoomState(room.id);
  });

  // オンライン対戦の再戦投票
  socket.on('voteRematch', (wantsRematch) => {
    const room = rooms[socket.roomId];
    if (!room || !room.isAutoMatch) return;

    if (!wantsRematch) {
      // 誰か1人でもキャンセルしたら全員ロビーへ戻す
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

  // ロビーへ戻る（退出）
  socket.on('leaveRoom', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });

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
        // ホストが抜けた場合は次の人をホストに
        if (leftPlayer.isHost) {
          room.players[0].isHost = true;
        }
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
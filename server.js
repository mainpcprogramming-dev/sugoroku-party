const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const { QUIZ_BANK } = require('./quizzes');

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

const PLAYER_COLORS = [
  '#e74c3c', // レッド
  '#2980b9', // ブルー
  '#27ae60', // グリーン
  '#e67e22', // オレンジ
  '#8e44ad', // パープル
  '#16a085', // ターコイズ
  '#d81b60', // ピンク
  '#2c3e50'  // ネイビー
];

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

const TREASURES = [
  { name: '🏺 古びた壺', value: 3000 },
  { name: '🪙 古代の金貨', value: 6000 },
  { name: '💍 サファイアの指輪', value: 10000 },
  { name: '🗡️ 黄金の短剣', value: 14000 },
  { name: '🖼️ 名画のレプリカ', value: 18000 },
  { name: '💎 大粒ダイヤモンド', value: 24000 },
  { name: '🐉 秘宝・龍の玉', value: 30000 },
  { name: '👑 伝説の王冠', value: 38000 }
];

const MINUS_ROULETTE_AMOUNTS = [3000, 5000, 8000, 10000, 15000, 20000, 25000];
const MYSTERY_ROULETTE_ITEMS = [
  { label: '+$3,000', amount: 3000 },
  { label: '-$3,000', amount: -3000 },
  { label: '+$8,000', amount: 8000 },
  { label: '-$8,000', amount: -8000 },
  { label: '+$15,000', amount: 15000 },
  { label: '-$15,000', amount: -15000 },
  { label: '+$22,000', amount: 22000 },
  { label: '-$20,000', amount: -20000 }
];

const rooms = {};
let autoMatchQueue = [];

function formatMoney(amount) {
  if (amount < 0) {
    return `-$${Math.abs(amount).toLocaleString()}`;
  }
  return `$${amount.toLocaleString()}`;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ランダム盤面生成（全種マス最低1個保証 + 下克上マス1個 + お宝マス2〜3個 + 強制ストップマス2個）
function generateBoard() {
  const totalTiles = 48;
  const fixedMap = {};

  // 1. 強制ストップマス（3種からランダム2種を各1マス＝計2マス）
  const stopCandidates = shuffleArray([
    { type: 'PAYDAY', label: '給料日(STOP)', desc: '必ずストップ！お給料をもらう', stop: true },
    { type: 'MARRIAGE', label: '結婚(STOP)', desc: '人生の節目！ご祝儀か破談か…', stop: true },
    { type: 'BRANCH', label: '人生の分岐(STOP)', desc: '堅実ルートか勝負ルートか選択！', stop: true }
  ]);
  fixedMap[16] = { ...stopCandidates[0] };
  fixedMap[32] = { ...stopCandidates[1] };

  // 空きマスリスト（1〜46）
  const freeIndices = [];
  for (let i = 1; i < totalTiles - 1; i++) {
    if (!fixedMap[i]) freeIndices.push(i);
  }

  // 2. 下克上マス（最下位大逆転マス：終盤 34〜45 の間に1マス必ず配置）
  const comebackCandidates = freeIndices.filter(idx => idx >= 34 && idx <= 45);
  const comebackPos = comebackCandidates[Math.floor(Math.random() * comebackCandidates.length)];
  fixedMap[comebackPos] = {
    type: 'COMEBACK',
    label: '🔥下克上マス',
    desc: '最下位なら1位との差額を一気に逆転！'
  };

  // 残りの空きマスをシャッフル
  const remainingIndices = shuffleArray(freeIndices.filter(idx => !fixedMap[idx]));

  // 3. お宝マス（2〜3個必ず配置）
  const treasureCount = Math.random() < 0.5 ? 2 : 3;
  for (let k = 0; k < treasureCount; k++) {
    const pos = remainingIndices.pop();
    fixedMap[pos] = { type: 'TREASURE', label: '💎お宝マス', desc: 'お宝ルーレットでお宝ゲット！' };
  }

  // 4. すべての基本・イベントマス種別を「必ず最低1個」配置する
  const guaranteedTypes = [
    'NORMAL',
    'PLUS',
    'MINUS',
    'QUIZ',
    'JANKEN',
    'CLICK_GAME',
    'DICE_MINIGAME',
    'MINUS_ROULETTE',
    'MYSTERY',
    'BABY',
    'RANKUP',
    'PROPERTY'
  ];

  // 残りのマス枠を重み付きランダムで埋める（マイナスマス少し多め）
  const weightedPool = [
    'NORMAL', 'NORMAL',
    'PLUS', 'PLUS', 'PLUS', 'PLUS', 'PLUS',
    'MINUS', 'MINUS', 'MINUS', 'MINUS', 'MINUS', 'MINUS', 'MINUS',
    'QUIZ', 'QUIZ', 'QUIZ',
    'JANKEN', 'JANKEN', 'JANKEN',
    'CLICK_GAME', 'CLICK_GAME',
    'DICE_MINIGAME', 'DICE_MINIGAME',
    'MINUS_ROULETTE', 'MINUS_ROULETTE',
    'MYSTERY', 'MYSTERY', 'MYSTERY',
    'BABY', 'BABY',
    'RANKUP', 'RANKUP',
    'PROPERTY', 'PROPERTY', 'PROPERTY'
  ];

  const allTypesToPlace = [...guaranteedTypes];
  while (allTypesToPlace.length < remainingIndices.length) {
    const picked = weightedPool[Math.floor(Math.random() * weightedPool.length)];
    allTypesToPlace.push(picked);
  }
  shuffleArray(allTypesToPlace);

  // マスデータ生成ヘルパー
  function buildTileByType(index, type) {
    const multiplier = Math.floor(index / 8) + 1;
    const baseAmount = 1000 * multiplier;

    switch (type) {
      case 'NORMAL':
        return { index, type: 'NORMAL', label: '通常マス', desc: '穏やかな一日。特に何も起きない。' };
      case 'PLUS': {
        const val = baseAmount * (Math.floor(Math.random() * 3) + 1);
        return { index, type: 'PLUS', label: `+$${val}`, amount: val, desc: `臨時収入！$${val}ゲット` };
      }
      case 'MINUS': {
        const val = baseAmount * (Math.floor(Math.random() * 2) + 1);
        return { index, type: 'MINUS', label: `-$${val}`, amount: val, desc: `思わぬ出費…$${val}失う` };
      }
      case 'QUIZ': {
        const val = baseAmount * 3;
        return { index, type: 'QUIZ', label: 'クイズ', amount: val, desc: `正解で+$${val} / 不正解で-$${Math.floor(val / 2)}` };
      }
      case 'JANKEN': {
        const winVal = baseAmount * 3;
        const loseVal = Math.floor(winVal / 2);
        return { index, type: 'JANKEN', label: 'じゃんけん', winAmount: winVal, loseAmount: loseVal };
      }
      case 'CLICK_GAME': {
        const reward = baseAmount * 3;
        const penalty = Math.floor(reward / 2);
        return { index, type: 'CLICK_GAME', label: '⚡連打挑戦', reward, penalty };
      }
      case 'DICE_MINIGAME':
        return { index, type: 'DICE_MINIGAME', label: '🎲全員勝負', entryFee: 3000 };
      case 'MINUS_ROULETTE':
        return { index, type: 'MINUS_ROULETTE', label: '💀道連れルーレット' };
      case 'MYSTERY':
        return { index, type: 'MYSTERY', label: '？？？マス' };
      case 'BABY': {
        const val = baseAmount * 2;
        return { index, type: 'BABY', label: '出産祝い', amount: val, desc: `赤ちゃん誕生！お祝い金+$${val}` };
      }
      case 'RANKUP':
        return { index, type: 'RANKUP', label: '職業昇進', desc: '仕事が評価され職業ランクアップ！' };
      case 'PROPERTY':
      default: {
        const prop = PROPERTIES[Math.min(PROPERTIES.length - 1, Math.floor(index / 10))];
        return { index, type: 'PROPERTY', label: '物件購入', property: prop };
      }
    }
  }

  remainingIndices.forEach((pos, idx) => {
    fixedMap[pos] = buildTileByType(pos, allTypesToPlace[idx]);
  });

  const board = [];
  for (let i = 0; i < totalTiles; i++) {
    if (i === 0) {
      board.push({ index: i, type: 'START', label: 'START', desc: '人生の始まり！' });
    } else if (i === totalTiles - 1) {
      board.push({ index: i, type: 'GOAL', label: 'GOAL!', desc: '人生のゴール！' });
    } else {
      board.push({ index: i, ...fixedMap[i] });
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
    status: 'LOBBY',
    timeLimit: 30,
    quizDifficulty: 'NORMAL',
    usedQuizIndices: new Set(),
    players: [],
    board: [],
    turnIndex: 0,
    turnLocked: false,
    goalOrder: [],
    turnTimer: null,
    timeLeft: 30,
    rematchVotes: {},
    activeMinigame: null
  };
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const sanitizedPlayers = room.players.map(p => ({
    ...p,
    isNegative: !(room.status === 'PLAYING' && p.finished) && p.money < 0,
    displayMoney: (room.status === 'PLAYING' && p.finished) ? '???' : formatMoney(p.money)
  }));

  io.to(roomId).emit('roomStateUpdate', {
    id: room.id,
    isAutoMatch: room.isAutoMatch,
    status: room.status,
    timeLimit: room.timeLimit,
    quizDifficulty: room.quizDifficulty,
    players: sanitizedPlayers,
    board: room.board,
    turnIndex: room.turnIndex,
    turnLocked: room.turnLocked,
    timeLeft: room.timeLeft
  });
}

function showResultBannerAndProceed(roomId, bannerData, nextCallback) {
  io.to(roomId).emit('showResultBanner', bannerData);
  setTimeout(() => {
    io.to(roomId).emit('hideResultBanner');
    if (nextCallback) nextCallback();
  }, 1700);
}

function pickQuizForRoom(room) {
  const bank = QUIZ_BANK[room.quizDifficulty] || QUIZ_BANK.NORMAL;
  if (room.usedQuizIndices.size >= bank.length) {
    room.usedQuizIndices.clear();
  }
  let idx;
  do {
    idx = Math.floor(Math.random() * bank.length);
  } while (room.usedQuizIndices.has(idx));
  room.usedQuizIndices.add(idx);
  return bank[idx];
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
      if (currentPlayer && !room.turnLocked) {
        room.turnLocked = true;
        sendSystemChat(roomId, `⏰ 時間切れ！${currentPlayer.name}さんのターンはスキップされ、次のプレイヤーへ移動します。`);
        broadcastRoomState(roomId);
        setTimeout(() => nextTurn(roomId), 1000);
      }
    }
  }, 1000);
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'PLAYING') return;

  if (room.players.every(p => p.finished)) {
    finishGame(roomId);
    return;
  }

  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.turnLocked = false;
  broadcastRoomState(roomId);

  const nextPlayer = room.players[room.turnIndex];
  if (nextPlayer) {
    io.to(nextPlayer.id).emit('yourTurnNotice', {
      isGoalBonus: nextPlayer.finished
    });
  }

  startTurnTimer(roomId);
}

function executeSpin(roomId, playerId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'PLAYING') return;
  const player = room.players[room.turnIndex];

  if (!player || player.id !== playerId || room.turnLocked) return;

  room.turnLocked = true;
  clearInterval(room.turnTimer);
  broadcastRoomState(roomId);

  const result = Math.floor(Math.random() * 6) + 1;
  io.to(roomId).emit('rouletteStart', { playerId: player.id, targetNumber: result });

  setTimeout(() => {
    if (!rooms[roomId]) return;

    if (player.finished) {
      const bonus = result * 200;
      player.money += bonus;
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
  if (!room || room.status !== 'PLAYING') return;

  if (stepsRemaining <= 0 || player.position >= room.board.length - 1) {
    handleTileLanding(roomId, player);
    return;
  }

  player.position++;
  broadcastRoomState(roomId);

  const currentTile = room.board[player.position];

  if (currentTile.type === 'GOAL') {
    handleGoal(roomId, player);
    return;
  }

  if (currentTile.stop && stepsRemaining > 1) {
    sendSystemChat(roomId, `${player.name}さんは「${currentTile.label}」で強制ストップ！`);
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

// 全員参加ダイスバトルの賞金分配計算
function calculateDicePrizes(playerCount, entryFee) {
  const poolTotal = playerCount * entryFee;
  if (playerCount === 2) return [4500, 1500];
  if (playerCount === 3) return [6000, 2500, 500];
  if (playerCount === 4) return [8000, 3000, 1000, 0];

  const weights = [];
  for (let i = 0; i < playerCount - 1; i++) {
    weights.push(Math.pow(2, playerCount - 1 - i));
  }
  weights.push(0);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const prizes = weights.map(w => Math.floor((poolTotal * w / weightSum) / 100) * 100);
  const currentSum = prizes.reduce((a, b) => a + b, 0);
  prizes[0] += (poolTotal - currentSum);
  return prizes;
}

function finalizeDiceMinigame(roomId) {
  const room = rooms[roomId];
  if (!room || !room.activeMinigame) return;
  const mg = room.activeMinigame;
  const prizes = calculateDicePrizes(mg.participants.length, mg.entryFee);

  const sorted = [...mg.participants].sort((a, b) => b.roll - a.roll);

  let idx = 0;
  const resultLines = [];
  while (idx < sorted.length) {
    let tieEnd = idx;
    while (tieEnd + 1 < sorted.length && sorted[tieEnd + 1].roll === sorted[idx].roll) {
      tieEnd++;
    }
    const tieCount = tieEnd - idx + 1;
    let sharedPrize = 0;
    for (let k = idx; k <= tieEnd; k++) {
      sharedPrize += (prizes[k] || 0);
    }
    const perPlayerPrize = Math.floor((sharedPrize / tieCount) / 10) * 10;
    const rankNum = idx + 1;

    for (let k = idx; k <= tieEnd; k++) {
      const part = sorted[k];
      const pObj = room.players.find(p => p.id === part.id);
      if (pObj) {
        pObj.money += perPlayerPrize;
      }
      part.rank = rankNum;
      part.prize = perPlayerPrize;
      resultLines.push(`${rankNum}位:${part.name}(出目${part.roll})→+$${perPlayerPrize.toLocaleString()}`);
    }
    idx = tieEnd + 1;
  }

  sendSystemChat(roomId, `🎲 ダイスバトル結果！ ${resultLines.join(' / ')}`);
  broadcastRoomState(roomId);
  io.to(roomId).emit('diceMinigameResult', { results: sorted });

  setTimeout(() => {
    room.activeMinigame = null;
    io.to(roomId).emit('closeDiceMinigame');
    nextTurn(roomId);
  }, 3500);
}

function handleTileLanding(roomId, player) {
  const room = rooms[roomId];
  if (!room || room.status !== 'PLAYING') return;
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
    player.money -= tile.amount;
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
    if (Math.random() < 0.10) {
      player.money -= 10000;
      sendSystemChat(roomId, `💔 結婚失敗…！${player.name}さんは破談・キャンセル料で$10,000失いました…。`);
      broadcastRoomState(roomId);
      showResultBannerAndProceed(roomId, {
        title: '💔 結婚失敗…！',
        subtitle: `${player.name}さんは破談になり -$10,000 失いました…`,
        theme: 'lose'
      }, () => nextTurn(roomId));
    } else {
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
    }

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

  } else if (tile.type === 'COMEBACK') {
    // 🔥下克上マス（現在最下位なら1位との差額分を一気に逆転！）
    const minMoney = Math.min(...room.players.map(p => p.money));
    const maxMoney = Math.max(...room.players.map(p => p.money));

    if (player.money === minMoney && maxMoney > minMoney) {
      const diff = maxMoney - minMoney;
      const bonus = Math.max(25000, diff + 5000);
      player.money += bonus;
      sendSystemChat(roomId, `🔥 下克上発動！！最下位の${player.name}さんが奇跡の大逆転ボーナス+$${bonus.toLocaleString()}を獲得！！`);
      broadcastRoomState(roomId);
      showResultBannerAndProceed(roomId, {
        title: '🔥 下克上大逆転！！',
        subtitle: `最下位${player.name}さんが +$${bonus.toLocaleString()} 獲得！`,
        theme: 'win'
      }, () => nextTurn(roomId));
    } else {
      player.money += 3000;
      sendSystemChat(roomId, `🔥 下克上マス！${player.name}さんは最下位ではなかったため参加賞+$3,000を獲得しました。`);
      broadcastRoomState(roomId);
      showResultBannerAndProceed(roomId, {
        title: '🔥 下克上マス（参加賞）',
        subtitle: `最下位専用マス！${player.name}さんに +$3,000`,
        theme: 'draw'
      }, () => nextTurn(roomId));
    }

  } else if (tile.type === 'MINUS_ROULETTE') {
    // 💀 マイナス額ルーレット → 被害者プレイヤー決めルーレット
    player.pendingEvent = { type: 'MINUS_ROULETTE', step: 'AMOUNT', chosenAmount: 0 };
    io.to(roomId).emit('startMinusRoulette', {
      actorId: player.id,
      actorName: player.name,
      amounts: MINUS_ROULETTE_AMOUNTS,
      players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color }))
    });

  } else if (tile.type === 'MYSTERY') {
    // ？？？マス（プラスorマイナスルーレット）
    player.pendingEvent = { type: 'MYSTERY' };
    io.to(roomId).emit('startMysteryRoulette', {
      actorId: player.id,
      actorName: player.name,
      items: MYSTERY_ROULETTE_ITEMS.map(item => item.label)
    });

  } else if (tile.type === 'TREASURE') {
    player.pendingEvent = { type: 'TREASURE' };
    io.to(roomId).emit('startTreasureRoulette', {
      playerId: player.id,
      playerName: player.name,
      treasures: TREASURES.map(t => t.name)
    });

  } else if (tile.type === 'CLICK_GAME') {
    const targetClicks = Math.floor(Math.random() * 21) + 40;
    player.pendingEvent = {
      type: 'CLICK_GAME',
      targetClicks,
      reward: tile.reward,
      penalty: tile.penalty,
      clicks: 0
    };
    io.to(roomId).emit('startClickChallenge', {
      playerId: player.id,
      playerName: player.name,
      targetClicks,
      reward: tile.reward,
      penalty: tile.penalty
    });

  } else if (tile.type === 'DICE_MINIGAME') {
    const entryFee = tile.entryFee || 3000;
    room.players.forEach(p => {
      p.money -= entryFee;
    });
    const prizes = calculateDicePrizes(room.players.length, entryFee);
    sendSystemChat(roomId, `🎲 全員参加ダイスバトル発生！全員から参加費$${entryFee.toLocaleString()}を徴収しました！`);
    broadcastRoomState(roomId);

    room.activeMinigame = {
      type: 'DICE_MINIGAME',
      entryFee,
      prizes,
      currentIdx: 0,
      rolling: false,
      participants: room.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        roll: null,
        rank: null,
        prize: 0
      }))
    };

    io.to(roomId).emit('startDiceMinigame', {
      entryFee,
      prizes,
      participants: room.activeMinigame.participants,
      currentRollerId: room.activeMinigame.participants[0].id
    });

  } else if (tile.type === 'BRANCH') {
    io.to(roomId).emit('interactiveEvent', {
      type: 'BRANCH',
      playerId: player.id,
      playerName: player.name,
      title: '人生の分岐点！どちらの道に進む？',
      desc: '堅実コース（確実に+$5,000）か、ギャンブルコース（50%で+$20,000 / 50%で-$8,000）'
    });

  } else if (tile.type === 'QUIZ') {
    const quiz = pickQuizForRoom(room);
    player.pendingEvent = { type: 'QUIZ', quiz, amount: tile.amount };
    io.to(roomId).emit('interactiveEvent', {
      type: 'QUIZ',
      difficulty: room.quizDifficulty,
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
    const treasureTotal = p.treasures.reduce((sum, t) => sum + t.value, 0);
    const familyBonus = (p.married ? 5000 : 0) + (p.childrenCount * 4000);
    const totalAssets = p.money + propertyTotal + treasureTotal + familyBonus;
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      job: p.job.currentName,
      cash: p.money,
      formattedCash: formatMoney(p.money),
      propertyCount: p.properties.length,
      propertyValue: propertyTotal,
      treasureCount: p.treasures.length,
      treasureValue: treasureTotal,
      familyBonus,
      totalAssets,
      formattedTotal: formatMoney(totalAssets)
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

  socket.on('changeQuizDifficulty', (difficulty) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && player.isHost && ['EASY', 'NORMAL', 'HARD'].includes(difficulty)) {
      room.quizDifficulty = difficulty;
      broadcastRoomState(room.id);
    }
  });

  socket.on('shufflePlayers', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'LOBBY') return;
    const player = room.players.find(p => p.id === socket.id);
    if (player && player.isHost) {
      shuffleArray(room.players);
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
    room.turnLocked = false;
    room.goalOrder = [];
    room.rematchVotes = {};
    room.activeMinigame = null;
    room.usedQuizIndices.clear();

    room.players.forEach((p, idx) => {
      p.color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
      p.job = { currentName: '未定', currentSalary: 0, isRankedUp: false };
      p.jobDecided = false;
      p.money = 5000;
      p.position = 0;
      p.properties = [];
      p.treasures = [];
      p.married = false;
      p.childrenCount = 0;
      p.finished = false;
    });

    broadcastRoomState(roomId);
    io.to(roomId).emit('startCountdown', 3);

    setTimeout(() => {
      if (!rooms[roomId]) return;
      room.status = 'JOB_ROULETTE';
      broadcastRoomState(roomId);
      io.to(roomId).emit('startJobRoulettePhase', JOBS.map(j => j.name));
    }, 3200);
  }

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

    if (room.players.every(p => p.jobDecided)) {
      setTimeout(() => {
        if (!rooms[room.id]) return;
        room.status = 'PLAYING';
        room.turnLocked = false;
        io.to(room.id).emit('allJobsDecided');
        const firstPlayer = room.players[0];
        sendSystemChat(room.id, `🎮 全員の職業が決定！最初は${firstPlayer.name}さんのターンです！`);
        broadcastRoomState(room.id);

        if (firstPlayer) {
          io.to(firstPlayer.id).emit('yourTurnNotice', { isGoalBonus: false });
        }

        startTurnTimer(room.id);
      }, 1500);
    }
  });

  socket.on('spinRoulette', () => {
    if (socket.roomId) {
      executeSpin(socket.roomId, socket.id);
    }
  });

  // 💀 マイナスルーレット（ステップ1：金額決定 → ステップ2：ターゲットプレイヤー決定）
  socket.on('stopMinusRoulette', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id || !player.pendingEvent || player.pendingEvent.type !== 'MINUS_ROULETTE') return;

    const ev = player.pendingEvent;
    if (ev.step === 'AMOUNT') {
      const chosenAmount = MINUS_ROULETTE_AMOUNTS[Math.floor(Math.random() * MINUS_ROULETTE_AMOUNTS.length)];
      ev.step = 'TARGET';
      ev.chosenAmount = chosenAmount;

      io.to(room.id).emit('minusRouletteAmountDecided', {
        amount: chosenAmount,
        actorId: player.id,
        actorName: player.name
      });
    } else if (ev.step === 'TARGET') {
      const targetPlayer = room.players[Math.floor(Math.random() * room.players.length)];
      const amount = ev.chosenAmount;
      player.pendingEvent = null;

      targetPlayer.money -= amount;
      io.to(room.id).emit('minusRouletteTargetDecided', {
        targetName: targetPlayer.name,
        amount
      });
      sendSystemChat(room.id, `💀 道連れルーレット発動！${targetPlayer.name}さんが -$${amount.toLocaleString()} の被害を受けました…！`);
      broadcastRoomState(room.id);

      setTimeout(() => {
        io.to(room.id).emit('closeMinusRoulette');
        nextTurn(room.id);
      }, 2200);
    }
  });

  // ？？？マスルーレット停止
  socket.on('stopMysteryRoulette', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id || !player.pendingEvent || player.pendingEvent.type !== 'MYSTERY') return;

    player.pendingEvent = null;
    const picked = MYSTERY_ROULETTE_ITEMS[Math.floor(Math.random() * MYSTERY_ROULETTE_ITEMS.length)];
    player.money += picked.amount;

    io.to(room.id).emit('mysteryRouletteDecided', {
      label: picked.label,
      isWin: picked.amount > 0
    });

    if (picked.amount > 0) {
      sendSystemChat(room.id, `❓ ？？？マス結果：大当たり！${player.name}さんが ${picked.label} 獲得しました！`);
    } else {
      sendSystemChat(room.id, `❓ ？？？マス結果：ハズレ…${player.name}さんが ${picked.label} 失いました…。`);
    }
    broadcastRoomState(room.id);

    setTimeout(() => {
      io.to(room.id).emit('closeMysteryRoulette');
      nextTurn(room.id);
    }, 2000);
  });

  // お宝ルーレット停止
  socket.on('stopTreasureRoulette', () => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id || !player.pendingEvent || player.pendingEvent.type !== 'TREASURE') return;

    player.pendingEvent = null;
    const treasure = TREASURES[Math.floor(Math.random() * TREASURES.length)];
    player.treasures.push(treasure);

    io.to(room.id).emit('treasureDecided', {
      playerName: player.name,
      treasure
    });
    sendSystemChat(room.id, `💎 ${player.name}さんがお宝「${treasure.name}」（売値 $${treasure.value.toLocaleString()}）を獲得しました！`);
    broadcastRoomState(room.id);

    setTimeout(() => {
      io.to(room.id).emit('closeTreasureRoulette');
      nextTurn(room.id);
    }, 2000);
  });

  // 連打ゲームのリアルタイム回数通知（他のプレイヤーにも同期）
  socket.on('clickChallengeTap', ({ clicks }) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id || !player.pendingEvent || player.pendingEvent.type !== 'CLICK_GAME') return;

    const safeClicks = Math.min(Number(clicks) || 0, 150);
    player.pendingEvent.clicks = safeClicks;
    socket.to(room.id).emit('clickChallengeProgress', { clicks: safeClicks });
  });

  // クリック連打チャレンジ結果提出
  socket.on('submitClickChallenge', ({ clicks }) => {
    const room = rooms[socket.roomId];
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id || !player.pendingEvent || player.pendingEvent.type !== 'CLICK_GAME') return;

    const { targetClicks, reward, penalty } = player.pendingEvent;
    player.pendingEvent = null;
    const safeClicks = Math.min(Number(clicks) || 0, 150);
    const success = safeClicks >= targetClicks;

    io.to(room.id).emit('closeClickChallenge');

    if (success) {
      player.money += reward;
      sendSystemChat(room.id, `⚡ 連打チャレンジ成功！${player.name}さんが5秒で${safeClicks}回タップ（目標${targetClicks}回）達成！+$${reward.toLocaleString()}獲得！`);
      broadcastRoomState(room.id);
      showResultBannerAndProceed(room.id, {
        title: '⚡ 連打チャレンジ成功！',
        subtitle: `${safeClicks}回 / 目標${targetClicks}回 達成！+$${reward.toLocaleString()}`,
        theme: 'win'
      }, () => nextTurn(room.id));
    } else {
      player.money -= penalty;
      sendSystemChat(room.id, `💦 連打チャレンジ失敗…${player.name}さんは${safeClicks}回（目標${targetClicks}回）で未達成…-$${penalty.toLocaleString()}失いました。`);
      broadcastRoomState(room.id);
      showResultBannerAndProceed(room.id, {
        title: '💦 連打チャレンジ失敗…',
        subtitle: `${safeClicks}回 / 目標${targetClicks}回 未達成… -$${penalty.toLocaleString()}`,
        theme: 'lose'
      }, () => nextTurn(room.id));
    }
  });

  // 全員参加ダイスバトル：各プレイヤーが自分のサイコロを振る
  socket.on('rollMinigameDice', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.activeMinigame || room.activeMinigame.rolling) return;
    const mg = room.activeMinigame;
    const currentParticipant = mg.participants[mg.currentIdx];

    if (!currentParticipant || currentParticipant.id !== socket.id) return;

    mg.rolling = true;
    const roll = Math.floor(Math.random() * 6) + 1;
    currentParticipant.roll = roll;

    io.to(room.id).emit('diceMinigameRolled', {
      playerId: currentParticipant.id,
      roll
    });

    setTimeout(() => {
      if (!rooms[room.id] || !room.activeMinigame) return;
      mg.rolling = false;
      mg.currentIdx++;

      if (mg.currentIdx < mg.participants.length) {
        const nextRoller = mg.participants[mg.currentIdx];
        io.to(room.id).emit('diceMinigameNextRoller', {
          participants: mg.participants,
          currentRollerId: nextRoller.id
        });
      } else {
        io.to(room.id).emit('diceMinigameNextRoller', {
          participants: mg.participants,
          currentRollerId: null
        });
        finalizeDiceMinigame(room.id);
      }
    }, 1400);
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
          player.money -= 8000;
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
      const correctAnswerText = quiz.options[quiz.ans];
      if (choice === quiz.ans) {
        player.money += amount;
        sendSystemChat(room.id, `⭕ クイズ正解！答えは「${correctAnswerText}」！${player.name}さんが$${amount.toLocaleString()}獲得しました！`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '⭕ 正解しました！',
          subtitle: `答えは「${correctAnswerText}」！（+$${amount.toLocaleString()}）`,
          theme: 'win'
        }, () => nextTurn(room.id));
      } else {
        const loss = Math.floor(amount / 2);
        player.money -= loss;
        sendSystemChat(room.id, `❌ クイズ不正解…正解は「${correctAnswerText}」でした。${player.name}さんが$${loss.toLocaleString()}失いました。`);
        broadcastRoomState(room.id);
        showResultBannerAndProceed(room.id, {
          title: '❌ クイズ不正解…',
          subtitle: `正解は「${correctAnswerText}」でした (-$${loss.toLocaleString()})`,
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
        player.money -= loseAmount;
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
      treasures: [],
      married: false,
      childrenCount: 0,
      finished: false
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
        return;
      }

      if (room.status !== 'LOBBY' && room.players.length <= 1) {
        clearInterval(room.turnTimer);
        const remainingSocketId = room.players[0].id;
        const remainingSocket = io.sockets.sockets.get(remainingSocketId);
        if (remainingSocket) {
          remainingSocket.leave(roomId);
          remainingSocket.roomId = null;
        }
        io.to(remainingSocketId).emit('forceReturnLobby', '他のプレイヤーが離脱し残り1人になったため、ゲームを強制終了してロビーに戻ります。');
        delete rooms[roomId];
        return;
      }

      if (leftPlayer.isHost) room.players[0].isHost = true;
      sendSystemChat(roomId, `${leftPlayer.name}さんが退出しました。`);

      if (room.status === 'PLAYING') {
        if (room.turnIndex >= room.players.length) room.turnIndex = 0;
        room.turnLocked = false;
        room.activeMinigame = null;
        io.to(roomId).emit('closeAllEventModals');
        broadcastRoomState(roomId);
        const nextPlayer = room.players[room.turnIndex];
        if (nextPlayer) {
          io.to(nextPlayer.id).emit('yourTurnNotice', { isGoalBonus: nextPlayer.finished });
        }
        startTurnTimer(roomId);
      } else {
        broadcastRoomState(roomId);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
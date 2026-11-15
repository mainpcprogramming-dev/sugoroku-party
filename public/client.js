const socket = io();
let myPlayerId = null;
let currentRoomState = null;
let rouletteInterval = null;

// 画面切り替え関数
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

// ロビー操作
document.getElementById('btn-create-room').onclick = () => {
  const playerName = document.getElementById('username-input').value.trim() || 'プレイヤー';
  socket.emit('createRoom', { playerName });
};

document.getElementById('btn-join-room').onclick = () => {
  const playerName = document.getElementById('username-input').value.trim() || 'プレイヤー';
  const roomId = document.getElementById('room-code-input').value.trim();
  if (roomId.length !== 4) return alert('4桁の部屋番号を入力してください。');
  socket.emit('joinRoom', { roomId, playerName });
};

document.getElementById('btn-auto-match').onclick = () => {
  const playerName = document.getElementById('username-input').value.trim() || 'プレイヤー';
  socket.emit('joinAutoMatch', { playerName });
  document.getElementById('btn-cancel-match').classList.remove('hidden');
};

document.getElementById('btn-cancel-match').onclick = () => {
  socket.emit('cancelAutoMatch');
  document.getElementById('lobby-status').textContent = '';
  document.getElementById('btn-cancel-match').classList.add('hidden');
};

socket.on('matchingStatus', ({ count }) => {
  document.getElementById('lobby-status').textContent = `オンライン対戦マッチング中... (${count} / 4人)`;
});

socket.on('errorMsg', (msg) => alert(msg));

// 部屋入室成功
socket.on('joinedRoom', ({ roomId, playerId }) => {
  myPlayerId = playerId;
  document.getElementById('lobby-status').textContent = '';
  document.getElementById('btn-cancel-match').classList.add('hidden');
  document.getElementById('display-room-id').textContent = roomId;
  document.getElementById('chat-messages').innerHTML = '';
  showScreen('waiting-screen');
});

// 待機部屋のボタン操作
document.getElementById('btn-leave-room').onclick = () => {
  socket.emit('leaveRoom');
  showScreen('lobby-screen');
};

document.getElementById('btn-ready').onclick = () => {
  socket.emit('toggleReady');
};

document.getElementById('time-limit-select').onchange = (e) => {
  socket.emit('changeTimeLimit', Number(e.target.value));
};

document.getElementById('btn-shuffle').onclick = () => {
  socket.emit('shufflePlayers');
};

document.getElementById('btn-start-game').onclick = () => {
  socket.emit('startGame', { force: false });
};

document.getElementById('btn-force-start').onclick = () => {
  socket.emit('startGame', { force: true });
};

// 状態同期（自動更新）
socket.on('roomStateUpdate', (state) => {
  currentRoomState = state;
  const me = state.players.find(p => p.id === myPlayerId);
  if (!me) return;

  if (state.status === 'LOBBY') {
    showScreen('waiting-screen');
    document.getElementById('time-limit-select').value = state.timeLimit;
    document.getElementById('time-limit-select').disabled = !me.isHost;

    // ホスト専用ボタン表示制御
    if (me.isHost) {
      document.getElementById('btn-shuffle').classList.remove('hidden');
      document.getElementById('host-start-buttons').classList.remove('hidden');
    } else {
      document.getElementById('btn-shuffle').classList.add('hidden');
      document.getElementById('host-start-buttons').classList.add('hidden');
    }

    // 自分の準備ボタンの色切り替え
    const readyBtn = document.getElementById('btn-ready');
    if (me.ready) {
      readyBtn.textContent = '準備OK！（クリックで解除）';
      readyBtn.className = 'btn ready-btn is-ready';
    } else {
      readyBtn.textContent = '準備中（クリックで準備OK）';
      readyBtn.className = 'btn ready-btn not-ready';
    }

    // プレイヤーリスト更新（準備OKは緑、準備中は赤）
    const listEl = document.getElementById('waiting-player-list');
    listEl.innerHTML = '';
    state.players.forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      li.innerHTML = `
        <span>${idx + 1}. ${p.name} ${p.isHost ? '👑(ホスト)' : ''}</span>
        <span class="badge-ready ${p.ready ? 'ok' : 'wait'}">${p.ready ? '準備OK' : '準備中'}</span>
      `;
      listEl.appendChild(li);
    });
  } else if (state.status === 'PLAYING') {
    showScreen('game-screen');
    renderGameBoard(state);
  }
});

// 開始カウントダウン
socket.on('startCountdown', (sec) => {
  const overlay = document.getElementById('countdown-overlay');
  const numEl = document.getElementById('countdown-number');
  overlay.classList.remove('hidden');
  let count = sec;
  numEl.textContent = count;

  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      numEl.textContent = count;
    } else if (count === 0) {
      numEl.textContent = 'START!';
    } else {
      clearInterval(timer);
      overlay.classList.add('hidden');
    }
  }, 1000);
});

// ゲーム盤面・ステータス描画
function renderGameBoard(state) {
  const activePlayer = state.players[state.turnIndex];
  const isMyTurn = activePlayer && activePlayer.id === myPlayerId;

  // 上部ステータスバー（プレイヤー名「役職」：所持金）
  const statusBar = document.getElementById('players-status-bar');
  statusBar.innerHTML = '';
  state.players.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = `player-card ${idx === state.turnIndex ? 'active-turn' : ''}`;
    div.innerHTML = `
      <div class="p-name">${p.name}「${p.job.name}」</div>
      <div class="p-money">${p.displayMoney}</div>
      <div style="font-size:0.75rem; color:#666;">物件: ${p.properties.length}件</div>
    `;
    statusBar.appendChild(div);
  });

  // ターン情報＆ルーレットボタン制御
  document.getElementById('current-turn-label').textContent = `${activePlayer.name}さんのターン`;
  const spinBtn = document.getElementById('btn-spin');
  spinBtn.disabled = !(isMyTurn && !activePlayer.isSpinning);

  // 盤面マス描画
  const grid = document.getElementById('board-grid');
  grid.innerHTML = '';
  state.board.forEach(tile => {
    const tileEl = document.createElement('div');
    tileEl.className = `tile ${tile.type}`;
    const playersHere = state.players.filter(p => p.position === tile.index);
    const tokensHtml = playersHere.map(p => `<span class="token">${p.name}</span>`).join('');

    tileEl.innerHTML = `
      <div class="tile-num">#${tile.index}</div>
      <div class="tile-label">${tile.label}</div>
      <div class="tokens">${tokensHtml}</div>
    `;
    grid.appendChild(tileEl);
  });
}

socket.on('timerUpdate', (timeLeft) => {
  document.getElementById('turn-timer').textContent = `${timeLeft}s`;
});

// ルーレットボタン押下
document.getElementById('btn-spin').onclick = () => {
  document.getElementById('btn-spin').disabled = true;
  socket.emit('spinRoulette');
};

// 全員に同期される高速ルーレット演出
socket.on('rouletteStart', ({ targetNumber }) => {
  clearInterval(rouletteInterval);
  const display = document.getElementById('roulette-display');
  let num = 1;
  // 50ミリ秒ごとに高速回転
  rouletteInterval = setInterval(() => {
    num = (num % 6) + 1;
    display.textContent = num;
  }, 50);

  // 2.2秒後に確定出目で停止
  setTimeout(() => {
    clearInterval(rouletteInterval);
    display.textContent = targetNumber;
  }, 2200);
});

// インタラクティブマス（クイズ・じゃんけん・分岐・物件）の全員同期表示
socket.on('interactiveEvent', (data) => {
  const modal = document.getElementById('event-modal');
  const titleEl = document.getElementById('event-title');
  const descEl = document.getElementById('event-desc');
  const choicesEl = document.getElementById('event-choices');
  const waitMsg = document.getElementById('event-waiting-msg');

  const isMyEvent = data.playerId === myPlayerId;
  choicesEl.innerHTML = '';
  modal.classList.remove('hidden');

  if (isMyEvent) {
    waitMsg.classList.add('hidden');
  } else {
    waitMsg.textContent = `${data.playerName}さんが選択中です...`;
    waitMsg.classList.remove('hidden');
  }

  if (data.type === 'BRANCH') {
    titleEl.textContent = data.title;
    descEl.textContent = data.desc;
    if (isMyEvent) {
      choicesEl.innerHTML = `
        <button class="btn primary" onclick="sendChoice('SAFE')">堅実ルート (+$5,000)</button>
        <button class="btn danger" onclick="sendChoice('GAMBLE')">勝負ルート (+$20,000 or -$8,000)</button>
      `;
    }
  } else if (data.type === 'QUIZ') {
    titleEl.textContent = '❓ クイズマス！';
    descEl.textContent = data.question;
    if (isMyEvent) {
      data.options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'btn secondary';
        btn.textContent = opt;
        btn.onclick = () => sendChoice(idx);
        choicesEl.appendChild(btn);
      });
    }
  } else if (data.type === 'JANKEN') {
    titleEl.textContent = '✊✌️✋ CPUとじゃんけん勝負！';
    descEl.textContent = `勝てば +$${data.amount.toLocaleString()}！何を出しますか？`;
    if (isMyEvent) {
      ['グー ✊', 'チョキ ✌️', 'パー ✋'].forEach((hand, idx) => {
        const btn = document.createElement('button');
        btn.className = 'btn accent';
        btn.textContent = hand;
        btn.onclick = () => sendChoice(idx);
        choicesEl.appendChild(btn);
      });
    }
  } else if (data.type === 'PROPERTY') {
    titleEl.textContent = '🏢 物件購入チャンス！';
    descEl.textContent = `${data.property.name}（購入価格: $${data.property.price.toLocaleString()} / 決算時売却額: $${data.property.sellValue.toLocaleString()}）`;
    if (isMyEvent) {
      choicesEl.innerHTML = `
        <button class="btn primary" ${data.canAfford ? '' : 'disabled'} onclick="sendChoice('BUY')">購入する</button>
        <button class="btn secondary" onclick="sendChoice('SKIP')">見送る</button>
      `;
    }
  }
});

window.sendChoice = (choice) => {
  socket.emit('submitEventChoice', choice);
};

socket.on('closeInteractiveEvent', () => {
  document.getElementById('event-modal').classList.add('hidden');
});

// チャット送受信
document.getElementById('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  if (input.value.trim()) {
    socket.emit('sendChat', input.value);
    input.value = '';
  }
};

socket.on('chatMessage', ({ sender, text, isSystem }) => {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${isSystem ? 'system' : ''}`;
  div.textContent = isSystem ? `📢 ${text}` : `${sender}: ${text}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

// 総決算＆ドキドキランキング表示（下位から順番に発表）
socket.on('gameFinished', ({ results, isAutoMatch }) => {
  showScreen('result-screen');
  const container = document.getElementById('ranking-container');
  container.innerHTML = '';

  document.getElementById('party-end-actions').classList.add('hidden');
  document.getElementById('automatch-end-actions').classList.add('hidden');

  // 最下位から1位に向かって時間差で発表するドキドキ演出
  const reversed = [...results].reverse();
  reversed.forEach((r, idx) => {
    const actualRank = results.length - idx;
    const item = document.createElement('div');
    item.className = `rank-item rank-${actualRank}`;
    item.innerHTML = `
      <div>
        <strong>第${actualRank}位：${r.name}</strong>（${r.job}）<br>
        <small>所持金 $${r.cash.toLocaleString()} ＋ 物件${r.propertyCount}件売却 $${r.propertyValue.toLocaleString()}</small>
      </div>
      <div style="font-size:1.3rem; font-weight:bold; color:#27ae60;">
        総資産 $${r.totalAssets.toLocaleString()}
      </div>
    `;
    container.prepend(item);

    setTimeout(() => {
      item.classList.add('reveal');
      // 全員発表後に終了後ボタンを表示
      if (idx === reversed.length - 1) {
        if (isAutoMatch) {
          document.getElementById('automatch-end-actions').classList.remove('hidden');
        } else {
          document.getElementById('party-end-actions').classList.remove('hidden');
        }
      }
    }, (idx + 1) * 1200);
  });
});

// 終了後アクション
document.getElementById('btn-back-to-room').onclick = () => {
  socket.emit('returnToRoomSettings');
};

document.getElementById('btn-rematch').onclick = () => {
  document.getElementById('btn-rematch').disabled = true;
  socket.emit('voteRematch', true);
};

document.getElementById('btn-cancel-rematch').onclick = () => {
  socket.emit('voteRematch', false);
};

socket.on('rematchStatus', (msg) => {
  document.getElementById('rematch-status').textContent = msg;
});

socket.on('forceReturnLobby', (msg) => {
  alert(msg);
  showScreen('lobby-screen');
});
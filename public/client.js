const socket = io();
let myPlayerId = null;
let currentRoomState = null;
let rouletteInterval = null;
let jobRouletteInterval = null;
let turnToastTimeout = null;

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

socket.on('joinedRoom', ({ roomId, playerId }) => {
  myPlayerId = playerId;
  document.getElementById('lobby-status').textContent = '';
  document.getElementById('btn-cancel-match').classList.add('hidden');
  document.getElementById('display-room-id').textContent = roomId;
  document.getElementById('chat-messages').innerHTML = '';
  showScreen('waiting-screen');
});

// 待機部屋操作
document.getElementById('btn-leave-room').onclick = () => {
  socket.emit('leaveRoom');
  showScreen('lobby-screen');
};

document.getElementById('btn-ready').onclick = () => socket.emit('toggleReady');
document.getElementById('time-limit-select').onchange = (e) => socket.emit('changeTimeLimit', Number(e.target.value));
document.getElementById('quiz-difficulty-select').onchange = (e) => socket.emit('changeQuizDifficulty', e.target.value);
document.getElementById('btn-shuffle').onclick = () => socket.emit('shufflePlayers');
document.getElementById('btn-start-game').onclick = () => socket.emit('startGame', { force: false });
document.getElementById('btn-force-start').onclick = () => socket.emit('startGame', { force: true });

socket.on('roomStateUpdate', (state) => {
  currentRoomState = state;
  const me = state.players.find(p => p.id === myPlayerId);
  if (!me) return;

  if (state.status === 'LOBBY') {
    showScreen('waiting-screen');
    document.getElementById('time-limit-select').value = state.timeLimit;
    document.getElementById('time-limit-select').disabled = !me.isHost;

    document.getElementById('quiz-difficulty-select').value = state.quizDifficulty || 'NORMAL';
    document.getElementById('quiz-difficulty-select').disabled = !me.isHost;

    if (me.isHost) {
      document.getElementById('btn-shuffle').classList.remove('hidden');
      document.getElementById('host-start-buttons').classList.remove('hidden');
    } else {
      document.getElementById('btn-shuffle').classList.add('hidden');
      document.getElementById('host-start-buttons').classList.add('hidden');
    }

    const readyBtn = document.getElementById('btn-ready');
    if (me.ready) {
      readyBtn.textContent = '準備OK！（タップで解除）';
      readyBtn.className = 'btn ready-btn is-ready';
    } else {
      readyBtn.textContent = '準備中（タップで準備OK）';
      readyBtn.className = 'btn ready-btn not-ready';
    }

    const listEl = document.getElementById('waiting-player-list');
    listEl.innerHTML = '';
    state.players.forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      li.innerHTML = `
        <span><i class="color-dot" style="background:${p.color}"></i>${idx + 1}. ${escapeHtml(p.name)} ${p.isHost ? '👑' : ''}</span>
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

// 職業ルーレットフェーズ
socket.on('startJobRoulettePhase', (jobNames) => {
  const modal = document.getElementById('job-roulette-modal');
  const slotEl = document.getElementById('job-roulette-slot');
  const stopBtn = document.getElementById('btn-stop-job');
  const statusList = document.getElementById('job-players-status');

  modal.classList.remove('hidden');
  stopBtn.disabled = false;
  stopBtn.textContent = 'ストップして職業決定！';

  statusList.innerHTML = currentRoomState.players.map(p => `
    <div class="job-status-item" id="job-stat-${p.id}">
      <span><i class="color-dot" style="background:${p.color}"></i>${escapeHtml(p.name)}</span>
      <span class="job-val">ルーレット回転中...</span>
    </div>
  `).join('');

  let idx = 0;
  clearInterval(jobRouletteInterval);
  jobRouletteInterval = setInterval(() => {
    slotEl.textContent = jobNames[idx % jobNames.length];
    idx++;
  }, 60);
});

document.getElementById('btn-stop-job').onclick = () => {
  document.getElementById('btn-stop-job').disabled = true;
  document.getElementById('btn-stop-job').textContent = '他のプレイヤーを待っています...';
  socket.emit('stopJobRoulette');
};

socket.on('playerJobDecided', ({ playerId, jobName, salary }) => {
  if (playerId === myPlayerId) {
    clearInterval(jobRouletteInterval);
    document.getElementById('job-roulette-slot').textContent = `${jobName}（給料 $${salary.toLocaleString()}）`;
  }
  const row = document.getElementById(`job-stat-${playerId}`);
  if (row) {
    row.querySelector('.job-val').innerHTML = `<strong style="color:#27ae60;">${jobName}</strong> に決定！`;
  }
});

socket.on('allJobsDecided', () => {
  clearInterval(jobRouletteInterval);
  document.getElementById('job-roulette-modal').classList.add('hidden');
});

// 「あなたの番です！」通知
socket.on('yourTurnNotice', ({ isGoalBonus }) => {
  const toast = document.getElementById('your-turn-toast');
  toast.textContent = isGoalBonus
    ? '🌟 あなたの番です！（ゴール済みボーナスルーレット）'
    : '🎯 あなたの番です！ルーレットを回してください！';
  toast.classList.remove('hidden');

  clearTimeout(turnToastTimeout);
  turnToastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 1800);
});

// 結果バナー（1.5秒間表示）
socket.on('showResultBanner', ({ title, subtitle, theme }) => {
  const overlay = document.getElementById('result-banner-overlay');
  const box = document.getElementById('result-banner-box');
  document.getElementById('banner-title').textContent = title;
  document.getElementById('banner-subtitle').textContent = subtitle;
  box.className = `result-banner ${theme || 'win'}`;
  overlay.classList.remove('hidden');
});

socket.on('hideResultBanner', () => {
  document.getElementById('result-banner-overlay').classList.add('hidden');
});

// ゲーム盤面・カラーバナー描画
function renderGameBoard(state) {
  const activePlayer = state.players[state.turnIndex];
  const isMyTurn = activePlayer && activePlayer.id === myPlayerId;

  const statusBar = document.getElementById('players-status-bar');
  statusBar.innerHTML = '';
  state.players.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = `player-card ${idx === state.turnIndex ? 'active-turn' : ''}`;
    div.style.borderLeftColor = p.color;

    div.innerHTML = `
      <div class="p-header">
        <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
          <span class="p-name-tag" style="background:${p.color}">${escapeHtml(p.name)}</span>
          <span class="p-job">「${p.job.currentName}」</span>
        </div>
        <span class="p-badge">${p.finished ? 'GOAL済' : `P${idx + 1}`}</span>
      </div>
      <div class="p-money">${p.displayMoney}</div>
      <div class="p-sub">物件:${p.properties.length} / 家族:${p.married ? '既婚' : '独身'}${p.childrenCount > 0 ? `(子${p.childrenCount})` : ''}</div>
    `;
    statusBar.appendChild(div);
  });

  // ターン表示＆自分のターンバッジ強調
  const turnLabel = document.getElementById('current-turn-label');
  const turnPanelBox = document.getElementById('turn-panel-box');
  const myTurnBadge = document.getElementById('my-turn-badge');

  turnLabel.textContent = activePlayer.finished
    ? `${activePlayer.name}さん（ゴールボーナス）`
    : `${activePlayer.name}さんのターン`;
  turnLabel.style.color = activePlayer.color;

  if (isMyTurn) {
    turnPanelBox.classList.add('is-my-turn');
    myTurnBadge.classList.remove('hidden');
  } else {
    turnPanelBox.classList.remove('is-my-turn');
    myTurnBadge.classList.add('hidden');
  }

  const spinBtn = document.getElementById('btn-spin');
  spinBtn.disabled = !(isMyTurn && !state.turnLocked);

  const grid = document.getElementById('board-grid');
  grid.innerHTML = '';
  state.board.forEach(tile => {
    const tileEl = document.createElement('div');
    tileEl.className = `tile ${tile.type}`;
    const playersHere = state.players.filter(p => p.position === tile.index);
    const tokensHtml = playersHere.map(p =>
      `<span class="token" style="background:${p.color}">${escapeHtml(p.name)}</span>`
    ).join('');

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

document.getElementById('btn-spin').onclick = () => {
  document.getElementById('btn-spin').disabled = true;
  document.getElementById('your-turn-toast').classList.add('hidden');
  socket.emit('spinRoulette');
};

socket.on('rouletteStart', ({ targetNumber }) => {
  clearInterval(rouletteInterval);
  const display = document.getElementById('roulette-display');
  let num = 1;
  rouletteInterval = setInterval(() => {
    num = (num % 6) + 1;
    display.textContent = num;
  }, 50);

  setTimeout(() => {
    clearInterval(rouletteInterval);
    display.textContent = targetNumber;
  }, 2100);
});

// インタラクティブイベントモーダル
socket.on('interactiveEvent', (data) => {
  const modal = document.getElementById('event-modal');
  const actorBadge = document.getElementById('event-actor-badge');
  const titleEl = document.getElementById('event-title');
  const descEl = document.getElementById('event-desc');
  const choicesEl = document.getElementById('event-choices');
  const waitMsg = document.getElementById('event-waiting-msg');

  const isMyEvent = data.playerId === myPlayerId;
  actorBadge.textContent = `${data.playerName}さんのマスイベント`;
  choicesEl.innerHTML = '';
  modal.classList.remove('hidden');

  if (isMyEvent) {
    waitMsg.classList.add('hidden');
  } else {
    waitMsg.textContent = `${data.playerName}さんが回答・選択中です...`;
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
    const diffLabel = { EASY: 'イージー', NORMAL: 'ノーマル', HARD: 'ハード' }[data.difficulty] || 'ノーマル';
    titleEl.textContent = `❓ クイズ【${diffLabel}】（正解 +$${data.amount.toLocaleString()}）`;
    descEl.textContent = data.question;
    data.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'btn secondary';
      btn.textContent = opt;
      btn.disabled = !isMyEvent;
      if (isMyEvent) btn.onclick = () => sendChoice(idx);
      choicesEl.appendChild(btn);
    });
  } else if (data.type === 'JANKEN') {
    titleEl.textContent = '✊✌️✋ CPUとじゃんけん勝負！';
    descEl.innerHTML = `
      <span style="color:#27ae60;">勝ったら +$${data.winAmount.toLocaleString()}</span> ／ 
      <span style="color:#e74c3c;">負けたら -$${data.loseAmount.toLocaleString()}</span><br>
      勝負しますか？
    `;
    if (isMyEvent) {
      ['グー ✊', 'チョキ ✌️', 'パー ✋'].forEach((hand, idx) => {
        const btn = document.createElement('button');
        btn.className = 'btn accent';
        btn.textContent = `${hand} で勝負する！`;
        btn.onclick = () => sendChoice(idx);
        choicesEl.appendChild(btn);
      });
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn danger';
      skipBtn.textContent = '勝負しない（パス）';
      skipBtn.onclick = () => sendChoice('DECLINE');
      choicesEl.appendChild(skipBtn);
    }
  } else if (data.type === 'PROPERTY') {
    titleEl.textContent = '🏢 物件購入チャンス！';
    descEl.textContent = `${data.property.name}（購入: $${data.property.price.toLocaleString()} / 決算売却: $${data.property.sellValue.toLocaleString()}）`;
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

socket.on('chatMessage', ({ sender, color, text, isSystem }) => {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${isSystem ? 'system' : ''}`;
  if (isSystem) {
    div.textContent = `📢 ${text}`;
  } else {
    div.innerHTML = `<strong style="color:${color || '#333'}">${escapeHtml(sender)}:</strong> ${escapeHtml(text)}`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// 総決算＆ドキドキランキング表示
socket.on('gameFinished', ({ results, isAutoMatch }) => {
  showScreen('result-screen');
  const container = document.getElementById('ranking-container');
  container.innerHTML = '';

  document.getElementById('party-end-actions').classList.add('hidden');
  document.getElementById('automatch-end-actions').classList.add('hidden');

  const reversed = [...results].reverse();
  reversed.forEach((r, idx) => {
    const actualRank = results.length - idx;
    const item = document.createElement('div');
    item.className = `rank-item rank-${actualRank}`;
    item.style.borderLeftColor = r.color;
    item.innerHTML = `
      <div>
        <strong>第${actualRank}位：${escapeHtml(r.name)}</strong>（${r.job}）<br>
        <small>所持金 $${r.cash.toLocaleString()} ＋ 物件 $${r.propertyValue.toLocaleString()} ＋ 家族 $${r.familyBonus.toLocaleString()}</small>
      </div>
      <div style="font-size:1.2rem; font-weight:bold; color:#27ae60;">
        $${r.totalAssets.toLocaleString()}
      </div>
    `;
    container.prepend(item);

    setTimeout(() => {
      item.classList.add('reveal');
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

document.getElementById('btn-back-to-room').onclick = () => socket.emit('returnToRoomSettings');
document.getElementById('btn-rematch').onclick = () => {
  document.getElementById('btn-rematch').disabled = true;
  socket.emit('voteRematch', true);
};
document.getElementById('btn-cancel-rematch').onclick = () => socket.emit('voteRematch', false);
socket.on('rematchStatus', (msg) => { document.getElementById('rematch-status').textContent = msg; });

socket.on('forceReturnLobby', (msg) => {
  clearInterval(rouletteInterval);
  clearInterval(jobRouletteInterval);
  clearTimeout(turnToastTimeout);
  document.getElementById('countdown-overlay').classList.add('hidden');
  document.getElementById('job-roulette-modal').classList.add('hidden');
  document.getElementById('event-modal').classList.add('hidden');
  document.getElementById('result-banner-overlay').classList.add('hidden');
  document.getElementById('your-turn-toast').classList.add('hidden');
  currentRoomState = null;
  alert(msg);
  showScreen('lobby-screen');
});
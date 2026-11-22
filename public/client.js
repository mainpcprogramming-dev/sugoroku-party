const socket = io();
let myPlayerId = null;
let currentRoomState = null;
let rouletteInterval = null;
let jobRouletteInterval = null;
let treasureRouletteInterval = null;
let minusRouletteInterval = null;
let mysteryRouletteInterval = null;
let sniperRouletteInterval = null;
let diceMgRollInterval = null;
let clickChallengeInterval = null;
let turnToastTimeout = null;
let currentClickTarget = 50;

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
  myPlayerId = playerId || socket.id;
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
document.getElementById('goal-tile-select').onchange = (e) => socket.emit('changeGoalTile', Number(e.target.value));
document.getElementById('btn-shuffle').onclick = () => socket.emit('shufflePlayers');
document.getElementById('btn-start-game').onclick = () => socket.emit('startGame', { force: false });
document.getElementById('btn-force-start').onclick = () => socket.emit('startGame', { force: true });

socket.on('roomStateUpdate', (state) => {
  currentRoomState = state;
  if (!myPlayerId && socket.id) myPlayerId = socket.id;
  const me = state.players.find(p => p.id === myPlayerId);
  if (!me) return;

  if (state.status === 'LOBBY') {
    showScreen('waiting-screen');
    document.getElementById('time-limit-select').value = state.timeLimit;
    document.getElementById('time-limit-select').disabled = !me.isHost;

    document.getElementById('quiz-difficulty-select').value = state.quizDifficulty || 'NORMAL';
    document.getElementById('quiz-difficulty-select').disabled = !me.isHost;

    document.getElementById('goal-tile-select').value = state.goalTile || 50;
    document.getElementById('goal-tile-select').disabled = !me.isHost || state.isAutoMatch;

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
  if (playerId === (myPlayerId || socket.id)) {
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

// ========================
// 🎯 スナイパーマスイベント
// ========================
socket.on('startSniperEvent', ({ actorId, actorName, targets }) => {
  const isMyEvent = String(actorId) === String(myPlayerId || socket.id);
  const modal = document.getElementById('sniper-modal');
  const badge = document.getElementById('sniper-actor-badge');
  const titleEl = document.getElementById('sniper-title');
  const descEl = document.getElementById('sniper-desc');
  const listEl = document.getElementById('sniper-targets-list');
  const rouletteArea = document.getElementById('sniper-roulette-area');
  const waitMsg = document.getElementById('sniper-wait-msg');

  badge.textContent = `${actorName}さんのスナイパーイベント`;
  titleEl.textContent = '🎯 ターゲットを指名せよ！';
  descEl.textContent = '奪い取るライバルを1人選んでください（出た目 × $2,500 奪取）';
  listEl.innerHTML = '';
  listEl.classList.remove('hidden');
  rouletteArea.classList.add('hidden');
  modal.classList.remove('hidden');

  if (isMyEvent) {
    waitMsg.classList.add('hidden');
    targets.forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'btn danger';
      btn.textContent = `🎯 ${t.name} を狙う（所持金: ${t.displayMoney}）`;
      btn.onclick = () => {
        listEl.querySelectorAll('button').forEach(b => (b.disabled = true));
        socket.emit('selectSniperTarget', t.id);
      };
      listEl.appendChild(btn);
    });
  } else {
    waitMsg.textContent = `${actorName}さんが狙う相手を選んでいます...`;
    waitMsg.classList.remove('hidden');
  }
});

socket.on('sniperTargetSelected', ({ actorId, actorName, targetName }) => {
  const isMyEvent = String(actorId) === String(myPlayerId || socket.id);
  const titleEl = document.getElementById('sniper-title');
  const descEl = document.getElementById('sniper-desc');
  const listEl = document.getElementById('sniper-targets-list');
  const rouletteArea = document.getElementById('sniper-roulette-area');
  const slotEl = document.getElementById('sniper-roulette-slot');
  const stopBtn = document.getElementById('btn-stop-sniper');
  const waitMsg = document.getElementById('sniper-wait-msg');

  listEl.classList.add('hidden');
  rouletteArea.classList.remove('hidden');
  titleEl.textContent = `🎯 ターゲット：${targetName} さん！`;
  descEl.textContent = 'ルーレットを止めて奪い取る金額を決めよう！';
  slotEl.className = 'job-slot minus-slot';

  if (isMyEvent) {
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    waitMsg.classList.add('hidden');
  } else {
    stopBtn.classList.add('hidden');
    waitMsg.textContent = `${actorName}さんが狙撃ルーレットを止めています...`;
    waitMsg.classList.remove('hidden');
  }

  let num = 1;
  clearInterval(sniperRouletteInterval);
  sniperRouletteInterval = setInterval(() => {
    slotEl.textContent = `出目 ${num} → $${(num * 2500).toLocaleString()}`;
    num = (num % 6) + 1;
  }, 55);
});

document.getElementById('btn-stop-sniper').onclick = () => {
  document.getElementById('btn-stop-sniper').disabled = true;
  socket.emit('stopSniperRoulette');
};

socket.on('sniperRouletteDecided', ({ roll, stealAmount, targetName }) => {
  clearInterval(sniperRouletteInterval);
  const slotEl = document.getElementById('sniper-roulette-slot');
  slotEl.className = 'job-slot plus-slot';
  slotEl.innerHTML = `🎯 出目「${roll}」命中！！<br><small style="font-size:1.05rem;">${escapeHtml(targetName)}さんから $${stealAmount.toLocaleString()} 奪取！</small>`;
});

socket.on('closeSniperEvent', () => {
  clearInterval(sniperRouletteInterval);
  document.getElementById('sniper-modal').classList.add('hidden');
});

// ========================
// 💀 マイナスルーレット（道連れルーレット）
// ========================
socket.on('startMinusRoulette', ({ actorId, actorName, amounts }) => {
  const currentId = myPlayerId || socket.id;
  const isMyEvent = String(actorId) === String(currentId);

  const modal = document.getElementById('minus-roulette-modal');
  const badge = document.getElementById('minus-actor-badge');
  const titleEl = document.getElementById('minus-roulette-title');
  const descEl = document.getElementById('minus-roulette-desc');
  const slotEl = document.getElementById('minus-roulette-slot');
  const stopBtn = document.getElementById('btn-stop-minus');
  const waitMsg = document.getElementById('minus-wait-msg');

  badge.textContent = `${actorName}さんの道連れルーレット`;
  titleEl.textContent = '💀 ステップ1：マイナス金額決定！';
  descEl.textContent = 'まずは失う金額をルーレットで決めよう！';
  slotEl.className = 'job-slot minus-slot';
  modal.classList.remove('hidden');

  if (isMyEvent) {
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    stopBtn.textContent = '金額をストップ！';
    waitMsg.classList.add('hidden');
  } else {
    stopBtn.classList.add('hidden');
    waitMsg.textContent = `${actorName}さんがマイナス金額を止めています...`;
    waitMsg.classList.remove('hidden');
  }

  const list = amounts && amounts.length ? amounts : [3000, 5000, 10000, 15000, 20000];
  let idx = 0;
  clearInterval(minusRouletteInterval);
  minusRouletteInterval = setInterval(() => {
    slotEl.textContent = `-$${list[idx % list.length].toLocaleString()}`;
    idx++;
  }, 60);
});

document.getElementById('btn-stop-minus').onclick = () => {
  document.getElementById('btn-stop-minus').disabled = true;
  socket.emit('stopMinusRoulette');
};

socket.on('minusRouletteAmountDecided', ({ amount }) => {
  clearInterval(minusRouletteInterval);
  const slotEl = document.getElementById('minus-roulette-slot');
  slotEl.textContent = `-$${amount.toLocaleString()} に決定！`;
});

socket.on('startMinusTargetRoulette', ({ amount, actorId, actorName, players }) => {
  const currentId = myPlayerId || socket.id;
  const isMyEvent = String(actorId) === String(currentId);

  const modal = document.getElementById('minus-roulette-modal');
  const titleEl = document.getElementById('minus-roulette-title');
  const descEl = document.getElementById('minus-roulette-desc');
  const slotEl = document.getElementById('minus-roulette-slot');
  const stopBtn = document.getElementById('btn-stop-minus');
  const waitMsg = document.getElementById('minus-wait-msg');

  modal.classList.remove('hidden');
  titleEl.textContent = '🎯 ステップ2：誰が払うか決定！';
  descEl.textContent = `-$${amount.toLocaleString()} を支払うプレイヤーを決めるぞ！`;
  slotEl.className = 'job-slot';

  if (isMyEvent) {
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    stopBtn.textContent = 'プレイヤーをストップ！';
    waitMsg.classList.add('hidden');
  } else {
    stopBtn.classList.add('hidden');
    waitMsg.textContent = `${actorName}さんが対象プレイヤーを止めています...`;
    waitMsg.classList.remove('hidden');
  }

  const pList = (players && players.length) ? players : (currentRoomState ? currentRoomState.players : []);
  let idx = 0;
  clearInterval(minusRouletteInterval);
  minusRouletteInterval = setInterval(() => {
    if (pList.length > 0) {
      slotEl.textContent = pList[idx % pList.length].name;
      idx++;
    }
  }, 65);
});

socket.on('minusRouletteTargetDecided', ({ targetName, amount }) => {
  clearInterval(minusRouletteInterval);
  const slotEl = document.getElementById('minus-roulette-slot');
  slotEl.className = 'job-slot minus-slot';
  slotEl.innerHTML = `${escapeHtml(targetName)} さん！<br><small style="font-size:1.1rem;">-$${amount.toLocaleString()} 没収！</small>`;
});

socket.on('closeMinusRoulette', () => {
  clearInterval(minusRouletteInterval);
  document.getElementById('minus-roulette-modal').classList.add('hidden');
});

// ========================
// ❓ ？？？マス（プラスorマイナスルーレット）
// ========================
socket.on('startMysteryRoulette', ({ actorId, actorName, items }) => {
  const modal = document.getElementById('mystery-modal');
  const badge = document.getElementById('mystery-actor-badge');
  const slotEl = document.getElementById('mystery-slot');
  const stopBtn = document.getElementById('btn-stop-mystery');
  const waitMsg = document.getElementById('mystery-wait-msg');

  const isMyEvent = String(actorId) === String(myPlayerId || socket.id);
  badge.textContent = `${actorName}さんの？？？ルーレット`;
  slotEl.className = 'job-slot';
  slotEl.style.color = '';
  modal.classList.remove('hidden');

  if (isMyEvent) {
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    waitMsg.classList.add('hidden');
  } else {
    stopBtn.classList.add('hidden');
    waitMsg.textContent = `${actorName}さんが？？？ルーレットを止めています...`;
    waitMsg.classList.remove('hidden');
  }

  let idx = 0;
  clearInterval(mysteryRouletteInterval);
  mysteryRouletteInterval = setInterval(() => {
    const val = items[idx % items.length];
    slotEl.textContent = val;
    slotEl.className = val.startsWith('+') ? 'job-slot plus-slot' : 'job-slot minus-slot';
    idx++;
  }, 60);
});

document.getElementById('btn-stop-mystery').onclick = () => {
  document.getElementById('btn-stop-mystery').disabled = true;
  socket.emit('stopMysteryRoulette');
};

socket.on('mysteryRouletteDecided', ({ label, isWin }) => {
  clearInterval(mysteryRouletteInterval);
  const slotEl = document.getElementById('mystery-slot');
  slotEl.className = isWin ? 'job-slot plus-slot' : 'job-slot minus-slot';
  slotEl.style.color = '';
  slotEl.textContent = `${label} ${isWin ? '獲得！！' : '没収…'}`;
});

socket.on('closeMysteryRoulette', () => {
  clearInterval(mysteryRouletteInterval);
  document.getElementById('mystery-modal').classList.add('hidden');
});

// ========================
// 💎 お宝ルーレットイベント
// ========================
socket.on('startTreasureRoulette', ({ playerId, playerName, treasures }) => {
  const modal = document.getElementById('treasure-modal');
  const badge = document.getElementById('treasure-actor-badge');
  const slotEl = document.getElementById('treasure-slot');
  const stopBtn = document.getElementById('btn-stop-treasure');
  const waitMsg = document.getElementById('treasure-wait-msg');

  const isMyEvent = String(playerId) === String(myPlayerId || socket.id);
  badge.textContent = `${playerName}さんのお宝ルーレット`;
  slotEl.className = 'job-slot treasure-slot';
  modal.classList.remove('hidden');

  if (isMyEvent) {
    stopBtn.classList.remove('hidden');
    stopBtn.disabled = false;
    waitMsg.classList.add('hidden');
  } else {
    stopBtn.classList.add('hidden');
    waitMsg.textContent = `${playerName}さんがお宝ルーレットを止めるのを待っています...`;
    waitMsg.classList.remove('hidden');
  }

  let idx = 0;
  clearInterval(treasureRouletteInterval);
  treasureRouletteInterval = setInterval(() => {
    const name = treasures[idx % treasures.length];
    slotEl.textContent = name;
    slotEl.className = name.includes('呪') ? 'job-slot curse-slot' : 'job-slot treasure-slot';
    idx++;
  }, 65);
});

document.getElementById('btn-stop-treasure').onclick = () => {
  document.getElementById('btn-stop-treasure').disabled = true;
  socket.emit('stopTreasureRoulette');
};

socket.on('treasureDecided', ({ treasure }) => {
  clearInterval(treasureRouletteInterval);
  const slotEl = document.getElementById('treasure-slot');
  const isCursed = treasure.value < 0 || treasure.name.includes('呪');
  slotEl.className = isCursed ? 'job-slot curse-slot' : 'job-slot treasure-slot';
  const valStr = isCursed ? `-$${Math.abs(treasure.value).toLocaleString()}` : `+$${treasure.value.toLocaleString()}`;
  slotEl.innerHTML = `${treasure.name}<br><small style="font-size:1rem;">（決算時 ${valStr}）</small>`;
});

socket.on('closeTreasureRoulette', () => {
  clearInterval(treasureRouletteInterval);
  document.getElementById('treasure-modal').classList.add('hidden');
});

// ========================
// ⚡ クリック連打チャレンジ
// ========================
socket.on('startClickChallenge', ({ playerId, playerName, targetClicks, reward, penalty }) => {
  const modal = document.getElementById('click-modal');
  const badge = document.getElementById('click-actor-badge');
  const ruleText = document.getElementById('click-rule-text');
  const timerEl = document.getElementById('click-timer-display');
  const counterEl = document.getElementById('click-counter-display');
  const tapBtn = document.getElementById('btn-tap-target');
  const waitMsg = document.getElementById('click-wait-msg');

  currentClickTarget = targetClicks;
  const isMyEvent = String(playerId) === String(myPlayerId || socket.id);
  badge.textContent = `${playerName}さんの連打チャレンジ`;
  ruleText.innerHTML = `5秒以内に <strong>${targetClicks}回</strong> タップせよ！<br>成功: <span style="color:#27ae60;">+$${reward.toLocaleString()}</span> ／ 失敗: <span style="color:#e74c3c;">-$${penalty.toLocaleString()}</span>`;
  counterEl.textContent = `0 / ${targetClicks} 回`;
  modal.classList.remove('hidden');

  clearInterval(clickChallengeInterval);

  let prep = 3;
  timerEl.textContent = `開始まで... ${prep}`;

  if (!isMyEvent) {
    tapBtn.classList.add('hidden');
    waitMsg.textContent = `${playerName}さんが連打チャレンジに挑戦中です...（リアルタイム中継中）`;
    waitMsg.classList.remove('hidden');

    clickChallengeInterval = setInterval(() => {
      prep--;
      if (prep > 0) {
        timerEl.textContent = `開始まで... ${prep}`;
      } else {
        clearInterval(clickChallengeInterval);
        let timeLeftMs = 5000;
        timerEl.textContent = `残り 5.0 秒！`;
        clickChallengeInterval = setInterval(() => {
          timeLeftMs -= 100;
          if (timeLeftMs > 0) {
            timerEl.textContent = `残り ${(timeLeftMs / 1000).toFixed(1)} 秒！`;
          } else {
            clearInterval(clickChallengeInterval);
            timerEl.textContent = 'タイムアップ！';
          }
        }, 100);
      }
    }, 1000);
    return;
  }

  waitMsg.classList.add('hidden');
  tapBtn.classList.remove('hidden');
  tapBtn.disabled = true;
  tapBtn.textContent = 'スタート待ち...';

  let clicks = 0;

  tapBtn.onclick = () => {
    if (tapBtn.disabled) return;
    clicks++;
    counterEl.textContent = `${clicks} / ${targetClicks} 回`;
    socket.emit('clickChallengeTap', { clicks });
  };

  clickChallengeInterval = setInterval(() => {
    prep--;
    if (prep > 0) {
      timerEl.textContent = `開始まで... ${prep}`;
    } else {
      clearInterval(clickChallengeInterval);
      tapBtn.disabled = false;
      tapBtn.textContent = '連打しろ！！🔥';

      let timeLeftMs = 5000;
      timerEl.textContent = `残り 5.0 秒！`;

      clickChallengeInterval = setInterval(() => {
        timeLeftMs -= 100;
        if (timeLeftMs > 0) {
          timerEl.textContent = `残り ${(timeLeftMs / 1000).toFixed(1)} 秒！`;
        } else {
          clearInterval(clickChallengeInterval);
          tapBtn.disabled = true;
          tapBtn.textContent = '終了！';
          timerEl.textContent = 'タイムアップ！';
          socket.emit('submitClickChallenge', { clicks });
        }
      }, 100);
    }
  }, 1000);
});

socket.on('clickChallengeProgress', ({ clicks }) => {
  const counterEl = document.getElementById('click-counter-display');
  if (counterEl) {
    counterEl.textContent = `${clicks} / ${currentClickTarget} 回`;
  }
});

socket.on('closeClickChallenge', () => {
  clearInterval(clickChallengeInterval);
  document.getElementById('click-modal').classList.add('hidden');
});

// ========================
// 🎲 全員参加ダイスミニゲーム
// ========================
function renderDiceMinigameParticipants(participants, currentRollerId) {
  const currentId = myPlayerId || socket.id;
  const listEl = document.getElementById('dice-mg-list');
  listEl.innerHTML = participants.map(p => {
    let statusHtml = '順番待ち...';
    if (p.roll !== null) {
      statusHtml = `<strong style="font-size:1.1rem; color:#1e3c72;">出目: ${p.roll}</strong>${p.rank ? `（${p.rank}位 +$${p.prize.toLocaleString()}）` : ''}`;
    } else if (String(p.id) === String(currentRollerId)) {
      statusHtml = `<span style="color:#e67e22; font-weight:bold;">🎲 サイコロ待機中！</span>`;
    }
    return `
      <div class="job-status-item" style="${String(p.id) === String(currentRollerId) ? 'border:2px solid #f39c12; background:#fef9e7;' : ''}">
        <span><i class="color-dot" style="background:${p.color}"></i>${escapeHtml(p.name)}</span>
        <span>${statusHtml}</span>
      </div>
    `;
  }).join('');

  const rollBtn = document.getElementById('btn-roll-mg-dice');
  if (String(currentRollerId) === String(currentId)) {
    rollBtn.disabled = false;
    rollBtn.textContent = '🎲 あなたの番！サイコロを振る！';
  } else {
    rollBtn.disabled = true;
    const roller = participants.find(p => String(p.id) === String(currentRollerId));
    rollBtn.textContent = roller ? `${roller.name}さんが振るのを待っています...` : '結果集計中...';
  }
}

socket.on('startDiceMinigame', ({ entryFee, prizes, participants, currentRollerId }) => {
  const modal = document.getElementById('dice-minigame-modal');
  const infoEl = document.getElementById('dice-mg-info');
  const prizesEl = document.getElementById('dice-mg-prizes');
  const slotEl = document.getElementById('dice-mg-slot');

  infoEl.textContent = `全員から参加費 $${entryFee.toLocaleString()} を徴収！出目が大きい順に賞金分配！`;
  prizesEl.textContent = prizes.map((pr, i) => `${i + 1}位: +$${pr.toLocaleString()}`).join(' / ');
  slotEl.textContent = '?';

  renderDiceMinigameParticipants(participants, currentRollerId);
  modal.classList.remove('hidden');
});

document.getElementById('btn-roll-mg-dice').onclick = () => {
  document.getElementById('btn-roll-mg-dice').disabled = true;
  socket.emit('rollMinigameDice');
};

socket.on('diceMinigameRolled', ({ roll }) => {
  clearInterval(diceMgRollInterval);
  const slotEl = document.getElementById('dice-mg-slot');
  let n = 1;
  diceMgRollInterval = setInterval(() => {
    n = (n % 6) + 1;
    slotEl.textContent = n;
  }, 50);

  setTimeout(() => {
    clearInterval(diceMgRollInterval);
    slotEl.textContent = roll;
  }, 1100);
});

socket.on('diceMinigameNextRoller', ({ participants, currentRollerId }) => {
  renderDiceMinigameParticipants(participants, currentRollerId);
});

socket.on('diceMinigameResult', ({ results }) => {
  renderDiceMinigameParticipants(results, null);
  document.getElementById('btn-roll-mg-dice').textContent = '🏆 順位確定！賞金を分配しました！';
});

socket.on('closeDiceMinigame', () => {
  clearInterval(diceMgRollInterval);
  document.getElementById('dice-minigame-modal').classList.add('hidden');
});

// ========================
// ターン通知・結果バナー
// ========================
socket.on('yourTurnNotice', ({ isGoalBonus, isInJail, bombTurns }) => {
  const toast = document.getElementById('your-turn-toast');
  if (isGoalBonus) {
    toast.textContent = '🌟 あなたの番です！（ゴール済みボーナスルーレット）';
  } else if (bombTurns > 0) {
    toast.textContent = `💣 爆弾所持中（残り${bombTurns}ターン）！誰かに移せ！`;
  } else if (isInJail) {
    toast.textContent = '🔒 収監中！ルーレットで「5以上」を出して出所しよう！';
  } else {
    toast.textContent = '🎯 あなたの番です！ルーレットを回してください！';
  }
  toast.classList.remove('hidden');

  clearTimeout(turnToastTimeout);
  turnToastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 1800);
});

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
  const isMyTurn = activePlayer && activePlayer.id === (myPlayerId || socket.id);

  const statusBar = document.getElementById('players-status-bar');
  statusBar.innerHTML = '';
  state.players.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = `player-card ${idx === state.turnIndex ? 'active-turn' : ''}`;
    div.style.borderLeftColor = p.color;

    let statusBadge = `P${idx + 1}`;
    if (p.finished) statusBadge = 'GOAL済';
    else if (p.bombTurns > 0) statusBadge = `💣残${p.bombTurns}`;
    else if (p.inJail) statusBadge = '🔒収監中';
    else if (p.skipTurns > 0) statusBadge = '🤒休み中';

    div.innerHTML = `
      <div class="p-header">
        <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
          <span class="p-name-tag" style="background:${p.color}">${escapeHtml(p.name)}</span>
          <span class="p-job">「${p.job.currentName}」</span>
        </div>
        <span class="p-badge">${statusBadge}</span>
      </div>
      <div class="p-money ${p.isNegative ? 'negative' : ''}">${p.displayMoney}</div>
      <div class="p-sub">物件:${p.properties.length} / お宝:${p.treasures.length} / ${p.married ? '既婚' : '独身'}${p.childrenCount > 0 ? `(子${p.childrenCount})` : ''}</div>
    `;
    statusBar.appendChild(div);
  });

  const turnLabel = document.getElementById('current-turn-label');
  const turnPanelBox = document.getElementById('turn-panel-box');
  const myTurnBadge = document.getElementById('my-turn-badge');

  if (activePlayer.finished) {
    turnLabel.textContent = `${activePlayer.name}さん（ゴールボーナス）`;
  } else if (activePlayer.bombTurns > 0) {
    turnLabel.textContent = `${activePlayer.name}さん（💣爆弾残り${activePlayer.bombTurns}ターン）`;
  } else if (activePlayer.inJail) {
    turnLabel.textContent = `${activePlayer.name}さん（🔒刑務所・5以上で出所）`;
  } else {
    turnLabel.textContent = `${activePlayer.name}さんのターン`;
  }
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
      `<span class="token" style="background:${p.color}">${p.bombTurns > 0 ? '💣' : ''}${escapeHtml(p.name)}</span>`
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

  const isMyEvent = String(data.playerId) === String(myPlayerId || socket.id);
  actorBadge.textContent = `${data.playerName}さんのマスイベント`;
  choicesEl.innerHTML = '';
  modal.classList.remove('hidden');

  if (isMyEvent) {
    waitMsg.classList.add('hidden');
  } else {
    waitMsg.textContent = `${data.playerName}さんが回答・選択中です...`;
    waitMsg.classList.remove('hidden');
  }

  if (data.type === 'GAMBLE') {
    titleEl.textContent = '🎰 運命のハイリスク・ハイリターンギャンブル！';
    if (data.isNegative) {
      descEl.innerHTML = `
        現在の所持金：<strong style="color:#e74c3c;">${data.formattedMoney}（マイナス状態）</strong><br>
        1/2の確率で運命が分かれる！挑戦しますか？<br>
        <span style="color:#27ae60; font-weight:bold;">⭕ 成功（50%）：所持金が $0（借金チャラ）になる！</span><br>
        <span style="color:#e74c3c; font-weight:bold;">❌ 失敗（50%）：借金が倍増（-$${(Math.abs(data.currentMoney) * 2).toLocaleString()}）になる！</span>
      `;
    } else if (data.isZero) {
      descEl.innerHTML = `
        現在の所持金：<strong>$0</strong><br>
        1/2の確率で運命が分かれる！挑戦しますか？<br>
        <span style="color:#27ae60; font-weight:bold;">⭕ 成功（50%）：所持金が2倍（$0 → $0）</span><br>
        <span style="color:#e74c3c; font-weight:bold;">❌ 失敗（50%）：所持金が $0 になる</span>
      `;
    } else {
      descEl.innerHTML = `
        現在の所持金：<strong style="color:#27ae60;">${data.formattedMoney}</strong><br>
        1/2の確率で運命が分かれる！挑戦しますか？<br>
        <span style="color:#27ae60; font-weight:bold;">⭕ 成功（50%）：所持金が2倍（$${(data.currentMoney * 2).toLocaleString()}）になる！</span><br>
        <span style="color:#e74c3c; font-weight:bold;">❌ 失敗（50%）：所持金がすべて没収され $0 になる！</span>
      `;
    }

    if (isMyEvent) {
      choicesEl.innerHTML = `
        <button class="btn danger" onclick="sendChoice('PLAY')">🎰 ギャンブルに挑戦する！</button>
        <button class="btn secondary" onclick="sendChoice('DECLINE')">やめておく（見送る）</button>
      `;
    }
  } else if (data.type === 'BRANCH') {
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
    const treasureText = r.treasureValue < 0
      ? `-$${Math.abs(r.treasureValue).toLocaleString()}`
      : `$${r.treasureValue.toLocaleString()}`;

    item.innerHTML = `
      <div>
        <strong>第${actualRank}位：${escapeHtml(r.name)}</strong>（${r.job}）<br>
        <small>所持金 ${r.formattedCash} ＋ 物件 $${r.propertyValue.toLocaleString()} ＋ お宝 ${treasureText} ＋ 家族 $${r.familyBonus.toLocaleString()}</small>
      </div>
      <div style="font-size:1.2rem; font-weight:bold; color:${r.totalAssets < 0 ? '#c0392b' : '#27ae60'};">
        ${r.formattedTotal}
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

function hideAllEventModals() {
  clearInterval(treasureRouletteInterval);
  clearInterval(minusRouletteInterval);
  clearInterval(mysteryRouletteInterval);
  clearInterval(sniperRouletteInterval);
  clearInterval(diceMgRollInterval);
  clearInterval(clickChallengeInterval);
  document.getElementById('sniper-modal').classList.add('hidden');
  document.getElementById('treasure-modal').classList.add('hidden');
  document.getElementById('minus-roulette-modal').classList.add('hidden');
  document.getElementById('mystery-modal').classList.add('hidden');
  document.getElementById('click-modal').classList.add('hidden');
  document.getElementById('dice-minigame-modal').classList.add('hidden');
  document.getElementById('event-modal').classList.add('hidden');
}

socket.on('closeAllEventModals', hideAllEventModals);

socket.on('forceReturnLobby', (msg) => {
  clearInterval(rouletteInterval);
  clearInterval(jobRouletteInterval);
  clearTimeout(turnToastTimeout);
  hideAllEventModals();
  document.getElementById('countdown-overlay').classList.add('hidden');
  document.getElementById('job-roulette-modal').classList.add('hidden');
  document.getElementById('result-banner-overlay').classList.add('hidden');
  document.getElementById('your-turn-toast').classList.add('hidden');
  currentRoomState = null;
  alert(msg);
  showScreen('lobby-screen');
});
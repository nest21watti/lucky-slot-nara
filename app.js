// =========================================================================
// Pokémon GO 奈良 打刻Web Luckyスロット【app.js 完全版】
// =========================================================================

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // 定数・ローカルストレージキー
  // -----------------------------------------------------------------------
  var LS_KEYS = {
    APPS: 'POGO_NARA_GAS_APPS_V2',
    ACTIVE_APP_ID: 'POGO_NARA_ACTIVE_APP_ID_V2',
    LEGACY_URL: 'POGO_NARA_GAS_URL',
    MUTE: 'POGO_NARA_SOUND_MUTE_V1',
    REEL_STYLE_CACHE: 'POGO_NARA_REEL_STYLE_V1'
  };

  var POLL_INTERVAL_MS = 5000;
  var SLOT_SYMBOLS = ['7️⃣', '🌸', '💳', '🔔', '🍇', '🍒'];
  var PENALTY_SYMBOLS = ['💀', '💣', '🚫', '⚡', '😱'];

  // -----------------------------------------------------------------------
  // アプリ状態
  // -----------------------------------------------------------------------
  var state = {
    apps: [],
    activeAppId: '',
    gasUrl: '',
    ssName: '',
    hash: '',
    rows: [],
    fList: [],
    gList: [],
    destUrls: {},
    settings: {
      highlightColor: '#fff9b1',
      slotEnabled: true,
      slotMode: 'normal',
      normalProb: { seven: 5, sakura: 10, bar: 15, bell: 0, grape: 0, cherry: 0 },
      fairProb: { seven: 5, sakura: 10, bar: 15, bell: 0, grape: 0, cherry: 0 },
      fairLimit: 1,
      jackpotTarget: 'both',
      penaltyMode: 'random',
      slotDelayMs: 0,
      slotCooldownMs: 1000,
      pauseSeconds: 15,
      fLabel: '色違',
      gLabel: 'Evnt',
      reelStyle: 'legacy',
      customLinks: [],
      sounds: { spin: 'basic', ok: 'basic', win: 'basic', fanfare: 'basic', buzzer: 'basic' }
    },
    isConnected: false,
    isSubmittingScan: false,
    isRefreshingCache: false,
    isCooldown: false,
    isSlotSpinning: false,
    hasUnconfirmedAlert: false,
    alertRows: [],
    // 画面回転モード（端末一時状態：起動時は常に normal）
    screenRotationMode: 'normal', // 'normal' | 'face' | 'full'
    // 自動更新制御
    pollTimerId: null,
    pauseUntil: 0,
    manualPaused: false,
    // 音声ミュート
    muted: false,
    // スロット履歴モーダル
    slotHistoryCache: null,
    slotHistorySort: 'order',
    // スロット演出タイマー管理
    spinIntervalId: null,
    pendingStopTimers: [],
    cooldownTimerId: null,
    currentSpinResolve: null,
    pendingScanResponse: null
  };

  // -----------------------------------------------------------------------
  // ユーティリティ
  // -----------------------------------------------------------------------
  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clampNum(val, min, max, def) {
    var n = parseFloat(val);
    if (isNaN(n)) return def;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  var toastTimer = null;
  function showToast(msg, durationMs) {
    var el = $('toast');
    if (!el) return;
    el.textContent = String(msg || '');
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, durationMs || 2600);
  }

  function isLightColor(hex) {
    var c = String(hex || '').replace('#', '').trim();
    if (c.length !== 6) return false;
    var r = parseInt(c.substring(0, 2), 16);
    var g = parseInt(c.substring(2, 4), 16);
    var b = parseInt(c.substring(4, 6), 16);
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 160;
  }

  function applyHeaderTheme(hexColor) {
    var header = $('app-header');
    if (!header) return;
    var color = /^#[0-9a-fA-F]{6}$/.test(String(hexColor || '')) ? hexColor : '#1e3a8a';
    var light = isLightColor(color);
    header.style.background = color;
    header.style.color = light ? '#0f172a' : '#ffffff';

    var connBtn = $('conn-btn');
    var rotBtn = $('rotate-btn');
    if (connBtn && !connBtn.classList.contains('disconnected')) {
      connBtn.style.color = light ? '#0f172a' : '#ffffff';
      connBtn.style.background = light ? 'rgba(15, 23, 42, 0.10)' : 'rgba(255, 255, 255, 0.18)';
      connBtn.style.borderColor = light ? 'rgba(15, 23, 42, 0.35)' : 'rgba(255, 255, 255, 0.55)';
    }
    if (rotBtn && state.screenRotationMode === 'normal') {
      rotBtn.style.color = light ? '#0f172a' : '#ffffff';
      rotBtn.style.background = light ? 'rgba(15, 23, 42, 0.10)' : 'rgba(255, 255, 255, 0.16)';
      rotBtn.style.borderColor = light ? 'rgba(15, 23, 42, 0.35)' : 'rgba(255, 255, 255, 0.55)';
    }
  }

  // -----------------------------------------------------------------------
  // Web Audio API 効果音エンジン（外部ファイル不要）
  // -----------------------------------------------------------------------
  var audioCtx = null;

  function ensureAudioCtx() {
    if (state.muted) return null;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function playTone(freq, startOffset, duration, type, gainVal) {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      var now = ctx.currentTime + (startOffset || 0);
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(gainVal || 0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch (e) {}
  }

  function playSoundPreset(kind) {
    if (state.muted) return;
    var sounds = (state.settings && state.settings.sounds) || {};
    var preset = sounds[kind] || 'basic';
    if (preset === 'off') return;

    var wave = preset === 'arcade' ? 'square' : (preset === 'soft' ? 'triangle' : 'sine');
    var vol = preset === 'arcade' ? 0.07 : 0.13;

    if (kind === 'spin') {
      playTone(440, 0, 0.05, wave, vol * 0.7);
      playTone(554, 0.05, 0.05, wave, vol * 0.7);
    } else if (kind === 'ok') {
      playTone(660, 0, 0.06, wave, vol);
    } else if (kind === 'win') {
      playTone(523.25, 0.00, 0.12, wave, vol);
      playTone(659.25, 0.10, 0.12, wave, vol);
      playTone(783.99, 0.20, 0.16, wave, vol);
      playTone(1046.5, 0.32, 0.28, wave, vol);
    } else if (kind === 'fanfare') {
      var notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
      var times = [0.00, 0.09, 0.18, 0.27, 0.42, 0.52, 0.64];
      var durs  = [0.08, 0.08, 0.08, 0.13, 0.08, 0.10, 0.42];
      for (var i = 0; i < notes.length; i++) {
        playTone(notes[i], times[i], durs[i], wave, vol * 1.1);
      }
    } else if (kind === 'buzzer') {
      playTone(190, 0.00, 0.18, 'sawtooth', 0.10);
      playTone(150, 0.20, 0.26, 'sawtooth', 0.10);
    }
  }

  function updateMuteButtonUI() {
    var btn = $('mute-btn');
    if (!btn) return;
    if (state.muted) {
      btn.textContent = '🔇 消音中';
      btn.classList.add('mute-on');
    } else {
      btn.textContent = '🔊 音声ON';
      btn.classList.remove('mute-on');
    }
  }

  function toggleSoundMute() {
    state.muted = !state.muted;
    try { localStorage.setItem(LS_KEYS.MUTE, state.muted ? '1' : '0'); } catch (e) {}
    updateMuteButtonUI();
    if (!state.muted) {
      ensureAudioCtx();
      playSoundPreset('ok');
    }
    showToast(state.muted ? '🔇 効果音をOFFにしました' : '🔊 効果音をONにしました', 1600);
  }

  // -----------------------------------------------------------------------
  // 180°画面回転切替（通常 → 対面モード → 全体180°反転）
  // -----------------------------------------------------------------------
  function applyScreenRotationUI() {
    var body = document.body;
    var btn = $('rotate-btn');
    body.classList.remove('flip-face', 'flip-full');
    if (btn) {
      btn.classList.remove('mode-face', 'mode-full');
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    }

    if (state.screenRotationMode === 'face') {
      body.classList.add('flip-face');
      if (btn) btn.classList.add('mode-face');
    } else if (state.screenRotationMode === 'full') {
      body.classList.add('flip-full');
      if (btn) btn.classList.add('mode-full');
    } else {
      applyHeaderTheme(state.settings.highlightColor);
    }

    if (typeof window.syncCameraPanelState === 'function') {
      window.syncCameraPanelState();
    }
  }

  function cycleScreenRotation() {
    if (state.screenRotationMode === 'normal') {
      state.screenRotationMode = 'face';
      applyScreenRotationUI();
      showToast('🔁 対面モード（スロット＆結果のみ180°反転）', 2400);
    } else if (state.screenRotationMode === 'face') {
      state.screenRotationMode = 'full';
      applyScreenRotationUI();
      showToast('🔁 全体180°反転（セルフ打刻台用）', 2400);
    } else {
      state.screenRotationMode = 'normal';
      applyScreenRotationUI();
      showToast('🔁 通常表示に戻しました', 2000);
    }
  }

  // -----------------------------------------------------------------------
  // GAS API 通信共通関数
  // -----------------------------------------------------------------------
  async function callGasApi(action, args, customUrl) {
    var url = customUrl || state.gasUrl;
    if (!url) {
      throw new Error('接続先GAS URLが未設定です。右上の「🔌 未接続」から設定してください。');
    }

    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, args: args || [] }),
      redirect: 'follow'
    });

    if (!res.ok) {
      throw new Error('通信エラー (HTTP ' + res.status + ')');
    }
    var text = await res.text();
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('GASからの応答を解析できませんでした（デプロイ権限をご確認ください）。');
    }
    if (!json.ok) {
      throw new Error(json.error || 'GAS側でエラーが発生しました。');
    }
    return json.data;
  }

  // -----------------------------------------------------------------------
  // 接続先GASアプリ管理（複数アプリ切替＋共有URL対応）
  // -----------------------------------------------------------------------
  function loadAppRegistry() {
    var apps = [];
    try {
      var raw = localStorage.getItem(LS_KEYS.APPS);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) apps = parsed;
      }
    } catch (e) {}

    // 旧キーからの移行
    if (apps.length === 0) {
      try {
        var oldUrl = localStorage.getItem(LS_KEYS.LEGACY_URL);
        if (oldUrl && oldUrl.indexOf('http') === 0) {
          apps.push({
            id: 'app_' + Date.now(),
            name: '登録済みアプリ',
            url: oldUrl.trim(),
            color: '#fff9b1'
          });
        }
      } catch (e) {}
    }

    var activeId = '';
    try { activeId = localStorage.getItem(LS_KEYS.ACTIVE_APP_ID) || ''; } catch (e) {}

    // URLクエリ (?gas=...&name=...) によるワンタップ登録対応
    try {
      var params = new URLSearchParams(window.location.search);
      var qGas = (params.get('gas') || '').trim();
      var qName = (params.get('name') || '').trim();
      if (qGas && /^https:\/\/script\.google\.com\/macros\/s\//.test(qGas)) {
        var existing = apps.find(function (a) { return a.url === qGas; });
        if (existing) {
          if (qName) existing.name = qName;
          activeId = existing.id;
        } else {
          var newEntry = {
            id: 'app_' + Date.now(),
            name: qName || '共有アプリ',
            url: qGas,
            color: '#fff9b1'
          };
          apps.push(newEntry);
          activeId = newEntry.id;
        }
        // URLのクエリをきれいに戻す
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    } catch (e) {}

    state.apps = apps;
    if (activeId && apps.some(function (a) { return a.id === activeId; })) {
      state.activeAppId = activeId;
    } else if (apps.length > 0) {
      state.activeAppId = apps[0].id;
    } else {
      state.activeAppId = '';
    }

    var activeApp = getActiveApp();
    state.gasUrl = activeApp ? activeApp.url : '';
    saveAppRegistry();
  }

  function saveAppRegistry() {
    try {
      localStorage.setItem(LS_KEYS.APPS, JSON.stringify(state.apps));
      localStorage.setItem(LS_KEYS.ACTIVE_APP_ID, state.activeAppId || '');
    } catch (e) {}
  }

  function getActiveApp() {
    return state.apps.find(function (a) { return a.id === state.activeAppId; }) || null;
  }

  function updateConnectionBadge(connected) {
    state.isConnected = !!connected;
    var btn = $('conn-btn');
    if (!btn) return;
    if (connected) {
      btn.textContent = '🔌 接続済';
      btn.classList.remove('disconnected');
      applyHeaderTheme(state.settings.highlightColor);
    } else {
      btn.textContent = '🔌 未接続';
      btn.classList.add('disconnected');
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    }
  }

  function renderAppRegistryList() {
    var listEl = $('app-registry-list');
    if (!listEl) return;
    if (state.apps.length === 0) {
      listEl.innerHTML = '<div class="sub-note">まだGASアプリが登録されていません。下の欄からURLを登録してください。</div>';
      return;
    }

    var html = state.apps.map(function (app) {
      var isAct = app.id === state.activeAppId;
      return (
        '<div class="app-switch-item ' + (isAct ? 'active' : '') + '">' +
          '<span class="app-color-dot" style="background:' + escapeHtml(app.color || '#fff9b1') + ';"></span>' +
          '<div class="app-switch-info" onclick="selectRegisteredApp(\'' + escapeHtml(app.id) + '\')">' +
            '<div class="app-switch-name">' + (isAct ? '✅ ' : '') + escapeHtml(app.name || '名称未設定') + '</div>' +
            '<div class="app-switch-sub">' + escapeHtml(app.url) + '</div>' +
          '</div>' +
          '<div class="app-switch-acts">' +
            '<button type="button" class="app-mini-act" title="名前変更" onclick="renameRegisteredApp(\'' + escapeHtml(app.id) + '\')">✏️</button>' +
            '<button type="button" class="app-mini-act del" title="削除" onclick="deleteRegisteredApp(\'' + escapeHtml(app.id) + '\')">🗑️</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    listEl.innerHTML = html;
  }

  function openGasUrlModal() {
    renderAppRegistryList();
    var active = getActiveApp();
    $('gas-url-input').value = active ? active.url : '';
    $('gas-app-name-input').value = active ? active.name : '';
    $('gas-conn-msg').textContent = '';
    openModal('modal-gas-url');
  }

  async function saveAndTestGasUrl() {
    var url = ($('gas-url-input').value || '').trim();
    var customName = ($('gas-app-name-input').value || '').trim();
    var msgEl = $('gas-conn-msg');

    if (!url || !/^https:\/\/script\.google\.com\/macros\/s\//.test(url)) {
      msgEl.style.color = '#dc2626';
      msgEl.textContent = '⚠️ 有効なGASウェブアプリURL（https://script.google.com/macros/s/.../exec）を入力してください。';
      return;
    }

    msgEl.style.color = '#1d4ed8';
    msgEl.textContent = '⏳ 接続テスト＆キャッシュ最新化中…';

    try {
      var pingRes = await callGasApi('ping', [], url);
      var finalName = customName || (pingRes && pingRes.ssName) || '打刻アプリ';

      var existing = state.apps.find(function (a) { return a.url === url; });
      if (existing) {
        existing.name = finalName;
        state.activeAppId = existing.id;
      } else {
        var newItem = {
          id: 'app_' + Date.now(),
          name: finalName,
          url: url,
          color: '#fff9b1'
        };
        state.apps.push(newItem);
        state.activeAppId = newItem.id;
      }
      state.gasUrl = url;
      state.hash = '';
      saveAppRegistry();
      renderAppRegistryList();

      await refreshCachesAndDashboard(true);
      msgEl.style.color = '#16a34a';
      msgEl.textContent = '✅ 接続成功：' + finalName;
      closeModal('modal-gas-url');
      showToast('✅ 接続＆最新化完了：' + finalName);
    } catch (err) {
      msgEl.style.color = '#dc2626';
      msgEl.textContent = '❌ 接続失敗：' + err.message;
    }
  }

  async function selectRegisteredApp(appId) {
    var found = state.apps.find(function (a) { return a.id === appId; });
    if (!found) return;
    state.activeAppId = found.id;
    state.gasUrl = found.url;
    state.hash = '';
    saveAppRegistry();
    renderAppRegistryList();
    closeModal('modal-gas-url');
    showToast('🔄 アプリ切替中：' + found.name);
    await refreshCachesAndDashboard(false);
  }

  function renameRegisteredApp(appId) {
    var found = state.apps.find(function (a) { return a.id === appId; });
    if (!found) return;
    var nextName = prompt('アプリの表示名を入力してください', found.name || '');
    if (nextName === null) return;
    found.name = nextName.trim() || found.name;
    saveAppRegistry();
    renderAppRegistryList();
  }

  function deleteRegisteredApp(appId) {
    var found = state.apps.find(function (a) { return a.id === appId; });
    if (!found) return;
    if (!confirm('「' + found.name + '」を端末のリストから削除しますか？（スプレッドシート本体は消えません）')) return;
    state.apps = state.apps.filter(function (a) { return a.id !== appId; });
    if (state.activeAppId === appId) {
      state.activeAppId = state.apps.length > 0 ? state.apps[0].id : '';
      state.gasUrl = state.apps.length > 0 ? state.apps[0].url : '';
      state.hash = '';
    }
    saveAppRegistry();
    renderAppRegistryList();
    if (state.gasUrl) {
      refreshCachesAndDashboard(true);
    } else {
      updateConnectionBadge(false);
    }
  }

  function clearSavedGasUrl() {
    if (!confirm('この端末に保存されているGAS接続先リストをすべて消去しますか？')) return;
    state.apps = [];
    state.activeAppId = '';
    state.gasUrl = '';
    state.hash = '';
    saveAppRegistry();
    renderAppRegistryList();
    updateConnectionBadge(false);
    showToast('🗑️ 接続設定を消去しました');
  }

  async function copyShareSetupLink() {
    var active = getActiveApp();
    var url = ($('gas-url-input').value || (active && active.url) || '').trim();
    var name = ($('gas-app-name-input').value || (active && active.name) || '').trim();
    if (!url) {
      showToast('⚠️ 先にGAS URLを入力してください');
      return;
    }
    var base = window.location.origin + window.location.pathname;
    var share = base + '?gas=' + encodeURIComponent(url) + (name ? '&name=' + encodeURIComponent(name) : '');
    try {
      await navigator.clipboard.writeText(share);
      showToast('🔗 共有用URLをコピーしました！');
    } catch (e) {
      prompt('以下のURLをコピーして共有してください', share);
    }
  }

  // -----------------------------------------------------------------------
  // タブ＆モーダル制御
  // -----------------------------------------------------------------------
  function switchTab(tabName) {
    var isMain = tabName === 'main';
    $('page-main').classList.toggle('active', isMain);
    $('page-settings').classList.toggle('active', !isMain);
    $('tab-btn-main').classList.toggle('active', isMain);
    $('tab-btn-settings').classList.toggle('active', !isMain);
    if (isMain && !state.hasUnconfirmedAlert) {
      focusScanInputSafe();
    }
  }

  function openModal(id) {
    var el = $(id);
    if (el) el.classList.add('open');
  }

  function closeModal(id) {
    var el = $(id);
    if (el) el.classList.remove('open');
  }

  function focusScanInputSafe() {
    var input = $('scan-input');
    if (!input || input.disabled) return;
    // カメラQR起動中やモーダル開中は強制フォーカスしない
    if (typeof window.isCameraQrRunning === 'function' && window.isCameraQrRunning()) return;
    if (document.querySelector('.modal-backdrop.open')) return;
    try { input.focus({ preventScroll: true }); } catch (e) {}
  }

  // -----------------------------------------------------------------------
  // キャッシュ一括最新化（起動時 ＆ 手動ボタン2か所共通）
  // -----------------------------------------------------------------------
  function setRefreshButtonsDisabled(disabled) {
    var mini = $('cache-refresh-mini-btn');
    var hero = $('cache-refresh-hero-btn');
    if (mini) {
      mini.disabled = !!disabled;
      mini.textContent = disabled ? '⏳ 更新中' : '🔄 最新化';
    }
    if (hero) {
      hero.disabled = !!disabled;
    }
  }

  async function refreshCachesAndDashboard(silentToast) {
    if (!state.gasUrl) {
      updateConnectionBadge(false);
      return false;
    }
    if (state.isRefreshingCache) return false;
    state.isRefreshingCache = true;
    setRefreshButtonsDisabled(true);

    try {
      var res = await callGasApi('refreshAllCaches', []);
      if (res && res.dashboard) {
        applyDashboardData(res.dashboard);
      }
      updateConnectionBadge(true);

      var summaryText = '名簿 ' + (res.memberCount || 0) + '件 / 当選者 ' + (res.winnerCount || 0) + '件（' + (res.updatedAt || '') + ' 更新・6時間保持）';
      var noteEl = $('cache-status-note');
      if (noteEl) {
        noteEl.textContent = '✅ 最終キャッシュ更新：' + summaryText;
      }
      if (!silentToast) {
        showToast('✅ 最新化完了：名簿' + (res.memberCount || 0) + '件 / 当選者' + (res.winnerCount || 0) + '件', 2600);
      }
      return true;
    } catch (err) {
      updateConnectionBadge(false);
      if (!silentToast) {
        showToast('❌ 最新化に失敗：' + err.message, 3200);
      }
      return false;
    } finally {
      state.isRefreshingCache = false;
      setRefreshButtonsDisabled(false);
    }
  }

  async function triggerManualCacheRefresh() {
    if (!state.gasUrl) {
      openGasUrlModal();
      return;
    }
    if (state.isSubmittingScan || state.isSlotSpinning) {
      showToast('⏳ 打刻・スロット処理が終わってから押してください', 2000);
      return;
    }
    if (state.hasUnconfirmedAlert) {
      showToast('🚨 未確認のアラートを「確」にしてから実行してください', 2200);
      return;
    }
    await refreshCachesAndDashboard(false);
  }

  // -----------------------------------------------------------------------
  // 自動更新ポーリング（5秒間隔・操作後一時停止カウントダウン対応）
  // -----------------------------------------------------------------------
  function pauseAutoPollByAction() {
    var sec = clampNum(state.settings.pauseSeconds, 5, 120, 15);
    state.pauseUntil = Date.now() + sec * 1000;
    updatePollStatusUI();
  }

  function toggleAutoPollPause() {
    if (state.manualPaused) {
      state.manualPaused = false;
      state.pauseUntil = 0;
      updatePollStatusUI();
      pollDashboardOnce(false);
      showToast('🟢 自動更新を再開しました', 1600);
    } else if (state.pauseUntil > Date.now()) {
      state.pauseUntil = 0;
      updatePollStatusUI();
      pollDashboardOnce(false);
      showToast('🟢 一時停止を解除して即時更新しました', 1600);
    } else {
      state.manualPaused = true;
      updatePollStatusUI();
      showToast('⏸️ 自動更新を一時停止しました', 1600);
    }
  }

  function updatePollStatusUI() {
    var btn = $('poll-status-btn');
    if (!btn) return;
    if (!state.isConnected) {
      btn.textContent = '⚪ 未接続';
      btn.className = 'sync-pill';
      return;
    }
    if (state.manualPaused) {
      btn.textContent = '⏸️ 停止中（タップ再開）';
      btn.className = 'sync-pill paused';
      return;
    }
    var remMs = state.pauseUntil - Date.now();
    if (remMs > 0) {
      var remSec = Math.ceil(remMs / 1000);
      btn.textContent = '⏸️ 待機 ' + remSec + '秒';
      btn.className = 'sync-pill paused';
      return;
    }
    btn.textContent = '🟢 自動更新中';
    btn.className = 'sync-pill running';
  }

  async function pollDashboardOnce(forceFull) {
    if (!state.gasUrl || state.isSubmittingScan || state.isRefreshingCache || state.isSlotSpinning) return;
    if (!forceFull && (state.manualPaused || state.pauseUntil > Date.now())) return;
    if (document.hidden) return;

    try {
      var data = await callGasApi('getDashboardState', [forceFull ? '' : state.hash, false]);
      updateConnectionBadge(true);
      if (data && !data.unchanged) {
        applyDashboardData(data);
      }
    } catch (e) {
      // 通信の一時揺れは次回ポーリングで自然復帰させる
    }
  }

  function startPollingLoop() {
    if (state.pollTimerId) clearInterval(state.pollTimerId);
    setInterval(updatePollStatusUI, 1000);
    state.pollTimerId = setInterval(function () {
      pollDashboardOnce(false);
    }, POLL_INTERVAL_MS);
  }

  // -----------------------------------------------------------------------
  // ダッシュボード描画（ログ・直近確認・🚨ロック・2ページ目設定反映）
  // -----------------------------------------------------------------------
  function applyDashboardData(data) {
    if (!data) return;
    if (data.hash) state.hash = data.hash;
    if (data.ssName) state.ssName = data.ssName;
    if (Array.isArray(data.rows)) state.rows = data.rows;
    if (Array.isArray(data.fList)) state.fList = data.fList;
    if (Array.isArray(data.gList)) state.gList = data.gList;
    if (data.destUrls) state.destUrls = data.destUrls;
    if (data.settings) {
      state.settings = Object.assign({}, state.settings, data.settings);
      try {
        localStorage.setItem(LS_KEYS.REEL_STYLE_CACHE, state.settings.reelStyle || 'legacy');
      } catch (e) {}
    }

    // 登録アプリの色・名前を最新化
    var active = getActiveApp();
    if (active) {
      if (state.settings.highlightColor) active.color = state.settings.highlightColor;
      if ((!active.name || active.name === '共有アプリ' || active.name === '登録済みアプリ') && state.ssName) {
        active.name = state.ssName;
      }
      saveAppRegistry();
    }

    var titleEl = $('header-ss-name');
    if (titleEl) {
      titleEl.textContent = (active && active.name) || state.ssName || '打刻Web Luckyスロット';
    }
    applyHeaderTheme(state.settings.highlightColor);

    evaluateAlertLock();
    renderSlotAppearanceIdle();
    renderLatestCard();
    renderLogTable();
    renderSettingsPageDynamic();
    updateScanControlsLock();
  }

  function evaluateAlertLock() {
    var alerts = state.rows.filter(function (r) {
      return r.a !== '取消' && r.c && r.c.indexOf('🚨') !== -1 && r.b !== '確';
    });
    state.alertRows = alerts;
    state.hasUnconfirmedAlert = alerts.length > 0;

    var banner = $('alert-lock-banner');
    if (!banner) return;
    if (state.hasUnconfirmedAlert) {
      var names = alerts.map(function (r) { return r.d || ('行' + r.rowNum); }).join(' / ');
      banner.style.display = 'block';
      banner.innerHTML = '🚨 未確認の重要通知があるため次の打刻をロック中です。<br>対象：' + escapeHtml(names) + '（B列の「未」をタップして「確」にすると解除されます）';
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
    }

    if (typeof window.syncCameraPanelState === 'function') {
      window.syncCameraPanelState();
    }
  }

  function updateScanControlsLock() {
    var blocked = isScanBlocked();
    var input = $('scan-input');
    var submitBtn = $('scan-submit-btn');
    if (input) input.disabled = state.hasUnconfirmedAlert || !state.isConnected;
    if (submitBtn) submitBtn.disabled = blocked;
    if (typeof window.syncCameraPanelState === 'function') {
      window.syncCameraPanelState();
    }
  }

  function isScanBlocked() {
    return !state.isConnected || state.isSubmittingScan || state.isCooldown || state.isSlotSpinning || state.hasUnconfirmedAlert;
  }

  function isAlertLocked() {
    return state.hasUnconfirmedAlert;
  }

  function renderSlotAppearanceIdle() {
    var box = $('slot-box');
    var badge = $('slot-mode-badge');
    var hint = $('slot-speed-hint');
    var subHint = $('slot-sub-hint');
    if (!box) return;

    box.classList.toggle('slot-modern', state.settings.reelStyle === 'modern');

    if (state.settings.slotEnabled === false) {
      box.classList.add('slot-off');
      if (badge) badge.textContent = '⚡ スロットOFF（高速モード）';
      if (hint) hint.textContent = '自動高速打刻';
      if (!state.isSlotSpinning && !state.isSubmittingScan) {
        $('reel-0').textContent = '⚡';
        $('reel-1').textContent = '✅';
        $('reel-2').textContent = '⚡';
        if (subHint) subHint.textContent = 'スロット演出なしで最速記録します';
      }
    } else {
      box.classList.remove('slot-off');
      var isFair = state.settings.slotMode === 'fair';
      if (badge) badge.textContent = isFair ? '🎰 満遍なく当選モード' : '🎰 通常モード';
      if (hint) hint.textContent = '回転中タップで即停止';
      if (subHint) {
        var delaySec = (Number(state.settings.slotDelayMs || 0) / 1000).toFixed(1);
        var coolSec = (Number(state.settings.slotCooldownMs || 1000) / 1000).toFixed(1);
        subHint.textContent = '演出ディレイ ' + delaySec + '秒 ／ 結果ロック ' + coolSec + '秒';
      }
    }
  }

  function renderLatestCard() {
    var card = $('latest-card');
    var nameEl = $('latest-name');
    var notifEl = $('latest-notif');
    var slotEl = $('latest-slot-tag');
    var rowBadge = $('latest-row-badge');
    var doneBtn = $('latest-done-btn');
    if (!card) return;

    var activeRows = state.rows.filter(function (r) { return r.a !== '取消'; });
    var latest = activeRows.length > 0 ? activeRows[activeRows.length - 1] : null;

    card.classList.remove('has-notif', 'has-alert');
    nameEl.classList.remove('is-red');
    notifEl.classList.remove('is-alert');

    if (!latest) {
      nameEl.textContent = 'まだ打刻はありません';
      notifEl.textContent = '';
      slotEl.textContent = '';
      rowBadge.textContent = '';
      doneBtn.style.display = 'none';
      doneBtn.dataset.rowNum = '';
      return;
    }

    rowBadge.textContent = '#' + (activeRows.length) + '（' + latest.rowNum + '行目）';
    nameEl.textContent = latest.d || latest.e || '(不明)';
    if (latest.isRed) nameEl.classList.add('is-red');

    if (latest.c) {
      notifEl.textContent = '🎁 ' + latest.c;
      var isAlert = latest.c.indexOf('🚨') !== -1;
      if (isAlert) {
        card.classList.add('has-alert');
        notifEl.classList.add('is-alert');
      } else {
        card.classList.add('has-notif');
      }
      doneBtn.style.display = 'inline-block';
      doneBtn.dataset.rowNum = String(latest.rowNum);
      var isDone = latest.b === '確';
      doneBtn.textContent = isDone ? '確' : '未';
      doneBtn.classList.toggle('is-done', isDone);
    } else {
      notifEl.textContent = '';
      doneBtn.style.display = 'none';
      doneBtn.dataset.rowNum = '';
    }

    slotEl.textContent = latest.h ? ('スロット：' + latest.h) : '';
  }

  function renderLogTable() {
    var tbody = $('log-tbody');
    var countBadge = $('total-count-badge');
    var fgBadge = $('fg-count-badge');
    if (!tbody) return;

    var validCount = state.rows.filter(function (r) { return r.a !== '取消' && r.d; }).length;
    if (countBadge) countBadge.textContent = '打刻: ' + validCount + '件';

    var fLabel = state.settings.fLabel || '色違';
    var gLabel = state.settings.gLabel || 'Evnt';
    if (fgBadge) {
      fgBadge.textContent = fLabel + ': ' + state.fList.length + ' ／ ' + gLabel + ': ' + state.gList.length;
    }

    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b; padding:18px;">本日の打刻はまだありません</td></tr>';
      return;
    }

    var statusOpts = [
      { v: '', label: '--選択--' },
      { v: fLabel, label: fLabel },
      { v: gLabel, label: gLabel },
      { v: fLabel + '+' + gLabel, label: fLabel + '+' + gLabel },
      { v: '取消', label: '取消' }
    ];

    // 新しい打刻が上に来るよう逆順表示
    var reversed = state.rows.slice().reverse();
    var html = reversed.map(function (r, idx) {
      var dispNo = state.rows.length - idx;
      var isCancelled = r.a === '取消';
      var isAlert = !isCancelled && r.c && r.c.indexOf('🚨') !== -1 && r.b !== '確';

      var optHtml = statusOpts.map(function (o) {
        var sel = (r.a === o.v) ? ' selected' : '';
        return '<option value="' + escapeHtml(o.v) + '"' + sel + '>' + escapeHtml(o.label) + '</option>';
      }).join('');
      if (r.a && !statusOpts.some(function (o) { return o.v === r.a; })) {
        optHtml += '<option value="' + escapeHtml(r.a) + '" selected>' + escapeHtml(r.a) + '</option>';
      }

      var bHtml = '';
      if (r.c && !isCancelled) {
        var doneCls = r.b === '確' ? ' is-done' : '';
        bHtml = '<button type="button" class="done-mini-btn' + doneCls + '" onclick="handleToggleRowDone(' + r.rowNum + ')">' + escapeHtml(r.b || '未') + '</button>';
      }

      var notifCls = (r.c && r.c.indexOf('🚨') !== -1) ? 'cell-notif is-alert' : 'cell-notif';
      var nameCls = r.isRed ? 'cell-name is-red' : 'cell-name';

      return (
        '<tr class="' + (isCancelled ? 'row-cancelled' : (isAlert ? 'row-alert' : '')) + '">' +
          '<td>' + dispNo + '</td>' +
          '<td><select class="status-select" onchange="handleRowStatusChange(' + r.rowNum + ', this.value)">' + optHtml + '</select></td>' +
          '<td>' + bHtml + '</td>' +
          '<td class="' + notifCls + '">' + escapeHtml(r.c || '') + '</td>' +
          '<td class="' + nameCls + '">' + escapeHtml(r.d || r.e || '') + '</td>' +
          '<td class="cell-slot">' + escapeHtml(r.h || '') + '</td>' +
        '</tr>'
      );
    }).join('');

    tbody.innerHTML = html;
  }

  function renderSettingsPageDynamic() {
    var quickBtn = $('quick-slot-toggle-btn');
    if (quickBtn) {
      var on = state.settings.slotEnabled !== false;
      quickBtn.innerHTML = '<span>🎰 スロット機能：' + (on ? 'ON（抽選あり）' : 'OFF（自動高速）') + '</span><span style="font-size:0.76rem;">タップで切替</span>';
      quickBtn.className = 'action-btn ' + (on ? 'primary' : 'success');
    }

    var grid = $('dest-links-grid');
    if (grid) {
      var urls = state.destUrls || {};
      var items = [
        { label: 'D列(参加)シート', url: urls.d },
        { label: 'F列(' + (state.settings.fLabel || '色違') + ')シート', url: urls.f },
        { label: 'G列(' + (state.settings.gLabel || 'Evnt') + ')シート', url: urls.g },
        { label: '🏆 当選者シート', url: urls.winner }
      ];
      grid.innerHTML = items.map(function (it) {
        if (!it.url) {
          return '<span class="dest-link-btn" style="opacity:0.45; cursor:default;">' + escapeHtml(it.label) + '</span>';
        }
        return '<a class="dest-link-btn" href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(it.label) + ' ↗</a>';
      }).join('');
    }

    var cCard = $('custom-links-card');
    var cList = $('custom-links-list');
    var validLinks = (state.settings.customLinks || []).filter(function (lk) { return lk && lk.name && lk.url; });
    if (cCard && cList) {
      if (validLinks.length === 0) {
        cCard.style.display = 'none';
      } else {
        cCard.style.display = 'block';
        cList.innerHTML = validLinks.map(function (lk) {
          return '<a class="action-btn" href="' + escapeHtml(lk.url) + '" target="_blank" rel="noopener noreferrer"><span>🔗 ' + escapeHtml(lk.name) + '</span><span>↗</span></a>';
        }).join('');
      }
    }
  }

  // -----------------------------------------------------------------------
  // スロット演出 ＆ 打刻処理
  // -----------------------------------------------------------------------
  function clearSlotTimers() {
    if (state.spinIntervalId) {
      clearInterval(state.spinIntervalId);
      state.spinIntervalId = null;
    }
    state.pendingStopTimers.forEach(function (id) { clearTimeout(id); });
    state.pendingStopTimers = [];
  }

  function startSlotSpinningVisual() {
    clearSlotTimers();
    state.isSlotSpinning = true;
    var box = $('slot-box');
    box.classList.remove('slot-win', 'slot-jackpot', 'slot-dup');
    $('slot-msg').textContent = '🎰 抽選中…（タップで即停止）';

    for (var i = 0; i < 3; i++) {
      var r = $('reel-' + i);
      if (r) r.classList.add('spinning');
    }

    playSoundPreset('spin');
    var tick = 0;
    state.spinIntervalId = setInterval(function () {
      tick++;
      for (var i = 0; i < 3; i++) {
        var r = $('reel-' + i);
        if (r && r.classList.contains('spinning')) {
          r.textContent = SLOT_SYMBOLS[(tick + i * 2) % SLOT_SYMBOLS.length];
        }
      }
    }, 65);
  }

  function buildTargetReels(slotResult) {
    if (!slotResult) return ['❓', '❓', '❓'];
    if (slotResult.isDuplicate) {
      if (slotResult.penaltyMode === 'skull') return ['💀', '💀', '💀'];
      var p = PENALTY_SYMBOLS[Math.floor(Math.random() * PENALTY_SYMBOLS.length)];
      return [p, p, p];
    }
    if (slotResult.slotDisabled) {
      return ['⚡', '✅', '⚡'];
    }
    if (slotResult.won && slotResult.symbol) {
      return [slotResult.symbol, slotResult.symbol, slotResult.symbol];
    }
    // ハズレ（3つ揃わない組み合わせを生成）
    var a = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    var b = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    var c = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    if (a === b && b === c) {
      c = SLOT_SYMBOLS[(SLOT_SYMBOLS.indexOf(c) + 1) % SLOT_SYMBOLS.length];
    }
    return [a, b, c];
  }

  function finishSlotVisual(scanRes, immediate) {
    clearSlotTimers();
    var slotResult = (scanRes && scanRes.slotResult) || {};
    var targets = buildTargetReels(slotResult);
    var box = $('slot-box');
    var msgEl = $('slot-msg');

    function finalizeDisplay(usedQuickStop) {
      for (var i = 0; i < 3; i++) {
        var r = $('reel-' + i);
        if (r) {
          r.classList.remove('spinning');
          r.textContent = targets[i];
        }
      }
      state.isSlotSpinning = false;
      state.pendingScanResponse = null;

      if (scanRes.isDuplicate) {
        box.classList.add('slot-dup');
        msgEl.textContent = '⚠️ 重複打刻：' + (scanRes.formattedName || '');
        playSoundPreset('buzzer');
      } else if (slotResult.slotDisabled) {
        msgEl.textContent = '⚡ 打刻完了：' + (scanRes.formattedName || '');
        playSoundPreset('ok');
      } else if (slotResult.won) {
        box.classList.add(slotResult.isJackpot ? 'slot-jackpot' : 'slot-win');
        msgEl.textContent = (slotResult.logText || '🎉 当たり！') + '（' + (scanRes.formattedName || '') + '）';
        playSoundPreset(slotResult.isJackpot ? 'fanfare' : 'win');
      } else {
        msgEl.textContent = '✅ 打刻完了：' + (scanRes.formattedName || '');
        playSoundPreset('ok');
      }

      if (scanRes.dashboard) {
        applyDashboardData(scanRes.dashboard);
      }

      // 結果表示後の入力ロック時間（設定値：0.3〜5.0秒 / 即停止タップ時は最大0.45秒）
      var configuredMs = clampNum(state.settings.slotCooldownMs, 300, 5000, 1000);
      var lockMs = usedQuickStop ? Math.min(450, configuredMs) : configuredMs;
      if (slotResult.slotDisabled) {
        lockMs = Math.min(500, configuredMs);
      }

      state.isCooldown = true;
      updateScanControlsLock();
      if (state.cooldownTimerId) clearTimeout(state.cooldownTimerId);
      state.cooldownTimerId = setTimeout(function () {
        state.isCooldown = false;
        updateScanControlsLock();
        focusScanInputSafe();
      }, lockMs);
    }

    if (immediate || slotResult.slotDisabled || scanRes.isDuplicate) {
      finalizeDisplay(!!immediate);
      return;
    }

    var delayMs = clampNum(state.settings.slotDelayMs, 0, 5000, 0);
    // 左→中→右の順に停止（演出ディレイ後に0ms / 220ms / 460ms）
    var offsets = [delayMs, delayMs + 220, delayMs + 460];

    // 回転を継続しながら順番に止める
    var tick = 0;
    state.spinIntervalId = setInterval(function () {
      tick++;
      for (var i = 0; i < 3; i++) {
        var r = $('reel-' + i);
        if (r && r.classList.contains('spinning')) {
          r.textContent = SLOT_SYMBOLS[(tick + i * 2) % SLOT_SYMBOLS.length];
        }
      }
    }, 65);

    offsets.forEach(function (ms, idx) {
      var tId = setTimeout(function () {
        var r = $('reel-' + idx);
        if (r) {
          r.classList.remove('spinning');
          r.textContent = targets[idx];
        }
        if (idx < 2) {
          playSoundPreset('ok');
        } else {
          clearSlotTimers();
          finalizeDisplay(false);
        }
      }, ms);
      state.pendingStopTimers.push(tId);
    });
  }

  function handleSlotBoxTap() {
    // スロット結果がすでに届いて演出待ち中なら即座に全リール停止
    if (state.isSlotSpinning && state.pendingScanResponse) {
      finishSlotVisual(state.pendingScanResponse, true);
      showToast('⚡ 即停止しました', 1000);
    }
  }

  async function processScan(rawText) {
    var trimmed = String(rawText || '').trim();
    if (!trimmed) return;

    if (!state.isConnected) {
      showToast('🔌 先に接続先GAS URLを設定してください');
      openGasUrlModal();
      return;
    }
    if (state.hasUnconfirmedAlert) {
      showToast('🚨 未確認のアラートを「確」にしてください');
      playSoundPreset('buzzer');
      return;
    }
    if (state.isSubmittingScan || state.isCooldown || state.isSlotSpinning) {
      return;
    }

    ensureAudioCtx();
    state.isSubmittingScan = true;
    state.pendingScanResponse = null;
    updateScanControlsLock();
    pauseAutoPollByAction();

    var useSlot = state.settings.slotEnabled !== false;
    if (useSlot) {
      startSlotSpinningVisual();
    } else {
      $('slot-msg').textContent = '⚡ 高速打刻中…';
    }

    try {
      var res = await callGasApi('addScanData', [trimmed]);
      if (!res || res.ignored) {
        clearSlotTimers();
        state.isSlotSpinning = false;
        $('slot-msg').textContent = 'QRコードを読み取ってください';
        return;
      }
      if (!res.ok) {
        clearSlotTimers();
        state.isSlotSpinning = false;
        $('slot-msg').textContent = '⚠️ ' + (res.error || '無効なデータです');
        playSoundPreset('buzzer');
        showToast('⚠️ ' + (res.error || '無効なデータです'), 2800);
        return;
      }

      state.pendingScanResponse = res;
      if (useSlot) {
        finishSlotVisual(res, false);
      } else {
        finishSlotVisual(res, true);
      }
    } catch (err) {
      clearSlotTimers();
      state.isSlotSpinning = false;
      $('slot-msg').textContent = '❌ 通信エラー（再読込してください）';
      playSoundPreset('buzzer');
      showToast('❌ 打刻エラー：' + err.message, 3200);
    } finally {
      state.isSubmittingScan = false;
      updateScanControlsLock();
    }
  }

  function submitScanFromInput() {
    var input = $('scan-input');
    if (!input) return;
    var val = input.value;
    input.value = '';
    processScan(val);
  }

  // device.js（カメラQR・NFC）から呼び出す窓口
  function handleExternalScan(text) {
    if (isScanBlocked()) return false;
    processScan(text);
    return true;
  }

  // -----------------------------------------------------------------------
  // A列ステータス変更・B列「未/確」トグル
  // -----------------------------------------------------------------------
  async function handleRowStatusChange(rowNum, newStatus) {
    pauseAutoPollByAction();
    try {
      var dash = await callGasApi('updateRowStatus', [rowNum, newStatus]);
      applyDashboardData(dash);
      showToast('✅ 区分を更新しました', 1500);
    } catch (err) {
      showToast('❌ 更新失敗：' + err.message, 2800);
    }
  }

  async function handleToggleRowDone(rowNum) {
    pauseAutoPollByAction();
    try {
      var dash = await callGasApi('toggleRowDone', [rowNum]);
      applyDashboardData(dash);
      showToast('✅ 確認状態を更新しました', 1500);
    } catch (err) {
      showToast('❌ 更新失敗：' + err.message, 2800);
    }
  }

  function toggleLatestDone() {
    var btn = $('latest-done-btn');
    var rowNum = Number(btn && btn.dataset.rowNum);
    if (rowNum > 0) handleToggleRowDone(rowNum);
  }

  // -----------------------------------------------------------------------
  // 2ページ目：クイック切替・設定モーダル
  // -----------------------------------------------------------------------
  async function quickToggleSlotEnabled() {
    var nextVal = !(state.settings.slotEnabled !== false);
    pauseAutoPollByAction();
    try {
      var dash = await callGasApi('saveSettings', [{ slotEnabled: nextVal }]);
      applyDashboardData(dash);
      showToast(nextVal ? '🎰 スロット機能をONにしました' : '⚡ スロット機能をOFF（高速モード）にしました', 2200);
    } catch (err) {
      showToast('❌ 切替失敗：' + err.message, 2800);
    }
  }

  function openSettingsModal() {
    var s = state.settings;
    $('set-highlight-color').value = s.highlightColor || '#fff9b1';
    $('set-slot-enabled').value = s.slotEnabled === false ? 'false' : 'true';
    $('set-slot-mode').value = s.slotMode || 'normal';
    $('set-fair-limit').value = s.fairLimit != null ? s.fairLimit : 1;
    $('set-jackpot-target').value = s.jackpotTarget || 'both';
    $('set-penalty-mode').value = s.penaltyMode || 'random';
    $('set-reel-style').value = s.reelStyle || 'legacy';

    // 時間3項目（秒単位で表示）
    $('set-slot-delay-sec').value = (clampNum(s.slotDelayMs, 0, 5000, 0) / 1000).toFixed(1);
    $('set-slot-cooldown-sec').value = (clampNum(s.slotCooldownMs, 300, 5000, 1000) / 1000).toFixed(1);
    $('set-pause-sec').value = clampNum(s.pauseSeconds, 5, 120, 15);

    var np = s.normalProb || {};
    var fp = s.fairProb || {};
    $('prob-n-seven').value = np.seven || 0;
    $('prob-n-sakura').value = np.sakura || 0;
    $('prob-n-bar').value = np.bar || 0;
    $('prob-n-bell').value = np.bell || 0;
    $('prob-n-grape').value = np.grape || 0;
    $('prob-n-cherry').value = np.cherry || 0;

    $('prob-f-seven').value = fp.seven || 0;
    $('prob-f-sakura').value = fp.sakura || 0;
    $('prob-f-bar').value = fp.bar || 0;
    $('prob-f-bell').value = fp.bell || 0;
    $('prob-f-grape').value = fp.grape || 0;
    $('prob-f-cherry').value = fp.cherry || 0;

    $('set-f-label').value = s.fLabel || '色違';
    $('set-g-label').value = s.gLabel || 'Evnt';

    var snd = s.sounds || {};
    $('snd-spin').value = snd.spin || 'basic';
    $('snd-ok').value = snd.ok || 'basic';
    $('snd-win').value = snd.win || 'basic';
    $('snd-fanfare').value = snd.fanfare || 'basic';
    $('snd-buzzer').value = snd.buzzer || 'basic';

    var links = s.customLinks || [];
    for (var i = 1; i <= 4; i++) {
      var lk = links[i - 1] || {};
      $('clink-name-' + i).value = lk.name || '';
      $('clink-url-' + i).value = lk.url || '';
    }

    openModal('modal-settings');
  }

  async function saveSettingsFromModal() {
    var delaySec = clampNum($('set-slot-delay-sec').value, 0, 5, 0);
    var coolSec = clampNum($('set-slot-cooldown-sec').value, 0.3, 5, 1.0);
    var pauseSec = Math.round(clampNum($('set-pause-sec').value, 5, 120, 15));

    var payload = {
      highlightColor: $('set-highlight-color').value,
      slotEnabled: $('set-slot-enabled').value !== 'false',
      slotMode: $('set-slot-mode').value,
      fairLimit: Math.max(0, parseInt($('set-fair-limit').value, 10) || 0),
      jackpotTarget: $('set-jackpot-target').value,
      penaltyMode: $('set-penalty-mode').value,
      reelStyle: $('set-reel-style').value,
      slotDelayMs: Math.round(delaySec * 1000),
      slotCooldownMs: Math.round(coolSec * 1000),
      pauseSeconds: pauseSec,
      normalProb: {
        seven: parseFloat($('prob-n-seven').value) || 0,
        sakura: parseFloat($('prob-n-sakura').value) || 0,
        bar: parseFloat($('prob-n-bar').value) || 0,
        bell: parseFloat($('prob-n-bell').value) || 0,
        grape: parseFloat($('prob-n-grape').value) || 0,
        cherry: parseFloat($('prob-n-cherry').value) || 0
      },
      fairProb: {
        seven: parseFloat($('prob-f-seven').value) || 0,
        sakura: parseFloat($('prob-f-sakura').value) || 0,
        bar: parseFloat($('prob-f-bar').value) || 0,
        bell: parseFloat($('prob-f-bell').value) || 0,
        grape: parseFloat($('prob-f-grape').value) || 0,
        cherry: parseFloat($('prob-f-cherry').value) || 0
      },
      fLabel: ($('set-f-label').value || '色違').trim(),
      gLabel: ($('set-g-label').value || 'Evnt').trim(),
      sounds: {
        spin: $('snd-spin').value,
        ok: $('snd-ok').value,
        win: $('snd-win').value,
        fanfare: $('snd-fanfare').value,
        buzzer: $('snd-buzzer').value
      },
      customLinks: [1, 2, 3, 4].map(function (n) {
        return {
          slot: n,
          name: ($('clink-name-' + n).value || '').trim(),
          url: ($('clink-url-' + n).value || '').trim()
        };
      })
    };

    try {
      showToast('💾 設定を保存中…');
      var dash = await callGasApi('saveSettings', [payload]);
      applyDashboardData(dash);
      closeModal('modal-settings');
      showToast('✅ 設定を保存＆キャッシュ更新しました！');
    } catch (err) {
      showToast('❌ 保存エラー：' + err.message, 3200);
    }
  }

  async function runResetSlotHistory() {
    if (!confirm('満遍なく当選モードの「スロット履歴」をすべて消去しますか？')) return;
    try {
      var res = await callGasApi('resetSlotHistory', []);
      showToast('✅ ' + (res && res.message ? res.message : 'リセットしました'));
    } catch (err) {
      showToast('❌ エラー：' + err.message, 3000);
    }
  }

  // -----------------------------------------------------------------------
  // スロット履歴モーダル（閲覧専用）
  // -----------------------------------------------------------------------
  async function openSlotHistoryModal() {
    openModal('modal-slot-history');
    $('slot-hist-tbody').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:16px;">読み込み中…</td></tr>';
    try {
      var data = await callGasApi('getSlotHistory', []);
      state.slotHistoryCache = data;
      renderSlotHistoryTable();
    } catch (err) {
      $('slot-hist-tbody').innerHTML = '<tr><td colspan="3" style="text-align:center; color:#dc2626; padding:16px;">取得エラー：' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function setSlotHistorySort(mode) {
    state.slotHistorySort = mode;
    ['order', 'wins', 'name'].forEach(function (m) {
      var btn = $('sort-hist-' + m);
      if (btn) btn.classList.toggle('active', m === mode);
    });
    renderSlotHistoryTable();
  }

  function renderSlotHistoryTable() {
    var data = state.slotHistoryCache;
    if (!data) return;
    var items = (data.items || []).slice();
    var limit = Number(data.fairLimit) || 0;

    var totalWins = items.reduce(function (acc, it) { return acc + (it.wins || 0); }, 0);
    var reachedCount = limit > 0 ? items.filter(function (it) { return it.wins >= limit; }).length : 0;

    $('slot-hist-summary').innerHTML =
      '<span class="summary-chip">対象者: ' + items.length + '名</span>' +
      '<span class="summary-chip">累計当たり: ' + totalWins + '回</span>' +
      (limit > 0 ? '<span class="summary-chip">上限(' + limit + '回)到達: ' + reachedCount + '名</span>' : '<span class="summary-chip">上限: 無制限</span>');

    if (state.slotHistorySort === 'wins') {
      items.sort(function (a, b) { return (b.wins - a.wins) || (a.order - b.order); });
    } else if (state.slotHistorySort === 'name') {
      items.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ja'); });
    } else {
      items.sort(function (a, b) { return a.order - b.order; });
    }

    if (items.length === 0) {
      $('slot-hist-tbody').innerHTML = '<tr><td colspan="3" style="text-align:center; color:#64748b; padding:18px;">履歴はまだありません</td></tr>';
      return;
    }

    $('slot-hist-tbody').innerHTML = items.map(function (it) {
      var mark = (limit > 0 && it.wins >= limit) ? ' 🔒' : '';
      return (
        '<tr>' +
          '<td style="font-weight:700;">' + escapeHtml(it.name) + mark + '</td>' +
          '<td style="font-weight:800; color:#1d4ed8;">' + escapeHtml(it.wins) + '回</td>' +
          '<td style="font-size:0.74rem; color:#475569;">' + escapeHtml(it.lastAt) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  // -----------------------------------------------------------------------
  // 締め作業（①BK・②ログ修正・③転記＆後BK・⑤当選者編集・⑥初期化）
  // -----------------------------------------------------------------------
  async function runPreBackup() {
    if (!confirm('① 修正前バックアップ（前）をドライブへ保存しますか？')) return;
    try {
      showToast('💾 修正前BKを保存中…');
      var res = await callGasApi('savePreBackup', []);
      alert(res.message || '修正前BKを保存しました。');
    } catch (err) {
      alert('エラー：' + err.message);
    }
  }

  function openLogEditModal() {
    renderLogEditList();
    openModal('modal-log-edit');
  }

  function renderLogEditList() {
    var container = $('log-edit-list');
    if (!container) return;
    if (state.rows.length === 0) {
      container.innerHTML = '<div class="sub-note">修正対象の打刻ログがありません。</div>';
      return;
    }

    var reversed = state.rows.slice().reverse();
    container.innerHTML = reversed.map(function (r) {
      return (
        '<div class="form-section" style="margin-bottom:8px;">' +
          '<div style="font-size:0.8rem; font-weight:800; margin-bottom:4px;">' +
            '行' + r.rowNum + '：' + escapeHtml(r.d || '(未解決)') +
            (r.c ? ' ／ <span style="color:#b45309;">' + escapeHtml(r.c) + '</span>' : '') +
          '</div>' +
          '<input type="text" id="edit-raw-' + r.rowNum + '" class="form-input" value="' + escapeHtml(r.e || '') + '" style="margin-bottom:6px;">' +
          '<div style="display:flex; gap:6px; justify-content:flex-end;">' +
            '<button type="button" class="btn primary" onclick="saveEditedLogRow(' + r.rowNum + ')">🔄 再照合して更新</button>' +
            '<button type="button" class="btn danger" onclick="confirmDeleteLogRow(' + r.rowNum + ')">🗑️ 行削除</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  async function saveEditedLogRow(rowNum) {
    var input = $('edit-raw-' + rowNum);
    if (!input) return;
    try {
      showToast('🔄 最新名簿で再照合中…');
      var dash = await callGasApi('updateLogEntry', [rowNum, input.value]);
      applyDashboardData(dash);
      renderLogEditList();
      showToast('✅ 更新しました！');
    } catch (err) {
      alert('更新エラー：' + err.message);
    }
  }

  async function confirmDeleteLogRow(rowNum) {
    if (!confirm('行' + rowNum + 'を完全に削除しますか？')) return;
    try {
      var dash = await callGasApi('deleteLogRow', [rowNum]);
      applyDashboardData(dash);
      renderLogEditList();
      showToast('🗑️ 削除しました');
    } catch (err) {
      alert('削除エラー：' + err.message);
    }
  }

  async function runTransferAndPostBackup() {
    if (!confirm('③ D/F/G各シートへ転記し、修正後バックアップ（後）を保存しますか？')) return;
    try {
      showToast('📤 転記＆後BKを実行中…', 5000);
      var res = await callGasApi('executeTransferAndPostBackup', []);
      alert(res.message || '転記と後BKが完了しました。');
    } catch (err) {
      alert('エラー：' + err.message);
    }
  }

  async function openWinnerEditorModal() {
    openModal('modal-winner-editor');
    $('winner-editor-top').innerHTML = '';
    $('winner-editor-list').innerHTML = '読み込み中…';
    try {
      var data = await callGasApi('getWinnerSheetForEditor', []);
      renderWinnerEditor(data);
    } catch (err) {
      $('winner-editor-list').innerHTML = '<div style="color:#dc2626; font-weight:700;">取得エラー：' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderWinnerEditor(data) {
    if (data && data.ssUrl) {
      $('winner-editor-top').innerHTML =
        '<a class="dest-link-btn" href="' + escapeHtml(data.ssUrl) + '" target="_blank" rel="noopener noreferrer">🏆 当選者スプレッドシートを直接開く ↗</a>';
    }

    var cols = (data && data.columns) || [];
    if (cols.length === 0) {
      $('winner-editor-list').innerHTML = '<div class="sub-note">データがありません。</div>';
      return;
    }

    $('winner-editor-list').innerHTML = cols.map(function (colObj) {
      var itemsHtml = colObj.items.length === 0
        ? '<div class="sub-note">（登録なし）</div>'
        : colObj.items.map(function (it) {
            var bgStyle = it.highlighted ? 'background:' + escapeHtml(it.bgColor) + ';' : '';
            var keyId = 'win-cell-' + it.row + '-' + it.col;
            return (
              '<div style="display:flex; gap:5px; align-items:center; margin-bottom:6px;">' +
                '<input type="text" id="' + keyId + '" class="form-input" style="height:34px; font-size:0.84rem; ' + bgStyle + '" value="' + escapeHtml(it.value) + '">' +
                '<button type="button" class="btn primary" style="padding:6px 9px; font-size:0.78rem;" onclick="saveWinnerCell(' + it.row + ',' + it.col + ')">保存</button>' +
                '<button type="button" class="btn danger" style="padding:6px 9px; font-size:0.78rem;" onclick="deleteWinnerCell(' + it.row + ',' + it.col + ')">削除</button>' +
              '</div>'
            );
          }).join('');

      return (
        '<div class="form-section">' +
          '<div class="form-section-title">' + escapeHtml(colObj.header) + '（' + colObj.items.length + '件）</div>' +
          itemsHtml +
        '</div>'
      );
    }).join('');
  }

  async function saveWinnerCell(row, col) {
    var input = $('win-cell-' + row + '-' + col);
    if (!input) return;
    try {
      showToast('💾 保存＆キャッシュ更新中…');
      var data = await callGasApi('updateWinnerSheetCell', [row, col, input.value]);
      renderWinnerEditor(data);
      showToast('✅ 当選者シートを更新しました');
    } catch (err) {
      alert('更新エラー：' + err.message);
    }
  }

  async function deleteWinnerCell(row, col) {
    if (!confirm('この当選者セルを削除しますか？')) return;
    try {
      showToast('🗑️ 削除＆キャッシュ更新中…');
      var data = await callGasApi('updateWinnerSheetCell', [row, col, '']);
      renderWinnerEditor(data);
      showToast('🗑️ 削除しました');
    } catch (err) {
      alert('削除エラー：' + err.message);
    }
  }

  async function runResetTodayLog() {
    if (!confirm('⑥ 本日の打刻ログをすべて初期化し、キャッシュもリセットしますか？\n（※必ず転記と後BKが終わってから実行してください）')) return;
    if (!confirm('本当によろしいですか？初期化すると元に戻せません。')) return;
    try {
      showToast('🗑️ 初期化中…');
      var dash = await callGasApi('resetTodayLog', []);
      applyDashboardData(dash);
      showToast('✅ 本日の打刻ログとキャッシュを初期化しました');
    } catch (err) {
      alert('エラー：' + err.message);
    }
  }

  // -----------------------------------------------------------------------
  // 起動処理
  // -----------------------------------------------------------------------
  async function bootApp() {
    try {
      state.muted = localStorage.getItem(LS_KEYS.MUTE) === '1';
      var cachedStyle = localStorage.getItem(LS_KEYS.REEL_STYLE_CACHE);
      if (cachedStyle === 'modern' || cachedStyle === 'legacy') {
        state.settings.reelStyle = cachedStyle;
      }
    } catch (e) {}

    updateMuteButtonUI();
    loadAppRegistry();
    applyScreenRotationUI();
    renderSlotAppearanceIdle();
    startPollingLoop();

    // 初回操作でAudioContextのロックを解除
    document.addEventListener('pointerdown', function unlockOnce() {
      ensureAudioCtx();
      document.removeEventListener('pointerdown', unlockOnce);
    }, { passive: true });

    if (state.gasUrl) {
      showToast('🔄 最新データを読み込み中…', 2000);
      await refreshCachesAndDashboard(false);
    } else {
      updateConnectionBadge(false);
      openGasUrlModal();
    }
  }

  // -----------------------------------------------------------------------
  // グローバル公開（HTML onclick ＆ device.js 連携用）
  // -----------------------------------------------------------------------
  window.cycleScreenRotation = cycleScreenRotation;
  window.switchTab = switchTab;
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.openGasUrlModal = openGasUrlModal;
  window.saveAndTestGasUrl = saveAndTestGasUrl;
  window.selectRegisteredApp = selectRegisteredApp;
  window.renameRegisteredApp = renameRegisteredApp;
  window.deleteRegisteredApp = deleteRegisteredApp;
  window.clearSavedGasUrl = clearSavedGasUrl;
  window.copyShareSetupLink = copyShareSetupLink;
  window.toggleAutoPollPause = toggleAutoPollPause;
  window.triggerManualCacheRefresh = triggerManualCacheRefresh;
  window.submitScanFromInput = submitScanFromInput;
  window.toggleSoundMute = toggleSoundMute;
  window.handleSlotBoxTap = handleSlotBoxTap;
  window.toggleLatestDone = toggleLatestDone;
  window.handleRowStatusChange = handleRowStatusChange;
  window.handleToggleRowDone = handleToggleRowDone;
  window.quickToggleSlotEnabled = quickToggleSlotEnabled;
  window.openSettingsModal = openSettingsModal;
  window.saveSettingsFromModal = saveSettingsFromModal;
  window.runResetSlotHistory = runResetSlotHistory;
  window.openSlotHistoryModal = openSlotHistoryModal;
  window.setSlotHistorySort = setSlotHistorySort;
  window.runPreBackup = runPreBackup;
  window.openLogEditModal = openLogEditModal;
  window.saveEditedLogRow = saveEditedLogRow;
  window.confirmDeleteLogRow = confirmDeleteLogRow;
  window.runTransferAndPostBackup = runTransferAndPostBackup;
  window.openWinnerEditorModal = openWinnerEditorModal;
  window.saveWinnerCell = saveWinnerCell;
  window.deleteWinnerCell = deleteWinnerCell;
  window.runResetTodayLog = runResetTodayLog;

  // device.js 向けブリッジ
  window.showToast = showToast;
  window.isScanBlocked = isScanBlocked;
  window.isAlertLocked = isAlertLocked;
  window.handleExternalScan = handleExternalScan;

  document.addEventListener('DOMContentLoaded', bootApp);
})();

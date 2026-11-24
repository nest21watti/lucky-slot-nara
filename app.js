/**
 * app.js - 打刻Web Luckyスロット メイン制御
 * - 複数アプリ（GAS URL）の登録＆ワンタップ切替（シート名＆色自動取得＋自由リネーム）
 * - ホスト確認済み背景色とヘッダー帯の自動連動（明度に応じた文字色自動切替）
 * - スロットON / OFF（OFF時は自動で高速打刻モード）
 * - スロットON時は照合中＋回転中＋結果後2秒間、カメラ/NFC/スキャナー/手動すべてを一括ロック
 * - スロット枠タップで即停止＆待機復帰
 */

(function () {
  'use strict';

  const STORAGE_APPS_KEY = 'dakoku_apps_v2';
  const STORAGE_ACTIVE_ID_KEY = 'dakoku_active_app_id_v2';
  const LEGACY_URL_KEYS = ['dakoku_gas_url', 'gasUrl', 'gas_url'];

  const REEL_SYMBOLS = ['7️⃣', '🌸', '🍫', '🔔', '🍇', '🍒'];
  const COLOR_SWATCHES = [
    '#fff2cc', '#fce7f3', '#dbeafe', '#dcfce7',
    '#ede9fe', '#ffedd5', '#fee2e2', '#cffafe', '#1e3a8a'
  ];

  // ==========================================
  // アプリ全体状態
  // ==========================================
  const state = {
    apps: [],
    activeAppId: null,
    connected: false,
    appTitle: '🌸 打刻Web Luckyスロット',
    settings: {
      confirmBgColor: '#fff2cc',
      slotEnabled: true,
      slotMode: 'normal',
      fairLimit: 1,
      prob777: 2,
      probSakura: 5,
      probBar: 10,
      probBell: 15,
      probGrape: 20,
      probCherry: 25,
      soundPreset: 'classic',
      soundEnabled: true
    },
    logs: [],
    summary: { total: 0, valid: 0, shiny: 0, event: 0, unconfirmed: 0 },
    slotHistoryCount: 0,

    // 統一入力ロック制御
    isFetching: false,
    isSlotBusy: false,
    alertLocked: false,
    alertUnlockStep: 0,

    // スロット演出管理
    slotRun: null,
    cooldownTimer: null,

    // ソフトキーボード表示モード（false: 物理スキャナー用抑制）
    kbdOn: false,
    pollTimer: null
  };

  // DOM 参照
  const $ = (id) => document.getElementById(id);
  const el = {
    appHeader: $('appHeader'),
    appTitleText: $('appTitleText'),
    syncBadge: $('syncBadge'),
    btnConnect: $('btnConnect'),
    btnSettings: $('btnSettings'),
    btnAdmin: $('btnAdmin'),

    alertLockBanner: $('alertLockBanner'),
    alertLockTitle: $('alertLockTitle'),
    alertLockDetail: $('alertLockDetail'),
    btnAlertUnlock: $('btnAlertUnlock'),

    slotModeBadge: $('slotModeBadge'),
    btnSlotToggle: $('btnSlotToggle'),
    btnSoundToggle: $('btnSoundToggle'),
    slotBody: $('slotBody'),
    reelArea: $('reelArea'),
    reels: [$('reel0'), $('reel1'), $('reel2')],
    slotMessage: $('slotMessage'),
    slotOffBar: $('slotOffBar'),
    btnSlotTurnOn: $('btnSlotTurnOn'),

    resultCard: $('resultCard'),
    resultStatusBadge: $('resultStatusBadge'),
    resultSub: $('resultSub'),
    resultName: $('resultName'),
    resultNotice: $('resultNotice'),

    btnCameraToggle: $('btnCameraToggle'),
    btnNfcToggle: $('btnNfcToggle'),
    btnKbdToggle: $('btnKbdToggle'),
    cameraPanel: $('cameraPanel'),
    cameraVideo: $('cameraVideo'),
    cameraCanvas: $('cameraCanvas'),
    cameraStatusText: $('cameraStatusText'),
    btnCameraSwitch: $('btnCameraSwitch'),
    btnTorch: $('btnTorch'),
    scanForm: $('scanForm'),
    scanInput: $('scanInput'),
    btnManualSubmit: $('btnManualSubmit'),

    statValid: $('statValid'),
    statTotal: $('statTotal'),
    statShiny: $('statShiny'),
    statEvent: $('statEvent'),
    statUnconfirmed: $('statUnconfirmed'),
    btnRefresh: $('btnRefresh'),
    logList: $('logList'),

    modalConnect: $('modalConnect'),
    btnCloseConnect: $('btnCloseConnect'),
    appListContainer: $('appListContainer'),
    btnCopyCurrentShareUrl: $('btnCopyCurrentShareUrl'),
    inputGasUrl: $('inputGasUrl'),
    inputAppName: $('inputAppName'),
    btnAddApp: $('btnAddApp'),

    modalSettings: $('modalSettings'),
    btnCloseSettings: $('btnCloseSettings'),
    bgColorSwatches: $('bgColorSwatches'),
    inputConfirmBgColor: $('inputConfirmBgColor'),
    bgColorPreview: $('bgColorPreview'),
    setSlotEnabled: $('setSlotEnabled'),
    setSlotMode: $('setSlotMode'),
    setFairLimit: $('setFairLimit'),
    setSoundPreset: $('setSoundPreset'),
    btnTestSound: $('btnTestSound'),
    setProb777: $('setProb777'),
    setProbSakura: $('setProbSakura'),
    setProbBar: $('setProbBar'),
    setProbBell: $('setProbBell'),
    setProbGrape: $('setProbGrape'),
    setProbCherry: $('setProbCherry'),
    btnSaveSettings: $('btnSaveSettings'),
    btnResetHistory: $('btnResetHistory'),
    btnClearCache: $('btnClearCache'),
    historyCountHint: $('historyCountHint'),

    modalAdmin: $('modalAdmin'),
    btnCloseAdmin: $('btnCloseAdmin'),
    adminEventDate: $('adminEventDate'),
    adminEventTime: $('adminEventTime'),
    btnBackupTransfer: $('btnBackupTransfer'),
    btnInitTodayLog: $('btnInitTodayLog'),
    adminResultLog: $('adminResultLog'),

    toast: $('toast')
  };

  // デバイスコントローラー初期化
  const sound = new window.DakokuDevices.SoundEngine();
  const camera = new window.DakokuDevices.CameraController({
    video: el.cameraVideo,
    canvas: el.cameraCanvas,
    canScan: () => !isInputBlocked(),
    onDetect: (code) => submitCheckin(code, 'camera'),
    onStateChange: (camInfo) => updateCameraControls(camInfo)
  });
  const nfc = new window.DakokuDevices.NfcController({
    canScan: () => !isInputBlocked(),
    onDetect: (code) => submitCheckin(code, 'nfc'),
    onStateChange: (info) => {
      el.btnNfcToggle.classList.toggle('active', info.active);
      el.btnNfcToggle.textContent = info.active ? '📡 NFC待機中' : '📡 NFC読取';
    }
  });

  // ==========================================
  // 共通ユーティリティ・トースト・色判定
  // ==========================================
  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  function isLightColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6;
  }

  function applyHeaderTheme(hexColor) {
    const color = /^#[0-9a-fA-F]{6}$/.test(String(hexColor || '')) ? hexColor : '#1e3a8a';
    el.appHeader.style.backgroundColor = color;
    el.appHeader.classList.toggle('header-dark-text', isLightColor(color));
  }

  function updateBgPreview(hexColor) {
    const color = /^#[0-9a-fA-F]{6}$/.test(String(hexColor || '')) ? hexColor : '#fff2cc';
    el.bgColorPreview.style.backgroundColor = color;
    el.bgColorPreview.style.color = isLightColor(color) ? '#1e293b' : '#ffffff';
    el.bgColorSwatches.querySelectorAll('.swatch').forEach((sw) => {
      sw.classList.toggle('selected', sw.dataset.color.toLowerCase() === color.toLowerCase());
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==========================================
  // 複数アプリ（接続先リスト）管理
  // ==========================================
  function loadAppRegistry() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_APPS_KEY) || '[]');
      if (Array.isArray(saved)) state.apps = saved;
    } catch (_) {
      state.apps = [];
    }
    state.activeAppId = localStorage.getItem(STORAGE_ACTIVE_ID_KEY) || null;

    // 旧バージョンで単一URLだけ保存していた場合の自動引き継ぎ
    if (state.apps.length === 0) {
      for (const k of LEGACY_URL_KEYS) {
        const legacy = (localStorage.getItem(k) || '').trim();
        if (legacy && legacy.startsWith('http')) {
          const item = { id: 'app_' + Date.now(), url: legacy, name: '登録済みアプリ', customName: '', color: '#1e3a8a' };
          state.apps.push(item);
          state.activeAppId = item.id;
          saveAppRegistry();
          break;
        }
      }
    }

    // 共有URL (?gas=...) から開かれた場合は自動でリスト追加＆接続切替
    const params = new URLSearchParams(window.location.search);
    const sharedGas = (params.get('gas') || '').trim();
    const sharedName = (params.get('name') || '').trim();
    if (sharedGas && sharedGas.startsWith('http')) {
      let found = state.apps.find((a) => a.url === sharedGas);
      if (!found) {
        found = {
          id: 'app_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          url: sharedGas,
          name: sharedName || '新規共有アプリ',
          customName: '',
          color: '#1e3a8a'
        };
        state.apps.push(found);
        showToast('共有アプリを切替リストへ自動登録しました');
      }
      state.activeAppId = found.id;
      saveAppRegistry();

      // URLの ?gas=... を消してスッキリさせる
      try {
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (_) {}
    }

    if (!getActiveApp() && state.apps.length > 0) {
      state.activeAppId = state.apps[0].id;
      saveAppRegistry();
    }
  }

  function saveAppRegistry() {
    localStorage.setItem(STORAGE_APPS_KEY, JSON.stringify(state.apps));
    if (state.activeAppId) {
      localStorage.setItem(STORAGE_ACTIVE_ID_KEY, state.activeAppId);
    } else {
      localStorage.removeItem(STORAGE_ACTIVE_ID_KEY);
    }
  }

  function getActiveApp() {
    return state.apps.find((a) => a.id === state.activeAppId) || null;
  }

  function getAppDisplayName(app) {
    return (app.customName && app.customName.trim()) ? app.customName.trim() : (app.name || '名称未取得');
  }

  function renderAppList() {
    if (state.apps.length === 0) {
      el.appListContainer.innerHTML = '<div class="hint">まだアプリが登録されていません。下の欄からGASのURLを追加してください。</div>';
      el.btnCopyCurrentShareUrl.disabled = true;
      return;
    }

    el.btnCopyCurrentShareUrl.disabled = !getActiveApp();
    el.appListContainer.innerHTML = state.apps.map((app) => {
      const isActive = app.id === state.activeAppId;
      const disp = getAppDisplayName(app);
      const sub = app.customName ? ('シート名: ' + (app.name || '未取得')) : app.url;
      return `
        <div class="app-row ${isActive ? 'active' : ''}" data-id="${escapeHtml(app.id)}">
          <span class="app-color-dot" style="background:${escapeHtml(app.color || '#1e3a8a')}"></span>
          <div class="app-row-info" data-action="select" data-id="${escapeHtml(app.id)}">
            <div class="app-row-name">${isActive ? '🟢 ' : ''}${escapeHtml(disp)}</div>
            <div class="app-row-sub">${escapeHtml(sub)}</div>
          </div>
          <div class="app-row-btns">
            <button class="icon-btn" type="button" data-action="rename" data-id="${escapeHtml(app.id)}" title="表示名を変更">✏️</button>
            <button class="icon-btn" type="button" data-action="remove" data-id="${escapeHtml(app.id)}" title="リストから削除">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function switchToApp(appId) {
    const target = state.apps.find((a) => a.id === appId);
    if (!target) return;
    state.activeAppId = target.id;
    saveAppRegistry();
    renderAppList();
    closeModal(el.modalConnect);
    showToast('切替中: ' + getAppDisplayName(target));
    await fetchState(true);
  }

  // ==========================================
  // GAS 通信（CORSプリフライト回避のため text/plain 使用）
  // ==========================================
  async function callGas(payload) {
    const active = getActiveApp();
    if (!active || !active.url) {
      throw new Error('アプリが未接続です。右上の「🔌 未接続」から設定してください');
    }

    const res = await fetch(active.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    if (!res.ok) {
      throw new Error('通信エラー (HTTP ' + res.status + ')');
    }
    const data = await res.json();
    if (!data || data.ok === false) {
      throw new Error((data && data.error) ? data.error : 'GASからエラーが返されました');
    }
    return data;
  }

  async function fetchState(showLoading = false) {
    const active = getActiveApp();
    if (!active) {
      state.connected = false;
      el.btnConnect.textContent = '🔌 未接続';
      el.syncBadge.textContent = '未接続（🔌から登録）';
      return;
    }

    if (showLoading) el.syncBadge.textContent = '同期中…';
    try {
      const data = await callGas({ action: 'poll' });
      applyServerState(data);
    } catch (err) {
      state.connected = false;
      el.btnConnect.textContent = '🔌 接続エラー';
      el.syncBadge.textContent = '通信失敗';
      if (showLoading) showToast(err.message);
    }
  }

  function applyServerState(data) {
    state.connected = true;
    if (data.appTitle) state.appTitle = data.appTitle;
    if (data.settings) state.settings = Object.assign({}, state.settings, data.settings);
    if (Array.isArray(data.logs)) state.logs = data.logs;
    if (data.summary) state.summary = data.summary;
    if (typeof data.slotHistoryCount === 'number') state.slotHistoryCount = data.slotHistoryCount;

    // 現在接続中のアプリ情報（シート名＆テーマ色）を切替リストへ自動反映
    const active = getActiveApp();
    if (active) {
      let dirty = false;
      if (data.appTitle && active.name !== data.appTitle) {
        active.name = data.appTitle;
        dirty = true;
      }
      if (state.settings.confirmBgColor && active.color !== state.settings.confirmBgColor) {
        active.color = state.settings.confirmBgColor;
        dirty = true;
      }
      if (dirty) saveAppRegistry();
    }

    sound.setConfig({
      enabled: state.settings.soundEnabled,
      preset: state.settings.soundPreset
    });

    // ヘッダー表示＆色連動
    const dispTitle = active ? getAppDisplayName(active) : state.appTitle;
    el.appTitleText.textContent = dispTitle;
    document.title = dispTitle;
    applyHeaderTheme(state.settings.confirmBgColor);

    el.btnConnect.textContent = '🔌 接続済';
    el.syncBadge.textContent = '同期済 ' + (data.serverTime || '');

    renderSlotHeaderAndMode();
    renderSummaryAndLogs();
    syncInputLockUi();
  }

  // ==========================================
  // 統一入力ロック管理（カメラ / NFC / スキャナー / 手動）
  // ==========================================
  function isInputBlocked() {
    return state.alertLocked || state.isFetching || state.isSlotBusy;
  }

  function syncInputLockUi() {
    const blocked = isInputBlocked();
    el.scanInput.disabled = blocked;
    el.btnManualSubmit.disabled = blocked;

    // カメラ枠の枠色・状態テキストをリアルタイム更新
    el.cameraPanel.classList.remove('state-busy', 'state-locked', 'state-fast');

    if (state.alertLocked) {
      el.cameraPanel.classList.add('state-locked');
      el.cameraStatusText.textContent = '🔒 🚨重要通知の確認待ち';
    } else if (state.isFetching) {
      el.cameraPanel.classList.add('state-busy');
      el.cameraStatusText.textContent = '⏳ 照合中…';
    } else if (state.isSlotBusy) {
      el.cameraPanel.classList.add('state-busy');
      el.cameraStatusText.textContent = '🎰 スロット演出中…';
    } else if (!state.settings.slotEnabled) {
      el.cameraPanel.classList.add('state-fast');
      el.cameraStatusText.textContent = '⚡ 高速スキャンOK（' + camera.getFacingLabel() + '）';
    } else {
      el.cameraStatusText.textContent = '📷 読取OK（' + camera.getFacingLabel() + '）';
    }
  }

  function updateCameraControls(camInfo) {
    el.cameraPanel.classList.toggle('active', camInfo.active);
    el.btnCameraToggle.classList.toggle('active', camInfo.active);
    el.btnCameraToggle.textContent = camInfo.active ? '📷 カメラ停止' : '📷 カメラQR';

    // ライトボタン（インカメラまたは非対応時は非表示）
    el.btnTorch.style.display = (camInfo.active && camInfo.torchSupported) ? 'inline-block' : 'none';
    el.btnTorch.classList.toggle('lit', camInfo.torchOn);
    el.btnTorch.textContent = camInfo.torchOn ? '🔦 ON' : '🔦';

    syncInputLockUi();
  }

  // ==========================================
  // 🚨 重要通知ロック（2回タップ解除）
  // ==========================================
  function triggerAlertLock(title, detail) {
    state.alertLocked = true;
    state.alertUnlockStep = 0;
    el.alertLockTitle.textContent = title || '🚨 重要通知あり（全入力ロック中）';
    el.alertLockDetail.textContent = detail || '内容を確認してください';
    el.btnAlertUnlock.textContent = '確認しました（1回目タップ）';
    el.btnAlertUnlock.classList.remove('step2');
    el.alertLockBanner.classList.add('active');
    sound.playAlert();
    syncInputLockUi();
  }

  function handleAlertUnlockTap() {
    if (!state.alertLocked) return;
    if (state.alertUnlockStep === 0) {
      state.alertUnlockStep = 1;
      el.btnAlertUnlock.textContent = '本当にロックを解除する（2回目タップ）';
      el.btnAlertUnlock.classList.add('step2');
    } else {
      state.alertLocked = false;
      state.alertUnlockStep = 0;
      el.alertLockBanner.classList.remove('active');
      syncInputLockUi();
      focusScannerIfNeeded();
      showToast('ロックを解除しました');
    }
  }

  // ==========================================
  // 打刻送信 ＆ スロット演出制御
  // ==========================================
  async function submitCheckin(rawCode, source) {
    const code = String(rawCode || '').trim();
    if (!code) return;

    // 入力ロック中に物理スキャナー等が入力した場合は即捨てて混入を防止
    if (isInputBlocked()) {
      el.scanInput.value = '';
      return;
    }

    if (!getActiveApp()) {
      showToast('先に「🔌 未接続」からアプリを接続してください');
      openModal(el.modalConnect);
      return;
    }

    sound.ensureContext();
    el.scanInput.value = '';
    state.isFetching = true;
    syncInputLockUi();

    // スロットONなら通信開始と同時にリール仮回転スタート
    if (state.settings.slotEnabled) {
      startReelPreSpin();
    } else {
      el.resultStatusBadge.textContent = '⚡ 照合中…';
    }

    try {
      const data = await callGas({ action: 'checkin', code });
      applyServerState(data);
      renderLatestResult(data);

      // 重複チェック
      if (data.isDuplicate) {
        stopReelImmediately(['⚠️', '⚠️', '⚠️'], '⚠️ 本日すでに打刻済みです', false);
        sound.playDup();
        state.isFetching = false;
        syncInputLockUi();
        focusScannerIfNeeded();
        return;
      }

      // 🚨 重要通知または未登録アラート
      if (data.isAlert) {
        const entryName = data.entry ? data.entry.formatted : code;
        const noticeText = data.entry ? data.entry.notice : data.alertReason;
        triggerAlertLock('🚨 ' + (data.alertReason || '重要通知あり'), entryName + ' ／ ' + noticeText);
      }

      // スロットOFF（自動高速打刻モード）
      if (!state.settings.slotEnabled || !data.slot || !data.slot.enabled) {
        if (!data.isAlert) sound.playFastOk();
        state.isFetching = false;
        state.isSlotBusy = false;
        syncInputLockUi();
        focusScannerIfNeeded();
        return;
      }

      // スロットON：結果確定演出＋結果後2秒間の全入力ロック
      state.isFetching = false;
      state.isSlotBusy = true;
      syncInputLockUi();
      runSlotResultAnimation(data.slot, data.isAlert);

    } catch (err) {
      stopReelImmediately(['❌', '❌', '❌'], '通信エラー: ' + err.message, false);
      state.isFetching = false;
      state.isSlotBusy = false;
      syncInputLockUi();
      showToast('打刻エラー: ' + err.message);
      focusScannerIfNeeded();
    }
  }

  function renderLatestResult(data) {
    const entry = data.entry || {};
    el.resultCard.classList.remove('is-ok', 'is-dup', 'is-warn');

    if (data.isDuplicate) {
      el.resultCard.classList.add('is-dup');
      el.resultStatusBadge.textContent = '⚠️ 重複打刻';
    } else if (data.isAlert) {
      el.resultCard.classList.add('is-warn');
      el.resultStatusBadge.textContent = '🚨 要確認';
    } else if (!state.settings.slotEnabled) {
      el.resultCard.classList.add('is-ok');
      el.resultStatusBadge.textContent = '⚡ 高速打刻OK';
    } else {
      el.resultCard.classList.add('is-ok');
      el.resultStatusBadge.textContent = '✅ 打刻完了';
    }

    el.resultName.textContent = entry.formatted || entry.rawCode || '---';
    el.resultNotice.textContent = entry.notice || '';
    el.resultSub.textContent = (entry.timestamp || '') + (entry.slotResult && entry.slotResult !== 'OFF' ? ' / ' + entry.slotResult : '');
  }

  // ==========================================
  // スロット回転アニメーション（タップ即停止＆2秒クールダウン）
  // ==========================================
  function clearSlotTimers() {
    if (state.slotRun) {
      if (state.slotRun.intervalId) clearInterval(state.slotRun.intervalId);
      state.slotRun.timers.forEach((t) => clearTimeout(t));
      state.slotRun = null;
    }
    if (state.cooldownTimer) {
      clearTimeout(state.cooldownTimer);
      state.cooldownTimer = null;
    }
  }

  function startReelPreSpin() {
    clearSlotTimers();
    el.reelArea.classList.remove('big-win');
    el.reelArea.classList.add('spinning');
    el.slotMessage.className = 'slot-msg muted';
    el.slotMessage.textContent = '🎰 抽選中…（タップで即停止）';

    const stopped = [false, false, false];
    el.reels.forEach((r) => r.classList.add('spin-blur'));

    const intervalId = setInterval(() => {
      for (let i = 0; i < 3; i++) {
        if (!stopped[i]) {
          el.reels[i].textContent = REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)];
        }
      }
      sound.playTick();
    }, 75);

    state.slotRun = { intervalId, stopped, timers: [], finalSlot: null, isAlert: false };
  }

  function runSlotResultAnimation(slot, isAlert) {
    if (!state.slotRun) startReelPreSpin();
    state.slotRun.finalSlot = slot;
    state.slotRun.isAlert = isAlert;

    const finalReels = Array.isArray(slot.reels) && slot.reels.length === 3 ? slot.reels : ['🌸', '7️⃣', '🌸'];
    const stopDelays = [500, 950, 1450];

    stopDelays.forEach((ms, idx) => {
      const t = setTimeout(() => {
        if (!state.slotRun) return;
        state.slotRun.stopped[idx] = true;
        el.reels[idx].classList.remove('spin-blur');
        el.reels[idx].textContent = finalReels[idx];
        if (!isAlert) sound.playReelStop(idx);

        if (idx === 2) {
          finishSlotSpin(slot, isAlert, 2000); // 結果表示後2秒間ロック
        }
      }, ms);
      state.slotRun.timers.push(t);
    });
  }

  function instantStopSlot() {
    if (!state.slotRun || !state.slotRun.finalSlot) return;
    const { finalSlot, isAlert } = state.slotRun;
    const finalReels = finalSlot.reels || ['🌸', '7️⃣', '🌸'];

    clearSlotTimers();
    for (let i = 0; i < 3; i++) {
      el.reels[i].classList.remove('spin-blur');
      el.reels[i].textContent = finalReels[i];
    }
    // 即停止時は待ち時間を短縮（0.45秒だけ誤タップ防止）してすぐ次へ進める
    finishSlotSpin(finalSlot, isAlert, 450);
  }

  function finishSlotSpin(slot, isAlert, cooldownMs) {
    clearSlotTimers();
    el.reelArea.classList.remove('spinning');
    el.reels.forEach((r) => r.classList.remove('spin-blur'));

    if (slot.isBig) el.reelArea.classList.add('big-win');

    const extra = slot.fairInfo ? ' [' + slot.fairInfo + ']' : '';
    el.slotMessage.textContent = (slot.label || '') + extra;
    el.slotMessage.className = 'slot-msg ' + (slot.isWin ? 'win' : 'muted');

    if (!isAlert) {
      if (slot.isBig) sound.playWinBig();
      else if (slot.isWin) sound.playWinSmall();
      else sound.playMiss();
    }

    // 結果表示後の自動クールダウン
    state.isSlotBusy = true;
    syncInputLockUi();

    state.cooldownTimer = setTimeout(() => {
      state.cooldownTimer = null;
      state.isSlotBusy = false;
      syncInputLockUi();
      focusScannerIfNeeded();
    }, cooldownMs);
  }

  function stopReelImmediately(reels, msg, isWin) {
    clearSlotTimers();
    el.reelArea.classList.remove('spinning', 'big-win');
    el.reels.forEach((r, i) => {
      r.classList.remove('spin-blur');
      if (reels && reels[i]) r.textContent = reels[i];
    });
    el.slotMessage.textContent = msg || '';
    el.slotMessage.className = 'slot-msg ' + (isWin ? 'win' : 'muted');
  }

  // ==========================================
  // スロット枠・ログ描画
  // ==========================================
  function renderSlotHeaderAndMode() {
    const enabled = Boolean(state.settings.slotEnabled);
    const isFair = state.settings.slotMode === 'fair';

    // スロットON/OFF切替ボタン＆折りたたみ
    el.btnSlotToggle.textContent = enabled ? '🎰 スロットON' : '⚡ スロットOFF';
    el.btnSlotToggle.className = 'mini-btn ' + (enabled ? 'on' : 'off');
    el.slotBody.style.display = enabled ? 'block' : 'none';
    el.slotOffBar.classList.toggle('active', !enabled);

    // モードバッジ
    if (!enabled) {
      el.slotModeBadge.textContent = '自動高速';
      el.slotModeBadge.className = 'mode-pill off';
    } else if (isFair) {
      el.slotModeBadge.textContent = '満遍なく(上限' + state.settings.fairLimit + ')';
      el.slotModeBadge.className = 'mode-pill fair';
    } else {
      el.slotModeBadge.textContent = '通常';
      el.slotModeBadge.className = 'mode-pill';
    }

    // 音ON/OFFボタン
    const soundOn = Boolean(state.settings.soundEnabled);
    el.btnSoundToggle.textContent = soundOn ? '🔊 音ON' : '🔇 消音';
    el.btnSoundToggle.className = 'mini-btn ' + (soundOn ? 'on' : '');
  }

  function renderSummaryAndLogs() {
    el.statValid.textContent = state.summary.valid || 0;
    el.statTotal.textContent = state.summary.total || 0;
    el.statShiny.textContent = state.summary.shiny || 0;
    el.statEvent.textContent = state.summary.event || 0;
    el.statUnconfirmed.textContent = state.summary.unconfirmed || 0;

    if (!state.logs || state.logs.length === 0) {
      el.logList.innerHTML = '<div class="hint" style="text-align:center; padding:16px 0;">まだ本日の打刻はありません</div>';
      return;
    }

    const statuses = ['', '色違', 'Evnt', 'Evnt/色違', '取消'];
    el.logList.innerHTML = state.logs.map((row) => {
      const isCanceled = row.status === '取消';
      const hasNotice = row.notice && row.notice.indexOf('🏆') !== -1;
      const isConfirmed = row.confirmed === '確';
      const rowCls = [
        'log-item',
        isCanceled ? 'canceled' : '',
        (hasNotice && !isConfirmed && !isCanceled) ? 'has-notice' : '',
        isConfirmed ? 'confirmed-row' : ''
      ].join(' ');

      const options = statuses.map((st) => {
        const label = st === '' ? '状態なし' : st;
        return `<option value="${escapeHtml(st)}" ${row.status === st ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');

      const timeShort = (row.timestamp || '').split(' ')[1] || row.timestamp || '';
      const slotTag = row.slotResult && row.slotResult !== '-' ? ` [${escapeHtml(row.slotResult)}]` : '';

      return `
        <div class="${rowCls}">
          <div class="log-top">
            <div class="log-name">${escapeHtml(row.formatted || row.rawCode)}</div>
            <div class="log-meta">${escapeHtml(timeShort)}${slotTag}</div>
          </div>
          ${row.notice ? `<div class="log-notice-line">${escapeHtml(row.notice)}</div>` : ''}
          <div class="log-controls">
            <select class="log-select" data-action="status" data-row="${row.rowNumber}">${options}</select>
            <button class="btn-confirm ${isConfirmed ? 'done' : ''}" type="button" data-action="confirm" data-row="${row.rowNumber}">
              ${isConfirmed ? '✅ 確済' : '確'}
            </button>
            <button class="btn-del" type="button" data-action="delete" data-row="${row.rowNumber}">削除</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // 設定・管理モーダル
  // ==========================================
  function openModal(modalEl) {
    modalEl.classList.add('open');
  }
  function closeModal(modalEl) {
    modalEl.classList.remove('open');
  }

  function initColorSwatches() {
    el.bgColorSwatches.innerHTML = COLOR_SWATCHES.map((c) => (
      `<button type="button" class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
    )).join('');

    el.bgColorSwatches.addEventListener('click', (e) => {
      const btn = e.target.closest('.swatch');
      if (!btn) return;
      const c = btn.dataset.color;
      el.inputConfirmBgColor.value = c;
      updateBgPreview(c);
    });

    el.inputConfirmBgColor.addEventListener('input', (e) => {
      updateBgPreview(e.target.value);
    });
  }

  function populateSettingsModal() {
    const s = state.settings;
    el.inputConfirmBgColor.value = s.confirmBgColor || '#fff2cc';
    updateBgPreview(el.inputConfirmBgColor.value);

    el.setSlotEnabled.value = String(Boolean(s.slotEnabled));
    el.setSlotMode.value = s.slotMode === 'fair' ? 'fair' : 'normal';
    el.setFairLimit.value = String(s.fairLimit || 1);
    el.setSoundPreset.value = s.soundPreset || 'classic';

    el.setProb777.value = s.prob777;
    el.setProbSakura.value = s.probSakura;
    el.setProbBar.value = s.probBar;
    el.setProbBell.value = s.probBell;
    el.setProbGrape.value = s.probGrape;
    el.setProbCherry.value = s.probCherry;

    el.historyCountHint.textContent = '現在のスロット履歴件数（満遍なくモード記録）：' + state.slotHistoryCount + '件';
  }

  async function saveSettingsToGas(partialSettings) {
    const merged = Object.assign({}, state.settings, partialSettings);
    const data = await callGas({ action: 'saveSettings', settings: merged });
    applyServerState(data);
  }

  function populateAdminModal() {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    if (!el.adminEventDate.value) el.adminEventDate.value = mm + dd;
    if (!el.adminEventTime.value) el.adminEventTime.value = hh + mi;
    el.adminResultLog.textContent = '';
  }

  function focusScannerIfNeeded() {
    if (camera.active || isInputBlocked()) return;
    if (el.modalConnect.classList.contains('open') ||
        el.modalSettings.classList.contains('open') ||
        el.modalAdmin.classList.contains('open')) return;
    if (!state.kbdOn) {
      el.scanInput.setAttribute('inputmode', 'none');
      el.scanInput.focus({ preventScroll: true });
    }
  }

  // ==========================================
  // イベントリスナー登録
  // ==========================================
  function bindEvents() {
    // ヘッダーボタン
    el.btnConnect.addEventListener('click', () => {
      renderAppList();
      openModal(el.modalConnect);
    });
    el.btnSettings.addEventListener('click', () => {
      if (!getActiveApp()) {
        showToast('先にアプリを接続してください');
        openModal(el.modalConnect);
        return;
      }
      populateSettingsModal();
      openModal(el.modalSettings);
    });
    el.btnAdmin.addEventListener('click', () => {
      if (!getActiveApp()) {
        showToast('先にアプリを接続してください');
        openModal(el.modalConnect);
        return;
      }
      populateAdminModal();
      openModal(el.modalAdmin);
    });

    // モーダル閉じる
    el.btnCloseConnect.addEventListener('click', () => closeModal(el.modalConnect));
    el.btnCloseSettings.addEventListener('click', () => closeModal(el.modalSettings));
    el.btnCloseAdmin.addEventListener('click', () => closeModal(el.modalAdmin));
    [el.modalConnect, el.modalSettings, el.modalAdmin].forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m) closeModal(m);
      });
    });

    // 🚨 ロック解除（2回タップ）
    el.btnAlertUnlock.addEventListener('click', handleAlertUnlockTap);

    // スロット枠タップ即停止
    el.reelArea.addEventListener('click', () => {
      if (state.slotRun && state.slotRun.finalSlot) {
        instantStopSlot();
      }
    });

    // スロットON/OFF クイック切替（誤操作防止の確認付き）
    async function toggleSlotEnabledQuick(targetBool) {
      if (!getActiveApp()) return showToast('先にアプリを接続してください');
      const msg = targetBool
        ? '🎰 スロット抽選を ON にしますか？'
        : '⚡ スロットを OFF にして「自動高速打刻モード」に切り替えますか？';
      if (!window.confirm(msg)) return;
      try {
        await saveSettingsToGas({ slotEnabled: targetBool });
        showToast(targetBool ? '🎰 スロットONに切り替えました' : '⚡ スロットOFF（高速打刻モード）にしました');
      } catch (err) {
        showToast('切替失敗: ' + err.message);
      }
    }
    el.btnSlotToggle.addEventListener('click', () => toggleSlotEnabledQuick(!state.settings.slotEnabled));
    el.btnSlotTurnOn.addEventListener('click', () => toggleSlotEnabledQuick(true));

    // 効果音ON/OFF切替
    el.btnSoundToggle.addEventListener('click', async () => {
      sound.ensureContext();
      const next = !state.settings.soundEnabled;
      state.settings.soundEnabled = next;
      sound.setConfig({ enabled: next });
      renderSlotHeaderAndMode();
      if (getActiveApp()) {
        try { await saveSettingsToGas({ soundEnabled: next }); } catch (_) {}
      }
    });

    // カメラ起動・停止 / 前後切替 / ライト
    el.btnCameraToggle.addEventListener('click', async () => {
      sound.ensureContext();
      if (camera.active) {
        camera.stop();
        showToast('カメラを停止しました');
      } else {
        try {
          await camera.start();
          showToast('カメラ起動（' + camera.getFacingLabel() + '）');
        } catch (err) {
          showToast('カメラ起動失敗: ' + err.message);
        }
      }
    });

    el.btnCameraSwitch.addEventListener('click', async () => {
      try {
        await camera.switchCamera();
        showToast(camera.getFacingLabel() + 'に切り替えました');
      } catch (err) {
        showToast('カメラ切替失敗: ' + err.message);
      }
    });

    el.btnTorch.addEventListener('click', async () => {
      try {
        const lit = await camera.toggleTorch();
        showToast(lit ? '🔦 ライトON' : 'ライトOFF');
      } catch (err) {
        showToast(err.message);
      }
    });

    // NFC 起動・停止
    el.btnNfcToggle.addEventListener('click', async () => {
      sound.ensureContext();
      if (nfc.active) {
        nfc.stop();
        showToast('NFC待機を停止しました');
      } else {
        try {
          await nfc.start();
          showToast('📡 NFC待機中：カードをかざしてください');
        } catch (err) {
          showToast(err.message);
        }
      }
    });

    // ソフトキーボード抑制切替
    el.btnKbdToggle.addEventListener('click', () => {
      state.kbdOn = !state.kbdOn;
      el.scanInput.setAttribute('inputmode', state.kbdOn ? 'text' : 'none');
      el.btnKbdToggle.textContent = state.kbdOn ? '⌨️ ON' : '⌨️ OFF';
      el.scanInput.focus();
      showToast(state.kbdOn ? '⌨️ キーボード入力ON' : '⌨️ キーボード抑制（スキャナー用）');
    });

    // 物理スキャナー・手入力送信
    el.scanForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = el.scanInput.value;
      submitCheckin(val, 'scanner');
    });

    // ログ更新・操作
    el.btnRefresh.addEventListener('click', () => fetchState(true));

    el.logList.addEventListener('change', async (e) => {
      const sel = e.target.closest('select[data-action="status"]');
      if (!sel) return;
      const rowNumber = Number(sel.dataset.row);
      try {
        const data = await callGas({ action: 'updateStatus', rowNumber, status: sel.value });
        applyServerState(data);
        showToast('状態を更新しました');
      } catch (err) {
        showToast('更新失敗: ' + err.message);
        fetchState(false);
      }
    });

    el.logList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const rowNumber = Number(btn.dataset.row);

      if (action === 'confirm') {
        try {
          const data = await callGas({ action: 'confirmRow', rowNumber });
          applyServerState(data);
          showToast('確認マークを更新しました');
        } catch (err) {
          showToast('更新失敗: ' + err.message);
        }
      } else if (action === 'delete') {
        if (!window.confirm('この打刻行を削除してもよろしいですか？')) return;
        try {
          const data = await callGas({ action: 'deleteRow', rowNumber });
          applyServerState(data);
          showToast('行を削除しました');
        } catch (err) {
          showToast('削除失敗: ' + err.message);
        }
      }
    });

    // 複数アプリリスト操作
    el.appListContainer.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      const id = target.dataset.id;
      const app = state.apps.find((a) => a.id === id);
      if (!app) return;

      if (action === 'select') {
        switchToApp(id);
      } else if (action === 'rename') {
        const nextName = window.prompt(
          'このスマホでの表示名を入力してください。\n（空欄でOKするとスプレッドシート名に自動で戻ります）',
          app.customName || app.name || ''
        );
        if (nextName === null) return;
        app.customName = nextName.trim();
        saveAppRegistry();
        renderAppList();
        if (app.id === state.activeAppId) {
          el.appTitleText.textContent = getAppDisplayName(app);
          document.title = getAppDisplayName(app);
        }
        showToast('表示名を更新しました');
      } else if (action === 'remove') {
        if (!window.confirm('「' + getAppDisplayName(app) + '」を切替リストから削除しますか？\n（スプレッドシート本体は消えません）')) return;
        state.apps = state.apps.filter((a) => a.id !== id);
        if (state.activeAppId === id) {
          state.activeAppId = state.apps.length > 0 ? state.apps[0].id : null;
        }
        saveAppRegistry();
        renderAppList();
        fetchState(true);
      }
    });

    el.btnAddApp.addEventListener('click', async () => {
      const url = el.inputGasUrl.value.trim();
      const customName = el.inputAppName.value.trim();
      if (!url.startsWith('https://script.google.com/')) {
        showToast('GASのウェブアプリURL（https://script.google.com/...）を入力してください');
        return;
      }

      let existing = state.apps.find((a) => a.url === url);
      if (existing) {
        if (customName) existing.customName = customName;
        state.activeAppId = existing.id;
      } else {
        const created = {
          id: 'app_' + Date.now(),
          url,
          name: customName || '接続中…',
          customName,
          color: '#1e3a8a'
        };
        state.apps.push(created);
        state.activeAppId = created.id;
      }

      saveAppRegistry();
      el.inputGasUrl.value = '';
      el.inputAppName.value = '';
      renderAppList();
      closeModal(el.modalConnect);
      await fetchState(true);
      showToast('接続先を保存しました');
    });

    el.btnCopyCurrentShareUrl.addEventListener('click', async () => {
      const active = getActiveApp();
      if (!active) return;
      const shareUrl = window.location.origin + window.location.pathname + '?gas=' + encodeURIComponent(active.url);
      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('📋 共有URLをコピーしました（開くだけで自動登録）');
      } catch (_) {
        window.prompt('下の共有URLをコピーしてください', shareUrl);
      }
    });

    // 設定モーダル操作
    el.btnTestSound.addEventListener('click', () => {
      sound.setConfig({ preset: el.setSoundPreset.value });
      sound.playPreview();
    });

    el.btnSaveSettings.addEventListener('click', async () => {
      try {
        await saveSettingsToGas({
          confirmBgColor: el.inputConfirmBgColor.value,
          slotEnabled: el.setSlotEnabled.value === 'true',
          slotMode: el.setSlotMode.value,
          fairLimit: Number(el.setFairLimit.value) || 1,
          soundPreset: el.setSoundPreset.value,
          prob777: Number(el.setProb777.value) || 0,
          probSakura: Number(el.setProbSakura.value) || 0,
          probBar: Number(el.setProbBar.value) || 0,
          probBell: Number(el.setProbBell.value) || 0,
          probGrape: Number(el.setProbGrape.value) || 0,
          probCherry: Number(el.setProbCherry.value) || 0
        });
        closeModal(el.modalSettings);
        showToast('💾 設定を保存しました');
      } catch (err) {
        showToast('保存失敗: ' + err.message);
      }
    });

    el.btnResetHistory.addEventListener('click', async () => {
      if (!window.confirm('「スロット履歴」シートをすべてリセットしますか？\n（満遍なく当選モードの過去カウントが0に戻ります）')) return;
      try {
        const data = await callGas({ action: 'resetSlotHistory' });
        applyServerState(data);
        populateSettingsModal();
        showToast(data.message || 'スロット履歴をリセットしました');
      } catch (err) {
        showToast('リセット失敗: ' + err.message);
      }
    });

    el.btnClearCache.addEventListener('click', async () => {
      try {
        const data = await callGas({ action: 'clearCache' });
        applyServerState(data);
        showToast(data.message || 'マスターキャッシュを更新しました');
      } catch (err) {
        showToast('キャッシュ更新失敗: ' + err.message);
      }
    });

    // 管理モーダル操作
    el.btnBackupTransfer.addEventListener('click', async () => {
      if (!window.confirm('バックアップ保存と外部シートへの転記を実行しますか？')) return;
      el.adminResultLog.textContent = '実行中…';
      try {
        const data = await callGas({
          action: 'backupAndTransfer',
          eventDate: el.adminEventDate.value.trim(),
          eventTime: el.adminEventTime.value.trim()
        });
        applyServerState(data);
        el.adminResultLog.textContent = data.message || '完了しました';
        showToast('転記が完了しました');
      } catch (err) {
        el.adminResultLog.textContent = 'エラー: ' + err.message;
        showToast('転記エラー: ' + err.message);
      }
    });

    el.btnInitTodayLog.addEventListener('click', async () => {
      if (!window.confirm('本日の打刻ログを初期化しますか？\n（バックアップフォルダ設定時は自動BK後にクリアされます。スロット履歴は消えません）')) return;
      el.adminResultLog.textContent = '初期化中…';
      try {
        const data = await callGas({ action: 'initTodayLog', doBackup: true });
        applyServerState(data);
        el.adminResultLog.textContent = data.message || '初期化しました';
        showToast('本日の打刻ログを初期化しました');
      } catch (err) {
        el.adminResultLog.textContent = 'エラー: ' + err.message;
        showToast('初期化エラー: ' + err.message);
      }
    });
  }

  // ==========================================
  // 起動処理
  // ==========================================
  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!getActiveApp() || isInputBlocked()) return;
      if (el.modalSettings.classList.contains('open') || el.modalAdmin.classList.contains('open')) return;
      fetchState(false);
    }, 15000);
  }

  function boot() {
    initColorSwatches();
    bindEvents();
    loadAppRegistry();
    renderAppList();
    renderSlotHeaderAndMode();
    syncInputLockUi();

    if (getActiveApp()) {
      fetchState(true);
    } else {
      openModal(el.modalConnect);
    }
    startPolling();
  }

  boot();
})();

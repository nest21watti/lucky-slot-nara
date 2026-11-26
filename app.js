// =========================================================================
// app.js : 打刻・Luckyスロット(ON/OFF・一括ロック)・ヘッダー色連動・E列リンク化・サウンド・🚨ロック・締め作業
// =========================================================================

// =========================================================================
// ★バージョン番号・初期タイトル設定（ここを書き換えるだけで画面全体に反映）
//   例：const APP_VERSION = 'v1.0';  （空欄 '' のままならバージョン非表示）
// =========================================================================
const APP_VERSION = '';
const DEFAULT_APP_TITLE = 'Pokémon GO 奈良 打刻Web Luckyスロット';

const LOCAL_SOUND_KEY = 'NARA_SLOT_SOUNDS_FINAL_V2';
const LOCAL_REEL_STYLE_KEY = 'NARA_SLOT_REEL_STYLE_FINAL_V1';
const DEFAULT_SOUNDS = { spin: 'basic', ok: 'basic', win: 'basic', fanfare: 'basic', buzzer: 'basic' };

let state = { rows: [], fList: [], gList: [], settings: null, destUrls: {}, hash: '' };
let activeSounds = loadLocalSounds();
let activeReelStyle = loadLocalReelStyle();
let currentReelSymbols = ['7', '7', '7'];

let isManualKb = false;
let isPolling = true;
let pollTimer = null;
let pauseUntil = 0;
let scanTimer = null;
let lastScanStr = '';
let lastScanTime = 0;
let isMuted = false;
let isBusyOverlayVisible = false;
let isSubmittingScan = false;
let isSlotInputLocked = false; // スロット回転中＋結果表示後2秒間の一括ロックフラグ
window.isDropdownActive = false;

// 共有AudioContext＆タイマー管理
let sharedAudioCtx = null;
let spinSoundTimer = null;
let spinTickStep = 0;
let testSpinTimeout = null;
let alertSoundTimer = null;
let toastTimer = null;
let slotCooldownTimer = null;

// 🚨 永続フラッシュ＆完全スキャンロック（0.5秒以上間隔2回タップ解除用）
let isAlertFlashing = false;
let isAlertLocked = false;
let alertTapCount = 0;
let alertFirstTapTime = 0;
let lastLockWarnTime = 0;

// スロット演出用（3リール順番停止＆即停止対応）
let reelIntervals = [null, null, null];
let stopTimers = [null, null, null];
let isSpinning = false;
let pendingSlotContext = null;
let forceStopRequested = false;
let slotFinalized = false;
const REEL_POOL = ['7', '🌸', 'BAR', '🔔', '🍇', '🍒'];

// 当選者シート編集用
let lastWinnerData = null;
let winnerViewMode = 'table';
let winnerCellStore = {};
let winnerColHeaderStore = {};

window.onload = function() {
  if (typeof initDeviceLayer === 'function') initDeviceLayer();
  initAudioUnlockListeners();
  initScanListeners();
  initFocusGuardListeners();
  renderAllReels(currentReelSymbols);
  renderSlotPowerState();

  const initialName = (typeof getActiveAppDisplayName === 'function' && getActiveAppDisplayName())
    ? getActiveAppDisplayName()
    : DEFAULT_APP_TITLE;
  updateHeaderTitleUi(initialName);
  renderSettingsVersionFoot();

  if (typeof getGasApiUrl === 'function' && getGasApiUrl()) {
    fetchDashboard(true);
  } else if (typeof openGasUrlModal === 'function') {
    openGasUrlModal();
  }

  startPolling();
  setTimeout(() => focusScanInput(), 150);
};

// =========================================================================
// ヘッダータイトル ＆ バージョン表記制御
// =========================================================================
function updateHeaderTitleUi(baseTitle) {
  const cleanTitle = String(baseTitle || '').trim() || DEFAULT_APP_TITLE;
  const ver = String(APP_VERSION || '').trim();
  const fullText = ver ? (cleanTitle + ' ' + ver) : cleanTitle;

  const titleEl = document.getElementById('header-ss-name');
  if (titleEl) titleEl.innerText = fullText;
  document.title = fullText;
}

function renderSettingsVersionFoot() {
  const foot = document.getElementById('settings-app-version');
  if (!foot) return;
  const ver = String(APP_VERSION || '').trim();
  if (ver) {
    foot.innerText = 'App Version: ' + ver;
    foot.style.display = 'block';
  } else {
    foot.innerText = '';
    foot.style.display = 'none';
  }
}

// =========================================================================
// スロットON/OFF状態判定 ＆ ヘッダー背景色連動
// =========================================================================
function isSlotFeatureEnabled() {
  if (!state.settings) return true;
  return state.settings.slotEnabled !== false;
}

function isLightHexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6;
}

function applyHeaderColor(hexColor) {
  const header = document.getElementById('top-header');
  if (!header) return;
  const color = /^#[0-9a-fA-F]{6}$/.test(String(hexColor || '')) ? hexColor : '#1e3a8a';
  header.style.backgroundColor = color;
  header.classList.toggle('light-bg', isLightHexColor(color));
}

function syncAllInputLockStates() {
  const blocked = isAlertLocked || isSubmittingScan || isSlotInputLocked;
  const inp = document.getElementById('scan-input');
  const sendBtn = document.getElementById('send-btn');

  if (inp && !isAlertLocked) {
    inp.disabled = blocked;
  }
  if (sendBtn && !isAlertLocked) {
    sendBtn.disabled = blocked;
  }
  if (typeof updateCameraStatusUi === 'function') {
    updateCameraStatusUi();
  }
}

function renderSlotPowerState() {
  const enabled = isSlotFeatureEnabled();
  const card = document.getElementById('slot-card');
  const reelsWrap = document.getElementById('slot-reels-wrap');
  const btn = document.getElementById('slot-power-btn');
  const badge = document.getElementById('slot-mode-badge');

  if (card) card.classList.toggle('slot-disabled-card', !enabled);
  if (reelsWrap) reelsWrap.style.display = enabled ? 'block' : 'none';
  if (btn) {
    btn.innerText = enabled ? '🎰 スロットON' : '⚡ スロットOFF';
    btn.className = 'slot-power-btn' + (enabled ? '' : ' is-off');
  }
  if (badge) {
    if (!enabled) {
      badge.innerText = '⚡ 自動高速打刻モード（スロットOFF）';
    } else {
      const modeTxt = (state.settings && state.settings.slotMode === 'fair') ? '⚖️ 満遍なく当選モード' : '🎲 通常モード';
      badge.innerText = '🎰 ' + modeTxt;
    }
  }
  if (typeof updateCameraStatusUi === 'function') {
    updateCameraStatusUi();
  }
}

function toggleSlotPower() {
  if (!state.settings) {
    showToast('⏳ データを読み込み中です');
    return;
  }
  if (isSpinning || isSubmittingScan || isSlotInputLocked) {
    showToast('⏳ 打刻・演出の完了後に切り替えてください');
    return;
  }
  const nextEnabled = !isSlotFeatureEnabled();
  const msg = nextEnabled
    ? '🎰 スロット抽選を ON に切り替えますか？'
    : '⚡ スロットを OFF にして「自動高速打刻モード」に切り替えますか？';
  if (!confirm(msg)) return;

  const payload = Object.assign({}, state.settings, { slotEnabled: nextEnabled });
  showBusy('⏳ モード切替中...');
  callGasApi('saveSettings', [payload])
    .then(function(dash) {
      hideBusy();
      applyDashboard(dash);
      showToast(nextEnabled ? '🎰 スロットONに切り替えました' : '⚡ スロットOFF（自動高速打刻モード）にしました');
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    })
    .catch(function(err) {
      hideBusy();
      alert(err.message || err);
    });
}

// =========================================================================
// ローカル設定・リール描画
// =========================================================================
function loadLocalSounds() {
  try {
    const raw = localStorage.getItem(LOCAL_SOUND_KEY);
    if (raw) return Object.assign({}, DEFAULT_SOUNDS, JSON.parse(raw));
  } catch (e) {}
  return Object.assign({}, DEFAULT_SOUNDS);
}

function saveLocalSounds(sndObj) {
  activeSounds = Object.assign({}, DEFAULT_SOUNDS, sndObj || {});
  try { localStorage.setItem(LOCAL_SOUND_KEY, JSON.stringify(activeSounds)); } catch (e) {}
}

function loadLocalReelStyle() {
  try {
    const v = localStorage.getItem(LOCAL_REEL_STYLE_KEY);
    if (v === 'modern' || v === 'legacy') return v;
  } catch (e) {}
  return 'legacy';
}

function saveLocalReelStyle(styleVal) {
  activeReelStyle = (styleVal === 'modern') ? 'modern' : 'legacy';
  try { localStorage.setItem(LOCAL_REEL_STYLE_KEY, activeReelStyle); } catch (e) {}
  renderAllReels(currentReelSymbols);
}

function normalizeReelToken(sym) {
  const s = String(sym || '');
  if (s === '7' || s === '7️⃣') return '7';
  if (s === 'BAR' || s === '💳') return 'BAR';
  return s;
}

function setReelCell(idx, rawSym) {
  const el = document.getElementById('reel-' + idx);
  if (!el) return;
  const token = normalizeReelToken(rawSym);
  currentReelSymbols[idx] = token;

  if (activeReelStyle === 'legacy') {
    if (token === '7') {
      el.className = 'reel legacy-base legacy-7';
      el.innerText = '7';
    } else if (token === 'BAR') {
      el.className = 'reel legacy-base legacy-bar';
      el.innerText = 'BAR';
    } else {
      el.className = 'reel legacy-base';
      el.innerText = token;
    }
  } else {
    el.className = 'reel';
    if (token === '7') el.innerText = '7️⃣';
    else if (token === 'BAR') el.innerText = '💳';
    else el.innerText = token;
  }
}

function renderAllReels(symbols) {
  for (let i = 0; i < 3; i++) {
    setReelCell(i, symbols[i] !== undefined ? symbols[i] : '7');
  }
}

function getAudioCtx() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx) sharedAudioCtx = new AudioCtx();
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function initAudioUnlockListeners() {
  const unlock = () => { getAudioCtx(); };
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('click', unlock, { passive: true });
  document.addEventListener('keydown', unlock, { passive: true });
}

function showBusy(msg) {
  isBusyOverlayVisible = true;
  document.getElementById('busy-msg').innerText = msg || '⏳ 処理中です...';
  document.getElementById('busy-overlay').style.display = 'flex';
}

function hideBusy() {
  isBusyOverlayVisible = false;
  document.getElementById('busy-overlay').style.display = 'none';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}

function isAnyModalOpen() {
  return ['modal-gas-url', 'modal-full', 'modal-settings', 'modal-log-edit', 'modal-winner'].some(mid => {
    const el = document.getElementById(mid);
    return el && el.style.display === 'flex';
  });
}

function openModal(id) {
  document.getElementById(id).style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  if (id === 'modal-settings') {
    clearTimeout(testSpinTimeout);
    stopSpinSoundLoop();
  }
  document.getElementById(id).style.display = 'none';
  if (!isAnyModalOpen()) {
    document.body.style.overflow = '';
    if (!isAlertLocked) {
      focusScanInput();
      setTimeout(() => focusScanInput(), 60);
    }
  }
}

function switchPage(page) {
  if (page !== 'scan' && typeof stopCameraQr === 'function' && typeof qrIsRunning !== 'undefined' && qrIsRunning) {
    stopCameraQr();
  }
  document.getElementById('page-scan').style.display = (page === 'scan') ? 'block' : 'none';
  document.getElementById('page-list').style.display = (page === 'list') ? 'block' : 'none';
  document.getElementById('nav-scan').className = 'nav-btn' + (page === 'scan' ? ' active' : '');
  document.getElementById('nav-list').className = 'nav-btn' + (page === 'list' ? ' active' : '');
  if (page === 'scan' && !isAlertLocked && !isManualKb) {
    focusScanInput();
    setTimeout(() => focusScanInput(), 60);
  }
}

// =========================================================================
// カーソルフォーカス制御（通常時自動復帰・スクロール抑止・ロック中は完全禁止）
// =========================================================================
function focusScanInput(forceForManual) {
  if (isAlertLocked || isSubmittingScan || isSlotInputLocked) return;
  if (isAnyModalOpen()) return;
  if (isBusyOverlayVisible) return;
  if (window.isDropdownActive) return;

  const scanPage = document.getElementById('page-scan');
  if (!scanPage || scanPage.style.display === 'none') return;
  if (isManualKb && !forceForManual) return;

  const el = document.getElementById('scan-input');
  if (!el || el.disabled || el.readOnly) return;

  el.setAttribute('inputmode', isManualKb ? 'text' : 'none');

  const savedY = window.pageYOffset || document.documentElement.scrollTop || 0;
  try {
    el.focus({ preventScroll: true });
  } catch (e) {
    el.focus();
  }
  const afterY = window.pageYOffset || document.documentElement.scrollTop || 0;
  if (Math.abs(afterY - savedY) > 1) {
    window.scrollTo(0, savedY);
  }
}

function notifyLockedScanAttempt() {
  const now = Date.now();
  if (now - lastLockWarnTime > 900) {
    lastLockWarnTime = now;
    playTone('alert');
    showToast('🔒 🚨重要通知の確認待ち！枠を0.5秒以上あけて2回タップで解除');
  }
}

function initFocusGuardListeners() {
  const blockWhenLocked = function(e) {
    if (!isAlertLocked) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    const inp = document.getElementById('scan-input');
    if (inp) { inp.value = ''; inp.blur(); }
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (e.type === 'keydown' || e.type === 'paste') {
      notifyLockedScanAttempt();
    }
  };
  window.addEventListener('keydown', blockWhenLocked, true);
  window.addEventListener('keypress', blockWhenLocked, true);
  window.addEventListener('keyup', blockWhenLocked, true);
  window.addEventListener('paste', blockWhenLocked, true);

  document.addEventListener('click', function(e) {
    if (isAlertLocked || isSubmittingScan || isSlotInputLocked || isAnyModalOpen() || isBusyOverlayVisible || window.isDropdownActive || isManualKb) return;
    const scanPage = document.getElementById('page-scan');
    if (!scanPage || scanPage.style.display === 'none') return;
    const target = e.target;
    if (!target) return;
    if (target.closest && target.closest('input, select, option, button, textarea, a, label, #recent-card, #qr-reader-panel')) return;
    focusScanInput();
  });
}

function toggleKeyboardMode() {
  if (isAlertLocked) {
    notifyLockedScanAttempt();
    return;
  }
  isManualKb = !isManualKb;
  const btn = document.getElementById('kb-toggle');
  const inp = document.getElementById('scan-input');
  btn.className = 'kb-btn' + (isManualKb ? ' on' : '');
  btn.innerText = isManualKb ? '⌨️ON' : '⌨️OFF';
  inp.setAttribute('inputmode', isManualKb ? 'text' : 'none');
  inp.placeholder = isManualKb ? '手動入力モード（Enterか送信を押す）' : 'スキャナー待機中（QR読取 / 会員番号）';
  focusScanInput(true);
}

function initScanListeners() {
  const inp = document.getElementById('scan-input');

  inp.addEventListener('focus', function() {
    if (isAlertLocked) { inp.value = ''; inp.blur(); }
  });

  inp.addEventListener('keydown', function(e) {
    if (isAlertLocked) {
      e.preventDefault();
      inp.value = '';
      inp.blur();
      notifyLockedScanAttempt();
      return;
    }
    if (isSubmittingScan || isSlotInputLocked) {
      e.preventDefault();
      inp.value = '';
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(scanTimer);
      if (isManualKb) {
        submitScan(inp.value);
      } else {
        scanTimer = setTimeout(() => submitScan(inp.value), 100);
      }
    }
  });

  inp.addEventListener('input', function() {
    if (isAlertLocked) {
      clearTimeout(scanTimer);
      inp.value = '';
      inp.blur();
      notifyLockedScanAttempt();
      return;
    }
    if (isSubmittingScan || isSlotInputLocked) {
      clearTimeout(scanTimer);
      inp.value = '';
      return;
    }
    if (isManualKb) return;
    clearTimeout(scanTimer);
    const val = inp.value || '';
    if (!val.trim()) return;

    const hasUrlComplete = /pokemon-go\.onelink\.me.*DlId=\d{12}/i.test(val);
    const hasAtId = /[@＠][^\s]{2,}/.test(val);
    const is12Digits = /^\s*\d[\d\s]{10,}\d\s*$/.test(val) && val.replace(/\s+/g, '').length === 12;
    const isMemberCode = /^[A-Za-z]{1,3}\d{3,6}$/.test(val.trim());

    if (hasUrlComplete || hasAtId) {
      scanTimer = setTimeout(() => submitScan(inp.value), 250);
    } else if (is12Digits) {
      scanTimer = setTimeout(() => submitScan(inp.value), 300);
    } else if (isMemberCode) {
      scanTimer = setTimeout(() => submitScan(inp.value), 400);
    } else if (val.length >= 16) {
      scanTimer = setTimeout(() => submitScan(inp.value), 900);
    }
  });
}

function submitScanManual() {
  if (isAlertLocked) {
    notifyLockedScanAttempt();
    return;
  }
  const inp = document.getElementById('scan-input');
  submitScan(inp.value);
}

// =========================================================================
// 🚨 ロック発動・解除制御（物理スキャナー・カメラQR・NFCすべて連動ロック）
// =========================================================================
function engageAlertLock() {
  isAlertFlashing = true;
  isAlertLocked = true;
  alertTapCount = 0;
  alertFirstTapTime = 0;
  clearTimeout(scanTimer);

  const scanBox = document.getElementById('scan-box');
  const inp = document.getElementById('scan-input');
  const kbBtn = document.getElementById('kb-toggle');
  const sendBtn = document.getElementById('send-btn');

  if (scanBox) scanBox.classList.add('alert-locked');
  if (inp) {
    inp.value = '';
    inp.readOnly = true;
    inp.disabled = true;
    inp.placeholder = '🔒 🚨重要通知の確認待ち（下の枠を2回タップで解除）';
    inp.blur();
  }
  if (kbBtn) kbBtn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  if (typeof setDeviceToolsLocked === 'function') setDeviceToolsLocked(true);
  if (typeof updateCameraStatusUi === 'function') updateCameraStatusUi();

  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
}

function clearAlertFlashState() {
  isAlertFlashing = false;
  isAlertLocked = false;
  alertTapCount = 0;
  alertFirstTapTime = 0;
  clearTimeout(alertSoundTimer);

  const card = document.getElementById('recent-card');
  if (card) card.classList.remove('alert-flash');

  const scanBox = document.getElementById('scan-box');
  const inp = document.getElementById('scan-input');
  const kbBtn = document.getElementById('kb-toggle');
  const sendBtn = document.getElementById('send-btn');

  if (scanBox) scanBox.classList.remove('alert-locked');
  if (inp) {
    inp.disabled = false;
    inp.readOnly = false;
    inp.value = '';
    inp.setAttribute('inputmode', isManualKb ? 'text' : 'none');
    inp.placeholder = isManualKb ? '手動入力モード（Enterか送信を押す）' : 'スキャナー待機中（QR読取 / 会員番号）';
  }
  if (kbBtn) kbBtn.disabled = false;
  if (sendBtn) sendBtn.disabled = false;
  if (typeof setDeviceToolsLocked === 'function') setDeviceToolsLocked(false);
  syncAllInputLockStates();
}

function handleAlertCardTap() {
  if (!isAlertFlashing && !isAlertLocked) return;
  getAudioCtx();
  const now = Date.now();
  const hintEl = document.getElementById('alert-tap-hint');

  if (alertTapCount === 0) {
    alertTapCount = 1;
    alertFirstTapTime = now;
    hintEl.innerText = '✅ 1回目確認！0.5秒以上あけてもう一度タップで解除';
    return;
  }

  const elapsed = now - alertFirstTapTime;
  if (elapsed < 500) {
    hintEl.innerText = '⚠️ 速すぎます！0.5秒以上あけてもう一度タップしてください';
    return;
  }

  clearAlertFlashState();
  showToast('✅ 🚨重要通知を確認・ロック解除しました');
  focusScanInput();
  setTimeout(() => focusScanInput(), 50);
}

// =========================================================================
// 打刻送信（スロットON時は一括ロック／スロットOFF時は高速連続受付）
// =========================================================================
function submitScan(rawVal) {
  clearTimeout(scanTimer);
  const inp = document.getElementById('scan-input');

  if (typeof getGasApiUrl === 'function' && !getGasApiUrl()) {
    if (inp) inp.value = '';
    showToast('🔌 先にGAS接続先URLを設定してください');
    if (typeof openGasUrlModal === 'function') openGasUrlModal();
    return;
  }

  if (isAlertLocked) {
    if (inp) { inp.value = ''; inp.blur(); }
    notifyLockedScanAttempt();
    return;
  }

  if (isSubmittingScan || isSlotInputLocked) {
    if (inp) inp.value = '';
    showToast('⏳ 前の打刻・演出中です。完了までお待ちください');
    return;
  }

  clearTimeout(alertSoundTimer);
  const clean = String(rawVal || '').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim();
  if (inp) inp.value = '';
  if (!clean) return;

  const now = Date.now();
  if (clean === lastScanStr && (now - lastScanTime) < 2500) {
    showToast('⚠️ 連続読み取りをブロックしました');
    focusScanInput();
    return;
  }
  lastScanStr = clean;
  lastScanTime = now;

  isSubmittingScan = true;
  syncAllInputLockStates();

  getAudioCtx();
  pauseAutoRefreshTemporarily();

  const slotEnabledNow = isSlotFeatureEnabled();
  if (slotEnabledNow) {
    startSlotSpin();
  }

  document.getElementById('recent-card').className = 'recent-card';
  document.getElementById('recent-name').innerText = '照合中...';
  document.getElementById('recent-name').className = 'recent-name';
  document.getElementById('recent-notif').innerText = '';

  callGasApi('addScanData', [clean])
    .then(function(res) {
      isSubmittingScan = false;

      if (!res || res.ignored) {
        if (slotEnabledNow) stopSlotImmediate(['🌸', '7', '🌸'], '待機中...');
        syncAllInputLockStates();
        focusScanInput();
        return;
      }
      if (!res.ok) {
        if (slotEnabledNow) stopSlotImmediate(['❌', '❌', '❌'], res.error || 'エラー');
        playTone('error');
        showToast('⚠️ ' + (res.error || '登録できませんでした'));
        syncAllInputLockStates();
        focusScanInput();
        return;
      }

      const hasAlertNotif = !!(res.notif && String(res.notif).indexOf('🚨') !== -1);
      updateRecentCard(res, hasAlertNotif);

      if (res.dashboard) {
        applyDashboard(res.dashboard);
      }

      // スロットOFF（またはスロット無効レスポンス）の場合：即座に完了音を鳴らして次の受付へ
      if (!isSlotFeatureEnabled() || (res.slotResult && res.slotResult.slotDisabled)) {
        clearAllSlotTimers();
        stopSpinSoundLoop();
        isSpinning = false;
        isSlotInputLocked = false;
        syncAllInputLockStates();

        if (res.isDuplicate) {
          playTone('buzzer');
        } else {
          playTone('ok');
        }

        if (hasAlertNotif) {
          clearTimeout(alertSoundTimer);
          alertSoundTimer = setTimeout(() => {
            if (isAlertFlashing || isAlertLocked) playTone('alert');
          }, 450);
        } else if (!isAlertLocked) {
          focusScanInput();
        }
        return;
      }

      // スロットON時：演出中＋結果表示後2秒間すべての一括ロックを開始
      isSlotInputLocked = true;
      syncAllInputLockStates();
      setupSequentialReelStop(res.slotResult, hasAlertNotif);
    })
    .catch(function(err) {
      isSubmittingScan = false;
      isSlotInputLocked = false;
      if (slotEnabledNow) stopSlotImmediate(['⚠️', '⚠️', '⚠️'], '通信エラー');
      playTone('error');
      syncAllInputLockStates();
      alert('通信エラー: ' + (err.message || err));
      if (!isAlertLocked) focusScanInput();
    });
}

function updateRecentCard(res, hasAlertNotif) {
  const card = document.getElementById('recent-card');
  const nameEl = document.getElementById('recent-name');
  const notifEl = document.getElementById('recent-notif');
  const hintEl = document.getElementById('alert-tap-hint');

  nameEl.innerText = res.formattedName || '';
  nameEl.className = 'recent-name' + (res.isFound ? '' : ' red');

  if (res.isDuplicate) {
    card.className = 'recent-card dup';
    notifEl.innerText = '⚠️重複（再来場）';
    return;
  }

  if (hasAlertNotif) {
    card.className = 'recent-card unreg alert-flash';
    notifEl.innerText = res.notif;
    hintEl.innerText = '🔒 🚨確認後、枠を0.5秒以上あけて2回タップでロック解除';
    engageAlertLock();
    return;
  }

  if (res.notif) {
    card.className = 'recent-card win';
    notifEl.innerText = res.notif;
  } else {
    card.className = 'recent-card';
    notifEl.innerText = '次回もお待ちしています✨';
  }
}

// =========================================================================
// スロット演出（3リール順番停止＋演出ディレイ＋即停止＋2秒クールダウン）
// =========================================================================
function clearAllSlotTimers() {
  for (let i = 0; i < 3; i++) {
    if (reelIntervals[i]) { clearInterval(reelIntervals[i]); reelIntervals[i] = null; }
    if (stopTimers[i]) { clearTimeout(stopTimers[i]); stopTimers[i] = null; }
  }
  if (slotCooldownTimer) {
    clearTimeout(slotCooldownTimer);
    slotCooldownTimer = null;
  }
}

function buildTargetSymbolsForSlot(slot) {
  if (!slot) return ['7', '🌸', 'BAR'];
  if (slot.isDuplicate) {
    const pool = (slot.penaltyMode === 'skull') ? ['💀'] : ['💀', '💩'];
    const icon = pool[Math.floor(Math.random() * pool.length)];
    return [icon, icon, icon];
  }
  if (slot.won) {
    const tok = normalizeReelToken(slot.symbol || '7');
    return [tok, tok, tok];
  }
  let a = REEL_POOL[Math.floor(Math.random() * REEL_POOL.length)];
  let b = REEL_POOL[Math.floor(Math.random() * REEL_POOL.length)];
  let c = REEL_POOL[Math.floor(Math.random() * REEL_POOL.length)];
  if (a === b && b === c) {
    c = REEL_POOL[(REEL_POOL.indexOf(c) + 1) % REEL_POOL.length];
  }
  return [a, b, c];
}

function getResultSoundDurationMs(type) {
  const style = activeSounds[type] || 'basic';
  if (type === 'fanfare') {
    if (style === 'legacy') return 950;
    if (style === 'funny') return 1100;
    if (style === 'retro') return 1050;
    if (style === 'casino') return 950;
    return 1120;
  }
  if (type === 'win') {
    if (style === 'legacy') return 950;
    if (style === 'funny') return 700;
    if (style === 'retro') return 650;
    if (style === 'casino') return 580;
    return 520;
  }
  if (type === 'buzzer') {
    if (style === 'legacy') return 400;
    if (style === 'retro') return 800;
    if (style === 'casino') return 700;
    return 640;
  }
  if (style === 'legacy') return 350;
  if (style === 'retro') return 310;
  if (style === 'funny') return 240;
  return 200;
}

function startSpinSoundLoop(overrideStyle) {
  stopSpinSoundLoop();
  const style = overrideStyle || activeSounds.spin || 'basic';
  const intervalMs = (style === 'legacy') ? 100 : (style === 'casino' ? 65 : (style === 'funny' ? 115 : 85));
  spinTickStep = 0;
  playTone('spin', style);
  spinSoundTimer = setInterval(() => {
    playTone('spin', style);
  }, intervalMs);
}

function stopSpinSoundLoop() {
  if (spinSoundTimer) {
    clearInterval(spinSoundTimer);
    spinSoundTimer = null;
  }
}

function startSlotSpin() {
  if (isAlertLocked) return;
  clearAllSlotTimers();
  stopSpinSoundLoop();
  pendingSlotContext = null;
  forceStopRequested = false;
  slotFinalized = false;
  isSpinning = true;

  document.getElementById('slot-msg').innerText = '抽選中...（枠タップで即停止）';
  startSpinSoundLoop();

  for (let i = 0; i < 3; i++) {
    reelIntervals[i] = setInterval(() => {
      const sym = REEL_POOL[Math.floor(Math.random() * REEL_POOL.length)];
      setReelCell(i, sym);
    }, 70);
  }
}

function setupSequentialReelStop(slot, hasAlertNotif) {
  const targetSymbols = buildTargetSymbolsForSlot(slot);
  pendingSlotContext = { slot: slot, hasAlertNotif: hasAlertNotif, targetSymbols: targetSymbols };
  slotFinalized = false;

  if (forceStopRequested) {
    executeImmediateFinish();
    return;
  }

  const delayMs = (state.settings && Number(state.settings.slotDelayMs) >= 0) ? Number(state.settings.slotDelayMs) : 0;

  stopTimers[0] = setTimeout(() => { stopSingleReel(0); }, delayMs);
  stopTimers[1] = setTimeout(() => { stopSingleReel(1); }, delayMs + 250);
  stopTimers[2] = setTimeout(() => {
    stopSingleReel(2);
    finalizeSlotResult(2000); // 結果表示後 2秒間ロックを維持
  }, delayMs + 500);
}

function stopSingleReel(idx) {
  if (!isSpinning || !pendingSlotContext || slotFinalized) return;
  if (reelIntervals[idx]) {
    clearInterval(reelIntervals[idx]);
    reelIntervals[idx] = null;
  }
  setReelCell(idx, pendingSlotContext.targetSymbols[idx]);
  playTone('reelStop', activeSounds.ok || 'basic');
}

function executeImmediateFinish() {
  if (!pendingSlotContext || slotFinalized) return;
  clearAllSlotTimers();
  stopSpinSoundLoop();
  for (let i = 0; i < 3; i++) {
    setReelCell(i, pendingSlotContext.targetSymbols[i]);
  }
  playTone('reelStop', activeSounds.ok || 'basic');
  finalizeSlotResult(450); // 即停止時は0.45秒後にすぐ次の受付へ復帰
}

function forceStopSlot() {
  getAudioCtx();
  if (!isSpinning) {
    if (!isAlertLocked) focusScanInput();
    return;
  }
  if (pendingSlotContext) {
    executeImmediateFinish();
  } else {
    forceStopRequested = true;
    document.getElementById('slot-msg').innerText = '結果受信中（受信次第すぐ停止します）...';
  }
  if (!isAlertLocked) focusScanInput();
}

function stopSlotImmediate(icons, msg) {
  clearAllSlotTimers();
  stopSpinSoundLoop();
  pendingSlotContext = null;
  forceStopRequested = false;
  slotFinalized = true;
  isSpinning = false;
  isSlotInputLocked = false;
  renderAllReels(icons);
  document.getElementById('slot-msg').innerText = msg;
  syncAllInputLockStates();
}

function finalizeSlotResult(cooldownMs) {
  if (slotFinalized) return;
  slotFinalized = true;

  const ctx = pendingSlotContext;
  clearAllSlotTimers();
  stopSpinSoundLoop();
  pendingSlotContext = null;
  forceStopRequested = false;
  isSpinning = false;

  if (!ctx || !ctx.slot) {
    isSlotInputLocked = false;
    syncAllInputLockStates();
    return;
  }
  const slot = ctx.slot;
  const hasAlertNotif = ctx.hasAlertNotif;

  let playedType = 'ok';
  if (slot.isDuplicate) {
    document.getElementById('slot-msg').innerText = '⚠️ 重複スキャンです！';
    playedType = 'buzzer';
    playTone('buzzer');
  } else if (slot.won) {
    document.getElementById('slot-msg').innerText = slot.logText || '🎉 当たり！';
    if (slot.isJackpot) {
      playedType = 'fanfare';
      playTone('fanfare');
      launchConfetti();
    } else {
      playedType = 'win';
      playTone('win');
    }
  } else {
    document.getElementById('slot-msg').innerText = 'ご参加ありがとうございます✨';
    playedType = 'ok';
    playTone('ok');
  }

  if (hasAlertNotif) {
    clearTimeout(alertSoundTimer);
    const waitMs = getResultSoundDurationMs(playedType) + 500;
    alertSoundTimer = setTimeout(() => {
      if (isAlertFlashing || isAlertLocked) {
        playTone('alert');
      }
    }, waitMs);
  }

  // 結果表示後2秒間（即停止時は0.45秒）の一括ロック解除タイマー
  const lockWait = (typeof cooldownMs === 'number' && cooldownMs >= 0) ? cooldownMs : 2000;
  isSlotInputLocked = true;
  syncAllInputLockStates();

  slotCooldownTimer = setTimeout(() => {
    slotCooldownTimer = null;
    isSlotInputLocked = false;
    syncAllInputLockStates();
    if (!isAlertLocked) focusScanInput();
  }, lockWait);
}

function toggleMute() {
  isMuted = !isMuted;
  if (isMuted) stopSpinSoundLoop();
  document.getElementById('mute-btn').innerText = isMuted ? '🔇 消音' : '🔊 音ON';
  if (!isAlertLocked) setTimeout(() => focusScanInput(), 30);
}

function applySoundPreset(presetStyle) {
  ['spin', 'ok', 'win', 'fanfare', 'buzzer'].forEach(k => {
    const sel = document.getElementById('snd-' + k);
    if (sel) sel.value = presetStyle;
  });
  const label = (presetStyle === 'legacy') ? '🕰️ 旧バージョンプリセット' : '🎵 ベーシック';
  showToast(label + ' を全項目にセットしました（「設定を保存」で確定）');
}

function previewSoundRow(type) {
  if (isMuted) {
    showToast('🔇 現在「消音」です。メイン画面で「音ON」にしてください');
    return;
  }
  const sel = document.getElementById('snd-' + type);
  const chosenStyle = sel ? sel.value : 'basic';
  clearTimeout(testSpinTimeout);
  stopSpinSoundLoop();

  if (type === 'spin') {
    startSpinSoundLoop(chosenStyle);
    testSpinTimeout = setTimeout(() => { stopSpinSoundLoop(); }, 1000);
  } else if (type === 'ok' && chosenStyle === 'legacy') {
    playTone('reelStop', 'legacy');
    setTimeout(() => { playTone('ok', 'legacy'); }, 160);
  } else {
    playTone(type, chosenStyle);
  }
}

function playTone(type, overrideStyle) {
  if (isMuted) return;
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const style = overrideStyle || activeSounds[type] || 'basic';

    function beep(freq, start, dur, wave, vol, endGain) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave || 'sine';
      osc.frequency.setValueAtTime(freq, start);
      const v = (vol !== undefined) ? vol : 0.18;
      const eg = (endGain !== undefined) ? endGain : 0.001;
      gain.gain.setValueAtTime(v, start);
      gain.gain.exponentialRampToValueAtTime(eg, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    }

    function slide(fStart, fEnd, start, dur, wave, vol) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave || 'sine';
      osc.frequency.setValueAtTime(fStart, start);
      osc.frequency.exponentialRampToValueAtTime(Math.max(fEnd, 20), start + dur);
      const v = (vol !== undefined) ? vol : 0.18;
      gain.gain.setValueAtTime(v, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    }

    function boing(baseFreq, start, dur, vol) {
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq, start);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.45, start + dur);
      lfo.frequency.setValueAtTime(18, start);
      lfoGain.gain.setValueAtTime(baseFreq * 0.28, start);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      gain.gain.setValueAtTime(vol || 0.22, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      lfo.start(start); osc.start(start);
      lfo.stop(start + dur); osc.stop(start + dur);
    }

    if (type === 'alert') {
      beep(1320, now, 0.09, 'square', 0.16);
      beep(988, now + 0.10, 0.09, 'square', 0.16);
      beep(1320, now + 0.24, 0.09, 'square', 0.16);
      beep(988, now + 0.34, 0.12, 'square', 0.16);
      return;
    }

    if (type === 'reelStop') {
      if (style === 'legacy') beep(300, now, 0.08, 'triangle', 0.30, 0.001);
      else if (style === 'casino') slide(170, 70, now, 0.06, 'triangle', 0.22);
      else if (style === 'retro') beep(740, now, 0.045, 'square', 0.10);
      else if (style === 'funny') slide(280, 180, now, 0.06, 'triangle', 0.15);
      else beep(340, now, 0.06, 'triangle', 0.18);
      return;
    }

    if (type === 'spin') {
      if (style === 'legacy') {
        beep(600, now, 0.04, 'square', 0.05, 0.0001);
      } else if (style === 'funny') {
        const pops = [[260, 560], [340, 720], [220, 480], [390, 820]];
        const p = pops[spinTickStep % pops.length];
        spinTickStep++;
        slide(p[0], p[1], now, 0.08, 'sine', 0.14);
      } else if (style === 'retro') {
        const notes = [523, 659, 784, 1046];
        const f = notes[spinTickStep % notes.length];
        spinTickStep++;
        beep(f, now, 0.04, 'square', 0.08);
      } else if (style === 'casino') {
        const f = (spinTickStep % 2 === 0) ? 1250 : 950;
        spinTickStep++;
        slide(f, 260, now, 0.032, 'sawtooth', 0.09);
      } else {
        const notes = [587, 659, 784, 659];
        const f = notes[spinTickStep % notes.length];
        spinTickStep++;
        beep(f, now, 0.045, 'triangle', 0.11);
      }
      return;
    }

    if (type === 'ok') {
      if (style === 'legacy') {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = 'sine'; osc2.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        osc2.frequency.setValueAtTime(1760, now);
        gain.gain.setValueAtTime(0.20, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination);
        osc1.start(now); osc2.start(now);
        osc1.stop(now + 0.35); osc2.stop(now + 0.35);
      } else if (style === 'funny') {
        slide(330, 145, now, 0.13, 'sawtooth', 0.15);
        slide(190, 260, now + 0.12, 0.08, 'triangle', 0.12);
      } else if (style === 'retro') {
        beep(988, now, 0.07, 'square', 0.12);
        beep(1319, now + 0.07, 0.22, 'square', 0.12);
      } else if (style === 'casino') {
        slide(160, 65, now, 0.07, 'triangle', 0.24);
        slide(1700, 400, now, 0.035, 'square', 0.11);
      } else {
        beep(587, now, 0.06, 'sine', 0.15);
        beep(880, now + 0.06, 0.11, 'sine', 0.17);
      }
      return;
    }

    if (type === 'win') {
      if (style === 'legacy') {
        const notes = [
          { freq: 523.25, time: 0.00, dur: 0.15 },
          { freq: 659.25, time: 0.15, dur: 0.15 },
          { freq: 783.99, time: 0.30, dur: 0.15 },
          { freq: 1046.50, time: 0.45, dur: 0.50 }
        ];
        notes.forEach(n => beep(n.freq, now + n.time, n.dur, 'triangle', 0.40, 0.01));
      } else if (style === 'funny') {
        beep(523, now, 0.08, 'sawtooth', 0.13);
        beep(659, now + 0.09, 0.08, 'sawtooth', 0.13);
        beep(784, now + 0.18, 0.16, 'sawtooth', 0.15);
        boing(340, now + 0.34, 0.34, 0.22);
      } else if (style === 'retro') {
        [523, 659, 784, 1046, 784, 1046].forEach((f, idx) => {
          beep(f, now + idx * 0.07, (idx === 5 ? 0.24 : 0.065), 'square', 0.12);
        });
      } else if (style === 'casino') {
        slide(750, 2400, now, 0.16, 'sine', 0.22);
        slide(900, 2600, now + 0.17, 0.18, 'sine', 0.22);
        beep(2093, now + 0.36, 0.18, 'triangle', 0.18);
      } else {
        beep(659, now, 0.10, 'triangle', 0.20);
        beep(784, now + 0.10, 0.10, 'triangle', 0.20);
        beep(1046, now + 0.20, 0.28, 'triangle', 0.22);
      }
      return;
    }

    if (type === 'fanfare') {
      if (style === 'legacy') {
        const notes = [
          { freq: 523.25, time: 0.00, dur: 0.15 },
          { freq: 659.25, time: 0.15, dur: 0.15 },
          { freq: 783.99, time: 0.30, dur: 0.15 },
          { freq: 1046.50, time: 0.45, dur: 0.50 }
        ];
        notes.forEach(n => beep(n.freq, now + n.time, n.dur, 'triangle', 0.40, 0.01));
      } else if (style === 'funny') {
        beep(523, now, 0.08, 'sawtooth', 0.14);
        beep(523, now + 0.09, 0.08, 'sawtooth', 0.14);
        beep(659, now + 0.18, 0.09, 'sawtooth', 0.15);
        beep(784, now + 0.28, 0.18, 'sawtooth', 0.16);
        boing(280, now + 0.46, 0.28, 0.22);
        boing(420, now + 0.72, 0.36, 0.24);
      } else if (style === 'retro') {
        const notes = [
          [523, 0.00, 0.08], [659, 0.08, 0.08], [784, 0.16, 0.08],
          [1046, 0.24, 0.14], [784, 0.39, 0.08], [880, 0.47, 0.08],
          [988, 0.55, 0.08], [1046, 0.63, 0.38]
        ];
        notes.forEach(n => beep(n[0], now + n[1], n[2], 'square', 0.12));
      } else if (style === 'casino') {
        slide(700, 2500, now, 0.16, 'sine', 0.24);
        slide(700, 2600, now + 0.17, 0.18, 'sine', 0.24);
        for (let i = 0; i < 7; i++) {
          const f = (i % 2 === 0) ? 2093 : 2637;
          beep(f, now + 0.38 + i * 0.065, 0.09, 'triangle', 0.18);
        }
      } else {
        beep(523, now, 0.11, 'triangle', 0.22);
        beep(659, now + 0.11, 0.11, 'triangle', 0.22);
        beep(784, now + 0.22, 0.11, 'triangle', 0.22);
        beep(1046, now + 0.33, 0.18, 'triangle', 0.24);
        beep(784, now + 0.52, 0.11, 'triangle', 0.22);
        beep(1046, now + 0.64, 0.45, 'triangle', 0.25);
      }
      return;
    }

    if (type === 'buzzer') {
      if (style === 'legacy') {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = 'sawtooth'; osc2.type = 'sawtooth';
        osc1.frequency.setValueAtTime(150, now);
        osc2.frequency.setValueAtTime(156, now);
        gain.gain.setValueAtTime(0.30, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.40);
        osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination);
        osc1.start(now); osc2.start(now);
        osc1.stop(now + 0.40); osc2.stop(now + 0.40);
      } else if (style === 'funny') {
        const osc = ctx.createOscillator();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(145, now);
        osc.frequency.exponentialRampToValueAtTime(62, now + 0.58);
        lfo.frequency.setValueAtTime(28, now);
        lfoGain.gain.setValueAtTime(26, now);
        lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
        gain.gain.setValueAtTime(0.24, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.62);
        osc.connect(gain); gain.connect(ctx.destination);
        lfo.start(now); osc.start(now);
        lfo.stop(now + 0.62); osc.stop(now + 0.62);
      } else if (style === 'retro') {
        [440, 415, 392, 349, 293].forEach((f, idx) => {
          beep(f, now + idx * 0.11, (idx === 4 ? 0.35 : 0.10), 'square', 0.13);
        });
      } else if (style === 'casino') {
        slide(620, 980, now, 0.16, 'sawtooth', 0.14);
        slide(980, 620, now + 0.16, 0.16, 'sawtooth', 0.14);
        slide(620, 980, now + 0.32, 0.16, 'sawtooth', 0.14);
        slide(980, 520, now + 0.48, 0.20, 'sawtooth', 0.14);
      } else {
        beep(185, now, 0.20, 'sawtooth', 0.18);
        beep(145, now + 0.22, 0.32, 'sawtooth', 0.18);
      }
      return;
    }

    beep(330, now, 0.10, 'square', 0.12);
    beep(240, now + 0.12, 0.16, 'square', 0.12);
  } catch (e) {}
}

function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const pieces = [];
  const colors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#facc15'];
  for (let i = 0; i < 90; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 200,
      w: 8 + Math.random() * 6,
      h: 6 + Math.random() * 6,
      vx: (Math.random() - 0.5) * 4,
      vy: 3 + Math.random() * 5,
      c: colors[i % colors.length]
    });
  }
  let frames = 0;
  function step() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    });
    if (++frames < 95) requestAnimationFrame(step);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  step();
}

// =========================================================================
// 自動更新・ダッシュボード描画
// =========================================================================
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!isPolling || Date.now() < pauseUntil || window.isDropdownActive || isSubmittingScan || isSlotInputLocked) return;
    if (typeof getGasApiUrl === 'function' && !getGasApiUrl()) return;
    fetchDashboard(false);
  }, 5000);
}

function pauseAutoRefreshTemporarily() {
  const sec = (state.settings && state.settings.pauseSeconds) ? state.settings.pauseSeconds : 15;
  pauseUntil = Date.now() + sec * 1000;
}

function togglePolling() {
  isPolling = !isPolling;
  const label = isPolling ? '🟢 自動更新中' : '⏸️ 停止中';
  ['poll-btn-1', 'poll-btn-2'].forEach(id => {
    const b = document.getElementById(id);
    b.innerText = label;
    b.className = 'poll-btn' + (isPolling ? '' : ' paused');
  });
  if (isPolling) {
    pauseUntil = 0;
    fetchDashboard(true);
  }
  if (!isAlertLocked) setTimeout(() => focusScanInput(), 40);
}

function fetchDashboard(force) {
  if (typeof getGasApiUrl === 'function' && !getGasApiUrl()) return;
  const hashToSend = force ? '' : (state.hash || '');
  callGasApi('getDashboardState', [hashToSend])
    .then(function(res) {
      if (!res || res.unchanged) return;
      if (window.isDropdownActive) return;
      applyDashboard(res);
    })
    .catch(function(err) {
      if (force) {
        showToast('⚠️ データ取得失敗: ' + (err.message || err));
      }
    });
}

function applyDashboard(data) {
  const winY = window.scrollY;
  const scanWrap = document.getElementById('scan-table-wrap');
  const listWrap = document.getElementById('list-table-wrap');
  const scanScrollTop = scanWrap ? scanWrap.scrollTop : 0;
  const scanScrollLeft = scanWrap ? scanWrap.scrollLeft : 0;
  const listScrollTop = listWrap ? listWrap.scrollTop : 0;
  const listScrollLeft = listWrap ? listWrap.scrollLeft : 0;

  state = data;

  if (data.settings && data.settings.sounds) saveLocalSounds(data.settings.sounds);
  if (data.settings && data.settings.reelStyle) saveLocalReelStyle(data.settings.reelStyle);

  const hlColor = (data.settings && data.settings.highlightColor) ? data.settings.highlightColor : '#fff9b1';
  if (typeof syncActiveAppMeta === 'function') {
    syncActiveAppMeta(data.ssName || '', hlColor);
  }

  const dispName = (typeof getActiveAppDisplayName === 'function' && getActiveAppDisplayName())
    ? getActiveAppDisplayName()
    : (data.ssName || DEFAULT_APP_TITLE);
  updateHeaderTitleUi(dispName);

  // ホスト専用：確認済み背景色とヘッダー色を自動連動
  applyHeaderColor(hlColor);

  // スロットON/OFF表示＆モード表示を反映
  renderSlotPowerState();

  const activeCount = (data.rows || []).filter(r => r.a !== '取消').length;
  document.getElementById('count-pill-1').innerText = '打刻: ' + activeCount + '件';
  document.getElementById('count-pill-2').innerText = '打刻: ' + activeCount + '件';

  renderTables();
  renderDestLinks();
  renderCustomLinks();

  if (scanWrap) { scanWrap.scrollTop = scanScrollTop; scanWrap.scrollLeft = scanScrollLeft; }
  if (listWrap) { listWrap.scrollTop = listScrollTop; listWrap.scrollLeft = listScrollLeft; }
  window.scrollTo(0, winY);
}

function getStatusOptionsHtml(currentVal) {
  const f = (state.settings && state.settings.fLabel) || '色違';
  const g = (state.settings && state.settings.gLabel) || 'Evnt';
  const opts = ['', f, g, f + '/' + g, '取消'];
  return opts.map(v => {
    const label = v === '' ? '--選択--' : v;
    const sel = (v === currentVal) ? ' selected' : '';
    return `<option value="${escapeHtml(v)}"${sel}>${escapeHtml(label)}</option>`;
  }).join('');
}

// E列表示ヘルパー（URLならタップ可能な「Linkを開く」、通常文字はそのまま表示）
function formatColECellHtml(rawE, truncatePlain) {
  const str = String(rawE || '').trim();
  if (/^https?:\/\//i.test(str)) {
    const safeHref = escapeHtml(str);
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" style="color:#2563eb; font-weight:800; text-decoration:underline;">Linkを開く</a>`;
  }
  const disp = (truncatePlain && str.length > 28) ? (str.substring(0, 28) + '…') : str;
  return escapeHtml(disp);
}

function renderTables() {
  const revRows = (state.rows || []).slice().reverse();
  const hlColor = (state.settings && state.settings.highlightColor) ? state.settings.highlightColor : '#fff9b1';
  let rowsHtml = '';

  revRows.forEach(r => {
    const trCls = (r.a === '取消') ? ' class="row-canceled"' : '';
    const dCls = r.isRed ? ' class="td-red"' : '';
    const hasNotif = !!(r.c && r.c.trim() !== '');
    const nCls = 'td-notif' + ((r.c.indexOf('🚨') !== -1 || r.c.indexOf('⚠️') !== -1) ? ' alert' : '');
    const stSelect = `<select class="st-sel" onfocus="window.isDropdownActive=true;" onblur="window.isDropdownActive=false; setTimeout(()=>{ if(!window.isDropdownActive && !isAlertLocked) focusScanInput(); }, 350);" onchange="window.isDropdownActive=false; onChangeStatus(${r.rowNum}, this.value)">${getStatusOptionsHtml(r.a)}</select>`;

    let doneHtml = '';
    if (hasNotif) {
      const isConfirmed = (r.b === '確');
      const doneStyle = isConfirmed ? ` style="background:${escapeHtml(hlColor)}; color:#0f172a; border-color:#64748b;"` : '';
      doneHtml = `<button type="button" class="done-btn${isConfirmed ? ' ok' : ''}"${doneStyle} onclick="onToggleDone(${r.rowNum})">${escapeHtml(r.b || '未')}</button>`;
    }

    rowsHtml += `<tr${trCls}>
      <td>${stSelect}</td>
      <td style="text-align:center;">${doneHtml}</td>
      <td class="${nCls}">${escapeHtml(r.c)}</td>
      <td${dCls}>${escapeHtml(r.d)}</td>
      <td class="td-stamping" title="${escapeHtml(r.e)}">${formatColECellHtml(r.e, true)}</td>
      <td>${escapeHtml(r.f)}</td>
      <td>${escapeHtml(r.g)}</td>
      <td>${escapeHtml(r.h)}</td>
    </tr>`;
  });

  document.getElementById('scan-tbody').innerHTML = rowsHtml;
  document.getElementById('list-tbody').innerHTML = rowsHtml;
}

function renderDestLinks() {
  const u = state.destUrls || {};
  const setHref = (id, url) => {
    const a = document.getElementById(id);
    if (url) { a.href = url; a.style.opacity = '1'; a.onclick = null; }
    else { a.href = '#'; a.style.opacity = '0.5'; a.onclick = () => { alert('転記先シートIDが未設定です。'); return false; }; }
  };
  setHref('link-dest-d', u.d);
  setHref('link-dest-f', u.f);
  setHref('link-dest-g', u.g);
}

function renderCustomLinks() {
  const area = document.getElementById('custom-links-area');
  const row = document.getElementById('custom-links-row');
  const links = (state.settings && state.settings.customLinks) ? state.settings.customLinks : [];
  const active = links.filter(l => l && l.url && l.url.trim() !== '');
  if (active.length === 0) {
    area.style.display = 'none';
    return;
  }
  area.style.display = 'block';
  row.style.gridTemplateColumns = `repeat(${active.length}, 1fr)`;
  row.innerHTML = active.map((l, idx) => {
    const title = l.name || ('リンク' + (idx + 1));
    return `<a class="custom-link-btn" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`;
  }).join('');
}

function onChangeStatus(rowNum, val) {
  pauseAutoRefreshTemporarily();
  showBusy('⏳ ステータス更新中...');
  callGasApi('updateRowStatus', [rowNum, val])
    .then(function(dash) {
      hideBusy();
      applyDashboard(dash);
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    })
    .catch(function(err) {
      hideBusy();
      alert(err.message || err);
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    });
}

function onToggleDone(rowNum) {
  pauseAutoRefreshTemporarily();
  showBusy('⏳ 確認フラグ更新中...');
  callGasApi('toggleRowDone', [rowNum])
    .then(function(dash) {
      hideBusy();
      applyDashboard(dash);
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    })
    .catch(function(err) {
      hideBusy();
      alert(err.message || err);
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    });
}

function copyColumnData(col) {
  let list = [];
  if (col === 'D') list = (state.rows || []).filter(r => r.a !== '取消' && r.d).map(r => r.d).reverse();
  else if (col === 'E') list = (state.rows || []).filter(r => r.e).map(r => r.e).reverse();
  else if (col === 'F') list = (state.fList || []).slice().reverse();
  else if (col === 'G') list = (state.gList || []).slice().reverse();

  if (list.length === 0) {
    showToast(col + '列にコピー対象のデータがありません');
    return;
  }
  const text = list.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('✅ ' + col + '列（' + list.length + '件）をコピーしました');
    }).catch(() => fallbackCopyCol(text, col, list.length));
  } else {
    fallbackCopyCol(text, col, list.length);
  }
}

function fallbackCopyCol(text, col, len) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  showToast('✅ ' + col + '列（' + len + '件）をコピーしました');
}

// =========================================================================
// モーダル1：全列参照 ＆ モーダル2：設定
// =========================================================================
function openFullLogModal() {
  const rev = (state.rows || []).slice().reverse();
  document.getElementById('full-tbody').innerHTML = rev.map(r => `<tr>
    <td>${r.rowNum}</td><td>${escapeHtml(r.a)}</td><td>${escapeHtml(r.b)}</td>
    <td class="td-notif${(r.c.indexOf('🚨') !== -1 || r.c.indexOf('⚠️') !== -1) ? ' alert' : ''}">${escapeHtml(r.c)}</td>
    <td class="${r.isRed ? 'td-red' : ''}">${escapeHtml(r.d)}</td>
    <td title="${escapeHtml(r.e)}">${formatColECellHtml(r.e, false)}</td><td>${escapeHtml(r.f)}</td><td>${escapeHtml(r.g)}</td><td>${escapeHtml(r.h)}</td>
  </tr>`).join('');
  openModal('modal-full');
}

function syncColorInputs(from) {
  const picker = document.getElementById('set-hl-picker');
  const hex = document.getElementById('set-hl-hex');
  const preview = document.getElementById('set-hl-preview');
  let activeHex = picker.value;
  if (from === 'picker') {
    hex.value = picker.value.toLowerCase();
    activeHex = picker.value;
  } else {
    let v = String(hex.value || '').trim();
    if (/^[0-9a-fA-F]{6}$/.test(v)) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      picker.value = v.toLowerCase();
      activeHex = v.toLowerCase();
    }
  }
  preview.style.background = activeHex;
  preview.style.color = isLightHexColor(activeHex) ? '#0f172a' : '#ffffff';
}

function openSettingsModal() {
  const s = state.settings;
  if (!s) {
    showToast('⏳ データを読み込み中です。GAS接続を確認してください');
    return;
  }

  const hl = s.highlightColor || '#fff9b1';
  document.getElementById('set-hl-picker').value = hl;
  document.getElementById('set-hl-hex').value = hl;
  const preview = document.getElementById('set-hl-preview');
  preview.style.background = hl;
  preview.style.color = isLightHexColor(hl) ? '#0f172a' : '#ffffff';

  document.getElementById('set-slotEnabled').value = (s.slotEnabled === false) ? 'false' : 'true';
  document.getElementById('set-reelStyle').value = s.reelStyle || activeReelStyle || 'legacy';

  const snd = s.sounds ? Object.assign({}, DEFAULT_SOUNDS, s.sounds) : activeSounds;
  document.getElementById('snd-spin').value = snd.spin || 'basic';
  document.getElementById('snd-ok').value = snd.ok || 'basic';
  document.getElementById('snd-win').value = snd.win || 'basic';
  document.getElementById('snd-fanfare').value = snd.fanfare || 'basic';
  document.getElementById('snd-buzzer').value = snd.buzzer || 'basic';

  document.getElementById('set-slotMode').value = s.slotMode;
  document.getElementById('p-n-seven').value = s.normalProb.seven;
  document.getElementById('p-n-sakura').value = s.normalProb.sakura;
  document.getElementById('p-n-bar').value = s.normalProb.bar;
  document.getElementById('p-n-bell').value = s.normalProb.bell;
  document.getElementById('p-n-grape').value = s.normalProb.grape;
  document.getElementById('p-n-cherry').value = s.normalProb.cherry;
  document.getElementById('p-f-seven').value = s.fairProb.seven;
  document.getElementById('p-f-sakura').value = s.fairProb.sakura;
  document.getElementById('p-f-bar').value = s.fairProb.bar;
  document.getElementById('p-f-bell').value = s.fairProb.bell;
  document.getElementById('p-f-grape').value = s.fairProb.grape;
  document.getElementById('p-f-cherry').value = s.fairProb.cherry;
  document.getElementById('set-fairLimit').value = String(s.fairLimit);
  document.getElementById('set-jackpotTarget').value = s.jackpotTarget;
  document.getElementById('set-penaltyMode').value = s.penaltyMode;

  const delaySec = Math.round(((Number(s.slotDelayMs) || 0) / 1000) * 100) / 100;
  document.getElementById('set-slotDelaySec').value = delaySec;

  document.getElementById('set-pauseSeconds').value = s.pauseSeconds;
  document.getElementById('set-fLabel').value = s.fLabel;
  document.getElementById('set-gLabel').value = s.gLabel;

  for (let i = 1; i <= 4; i++) {
    const lk = (s.customLinks && s.customLinks[i - 1]) ? s.customLinks[i - 1] : { name: '', url: '' };
    document.getElementById('cl-name-' + i).value = lk.name || '';
    document.getElementById('cl-url-' + i).value = lk.url || '';
  }

  renderSettingsVersionFoot();
  openModal('modal-settings');
}

function saveSettingsFromModal() {
  const soundsPayload = {
    spin: document.getElementById('snd-spin').value,
    ok: document.getElementById('snd-ok').value,
    win: document.getElementById('snd-win').value,
    fanfare: document.getElementById('snd-fanfare').value,
    buzzer: document.getElementById('snd-buzzer').value
  };
  saveLocalSounds(soundsPayload);

  const chosenReelStyle = document.getElementById('set-reelStyle').value === 'modern' ? 'modern' : 'legacy';
  saveLocalReelStyle(chosenReelStyle);

  const customLinks = [];
  for (let i = 1; i <= 4; i++) {
    customLinks.push({
      slot: i,
      name: document.getElementById('cl-name-' + i).value,
      url: document.getElementById('cl-url-' + i).value
    });
  }

  let hlHex = String(document.getElementById('set-hl-hex').value || '').trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(hlHex)) {
    hlHex = document.getElementById('set-hl-picker').value || '#fff9b1';
  }
  if (hlHex.charAt(0) !== '#') hlHex = '#' + hlHex;

  const rawDelaySec = parseFloat(document.getElementById('set-slotDelaySec').value);
  const delayMs = (!isNaN(rawDelaySec) && rawDelaySec >= 0) ? Math.round(rawDelaySec * 1000) : 0;

  const payload = {
    highlightColor: hlHex.toLowerCase(),
    slotEnabled: document.getElementById('set-slotEnabled').value !== 'false',
    reelStyle: chosenReelStyle,
    slotMode: document.getElementById('set-slotMode').value,
    normalProb: {
      seven: document.getElementById('p-n-seven').value,
      sakura: document.getElementById('p-n-sakura').value,
      bar: document.getElementById('p-n-bar').value,
      bell: document.getElementById('p-n-bell').value,
      grape: document.getElementById('p-n-grape').value,
      cherry: document.getElementById('p-n-cherry').value
    },
    fairProb: {
      seven: document.getElementById('p-f-seven').value,
      sakura: document.getElementById('p-f-sakura').value,
      bar: document.getElementById('p-f-bar').value,
      bell: document.getElementById('p-f-bell').value,
      grape: document.getElementById('p-f-grape').value,
      cherry: document.getElementById('p-f-cherry').value
    },
    fairLimit: document.getElementById('set-fairLimit').value,
    jackpotTarget: document.getElementById('set-jackpotTarget').value,
    penaltyMode: document.getElementById('set-penaltyMode').value,
    slotDelayMs: delayMs,
    pauseSeconds: document.getElementById('set-pauseSeconds').value,
    fLabel: document.getElementById('set-fLabel').value,
    gLabel: document.getElementById('set-gLabel').value,
    customLinks: customLinks,
    sounds: soundsPayload
  };

  closeModal('modal-settings');
  showBusy('⏳ 設定を保存中です...');
  callGasApi('saveSettings', [payload])
    .then(function(dash) {
      hideBusy();
      applyDashboard(dash);
      showToast('✅ 設定を保存しました');
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    })
    .catch(function(err) {
      hideBusy();
      alert(err.message || err);
      if (!isAlertLocked) setTimeout(() => focusScanInput(), 50);
    });
}

function confirmResetSlotHistory() {
  if (!confirm('スロット履歴（満遍なく当選のカウント）をすべてリセットしますか？')) return;
  showBusy('⏳ リセット中...');
  callGasApi('resetSlotHistory', [])
    .then(function(res) { hideBusy(); showToast('✅ ' + res.message); })
    .catch(function(err) { hideBusy(); alert(err.message || err); });
}

// =========================================================================
// 締め作業 ①〜⑥
// =========================================================================
function runPreBackup() {
  if (!confirm('① ログを修正する前の生データを「修正前BK」としてGoogleドライブへ保存しますか？')) return;
  showBusy('💾 修正前BKを保存中です...');
  callGasApi('savePreBackup', [])
    .then(function(res) { hideBusy(); alert('✅ ' + res.message); })
    .catch(function(err) { hideBusy(); alert('BK保存エラー: ' + (err.message || err)); });
}

function openLogEditModal() {
  const rev = (state.rows || []).slice().reverse();
  const wrap = document.getElementById('log-edit-list');
  if (rev.length === 0) {
    wrap.innerHTML = '<div style="text-align:center; color:#64748b; padding:20px;">打刻データがありません</div>';
  } else {
    wrap.innerHTML = rev.map(r => `
      <div style="border:1px solid #cbd5e1; border-radius:8px; padding:8px; background:${r.isRed ? '#fff1f2' : '#f8fafc'};">
        <div style="font-size:0.78rem; font-weight:800; margin-bottom:4px;">
          行${r.rowNum}：<span class="${r.isRed ? 'td-red' : ''}">${escapeHtml(r.d)}</span>
        </div>
        <div style="display:flex; gap:5px;">
          <input type="text" id="edit-e-${r.rowNum}" value="${escapeHtml(r.e)}" style="flex:1; padding:6px; font-size:0.82rem; border:1px solid #94a3b8; border-radius:6px;">
          <button type="button" class="mini-btn" onclick="saveEditedRow(${r.rowNum})">修正</button>
          <button type="button" class="mini-btn" style="background:#fee2e2; color:#dc2626; border-color:#fca5a5;" onclick="removeLogRow(${r.rowNum})">削除</button>
        </div>
      </div>`).join('');
  }
  openModal('modal-log-edit');
}

function saveEditedRow(rowNum) {
  const val = document.getElementById('edit-e-' + rowNum).value;
  showBusy('⏳ 再照合・更新中です...');
  callGasApi('updateLogEntry', [rowNum, val])
    .then(function(dash) {
      hideBusy();
      applyDashboard(dash);
      openLogEditModal();
      showToast('✅ 行' + rowNum + 'を修正・再照合しました');
    })
    .catch(function(err) { hideBusy(); alert(err.message || err); });
}

function removeLogRow(rowNum) {
  if (!confirm('行' + rowNum + 'を完全に削除しますか？')) return;
  showBusy('⏳ 削除中です...');
  callGasApi('deleteLogRow', [rowNum])
    .then(function(dash) {
      hideBusy();
      applyDashboard(dash);
      openLogEditModal();
      showToast('🗑️ 行' + rowNum + 'を削除しました');
    })
    .catch(function(err) { hideBusy(); alert(err.message || err); });
}

function runTransferAndPostBackup() {
  if (!confirm('③ 修正後の確定データを各シート（D・F・G列）へ転記し、「修正後BK」を保存しますか？')) return;
  showBusy('📂 各シートへ転記 ＆ 修正後BK保存中...');
  callGasApi('executeTransferAndPostBackup', [])
    .then(function(res) { hideBusy(); alert('✅ ' + res.message); })
    .catch(function(err) { hideBusy(); alert('転記・BKエラー: ' + (err.message || err)); });
}

function colNumToLetter(n) {
  let s = '';
  while (n > 0) {
    let rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function openWinnerModal() {
  openModal('modal-winner');
  document.getElementById('winner-stats-badge').innerText = '⏳ 読み込み中...';
  document.getElementById('winner-jump-bar').innerHTML = '';
  document.getElementById('winner-editor-body').innerHTML = '<div style="padding:20px; text-align:center; font-weight:bold;">⏳ 当選者シート全体を読み込んでいます...</div>';
  callGasApi('getWinnerSheetForEditor', [])
    .then(function(data) {
      lastWinnerData = data;
      renderWinnerEditor(data);
    })
    .catch(function(err) {
      document.getElementById('winner-stats-badge').innerText = '⚠️ エラー';
      document.getElementById('winner-editor-body').innerText = 'エラー: ' + (err.message || err);
    });
}

function toggleWinnerViewMode() {
  winnerViewMode = (winnerViewMode === 'table') ? 'card' : 'table';
  document.getElementById('winner-view-toggle').innerText =
    (winnerViewMode === 'table') ? '🗂️ カード表示に切替' : '📊 表形式に戻す';
  if (lastWinnerData) renderWinnerEditor(lastWinnerData);
}

function jumpToWinnerCol(colNum) {
  const el = document.getElementById('w-col-anchor-' + colNum);
  if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
}

function renderWinnerEditor(data) {
  if (data && data.ssUrl) document.getElementById('winner-ss-direct').href = data.ssUrl;
  const body = document.getElementById('winner-editor-body');
  const jumpBar = document.getElementById('winner-jump-bar');
  const statsEl = document.getElementById('winner-stats-badge');
  const rawCols = (data && data.columns) ? data.columns : [];

  const activeCols = rawCols.filter(c => {
    const hasCustomHeader = c.header && !/^列\d+$/.test(c.header);
    return hasCustomHeader || (c.items && c.items.length > 0);
  });

  if (activeCols.length === 0) {
    statsEl.innerText = '全 0列';
    jumpBar.innerHTML = '';
    body.innerHTML = '<div style="padding:20px; text-align:center; color:#64748b;">表示できるデータがありません。</div>';
    return;
  }

  winnerCellStore = {};
  winnerColHeaderStore = {};
  const rowSet = new Set();
  let totalItems = 0;
  const colMaxRow = {};

  activeCols.forEach(col => {
    winnerColHeaderStore[col.col] = col.header;
    let maxR = 1;
    (col.items || []).forEach(it => {
      const key = it.row + '_' + it.col;
      winnerCellStore[key] = it;
      rowSet.add(it.row);
      totalItems++;
      if (it.row > maxR) maxR = it.row;
    });
    colMaxRow[col.col] = maxR;
  });

  const sortedRows = Array.from(rowSet).sort((a, b) => a - b);
  statsEl.innerText = `全 ${activeCols.length}列 ／ ${totalItems}件表示中`;
  jumpBar.innerHTML = activeCols.map(col => {
    const letter = colNumToLetter(col.col);
    return `<button type="button" class="jump-pill" onclick="jumpToWinnerCol(${col.col})">${letter}: ${escapeHtml(col.header)} (${col.items.length})</button>`;
  }).join('');

  if (winnerViewMode === 'table') {
    let html = '<table class="winner-grid-table"><thead><tr><th class="col-row-num">行</th>';
    activeCols.forEach(col => {
      const letter = colNumToLetter(col.col);
      html += `<th id="w-col-anchor-${col.col}"><div style="font-size:0.68rem; color:#93c5fd;">${letter}列 (${col.items.length}件)</div><div>${escapeHtml(col.header)}</div></th>`;
    });
    html += '</tr></thead><tbody>';

    sortedRows.forEach(rNum => {
      html += `<tr><td class="col-row-num">${rNum}</td>`;
      activeCols.forEach(col => {
        const key = rNum + '_' + col.col;
        const it = winnerCellStore[key];
        if (it) {
          const bgStyle = it.highlighted ? ` style="background:${escapeHtml(it.bgColor)};"` : '';
          html += `<td${bgStyle}><div class="w-cell-inner">
            <span class="w-cell-txt">${it.highlighted ? '✅ ' : ''}${escapeHtml(it.value)}</span>
            <span class="w-cell-acts">
              <button type="button" class="w-mini-act" onclick="editWinnerByKey('${key}')">✏️</button>
              <button type="button" class="w-mini-act del" onclick="deleteWinnerByKey('${key}')">🗑️</button>
            </span></div></td>`;
        } else {
          html += `<td style="background:#fafafa;"></td>`;
        }
      });
      html += '</tr>';
    });

    html += `<tr><td class="col-row-num">＋</td>`;
    activeCols.forEach(col => {
      const nextRow = (colMaxRow[col.col] || 1) + 1;
      html += `<td><button type="button" class="w-add-cell-btn" onclick="addWinnerToCol(${nextRow}, ${col.col})">＋ ${colNumToLetter(col.col)}列に追加</button></td>`;
    });
    html += '</tr></tbody></table>';
    body.innerHTML = html;
  } else {
    body.innerHTML = '<div style="padding:8px;">' + activeCols.map(col => {
      const letter = colNumToLetter(col.col);
      const nextRow = (colMaxRow[col.col] || 1) + 1;
      const itemsHtml = col.items.length === 0
        ? '<div style="font-size:0.78rem; color:#94a3b8; margin-bottom:4px;">（対象なし）</div>'
        : col.items.map(it => {
            const key = it.row + '_' + it.col;
            const bgVal = it.highlighted ? escapeHtml(it.bgColor) : '#ffffff';
            return `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:5px 6px; margin-bottom:4px; border-radius:6px; border:1px solid #cbd5e1; background:${bgVal};">
              <span style="font-size:0.84rem; font-weight:bold; word-break:break-all; color:#0f172a;">${it.highlighted ? '✅ ' : ''}${escapeHtml(it.value)}</span>
              <div style="display:flex; gap:4px; flex-shrink:0;">
                <button type="button" class="w-mini-act" onclick="editWinnerByKey('${key}')">編集</button>
                <button type="button" class="w-mini-act del" onclick="deleteWinnerByKey('${key}')">削除</button>
              </div></div>`;
          }).join('');
      return `<div id="w-col-anchor-${col.col}" style="margin-bottom:10px; padding:8px; background:#f8fafc; border-radius:8px; border:1px solid #cbd5e1;">
        <div style="font-weight:900; font-size:0.86rem; color:#1e3a8a; margin-bottom:6px;">${letter}列：${escapeHtml(col.header)}（${col.items.length}件）</div>
        ${itemsHtml}
        <button type="button" class="w-add-cell-btn" style="margin-top:4px;" onclick="addWinnerToCol(${nextRow}, ${col.col})">＋ この列に追加</button>
      </div>`;
    }).join('') + '</div>';
  }
}

function editWinnerByKey(key) {
  const it = winnerCellStore[key];
  if (!it) return;
  const next = prompt('新しい内容を入力してください（空欄にすると削除）:', it.value);
  if (next === null) return;
  saveWinnerCellUpdate(it.row, it.col, next, '✅ 更新しました');
}

function deleteWinnerByKey(key) {
  const it = winnerCellStore[key];
  if (!it) return;
  if (!confirm('「' + it.value + '」を当選者管理シートから削除しますか？')) return;
  saveWinnerCellUpdate(it.row, it.col, '', '🗑️ 削除しました');
}

function addWinnerToCol(row, col) {
  const headerName = winnerColHeaderStore[col] || ('列' + col);
  const val = prompt('「' + headerName + '」に追加するIDまたは名前を入力してください:', '');
  if (val === null || !val.trim()) return;
  saveWinnerCellUpdate(row, col, val.trim(), '✅ 追加しました');
}

function saveWinnerCellUpdate(row, col, newValue, toastMsg) {
  showBusy('⏳ 当選者シートを更新中...');
  callGasApi('updateWinnerSheetCell', [row, col, newValue])
    .then(function(data) {
      hideBusy();
      lastWinnerData = data;
      renderWinnerEditor(data);
      showToast(toastMsg);
    })
    .catch(function(err) { hideBusy(); alert(err.message || err); });
}

function runResetTodayLog() {
  if (!confirm('⑥ 本日の打刻ログをすべて初期化します。\n①前BK・③転記＆後BK・⑤当選者整理は終わっていますか？')) return;
  if (!confirm('本当によろしいですか？2行目以降のデータがすべて消去されます。')) return;
  showBusy('🗑️ 打刻ログを初期化中です...');
  callGasApi('resetTodayLog', [])
    .then(function(dash) {
      hideBusy();
      clearAlertFlashState();
      applyDashboard(dash);
      document.getElementById('recent-name').innerText = '待機中...';
      document.getElementById('recent-notif').innerText = '';
      document.getElementById('recent-card').className = 'recent-card';
      showToast('✅ 本日の打刻ログを初期化しました');
    })
    .catch(function(err) { hideBusy(); alert(err.message || err); });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

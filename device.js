// =========================================================================
// device.js : 複数GASアプリ切替 / GAS API通信 / カメラQR(前後切替・鏡像・WakeLock) / Web NFC
// =========================================================================

const LEGACY_GAS_URL_KEY = 'NARA_LUCKY_SLOT_GAS_URL_V1';
const APP_REGISTRY_KEY = 'NARA_LUCKY_SLOT_APPS_V2';
const ACTIVE_APP_ID_KEY = 'NARA_LUCKY_SLOT_ACTIVE_APP_ID_V2';
const CAMERA_FACING_KEY = 'NARA_LUCKY_SLOT_CAM_FACING_V1';

let appRegistry = [];
let activeAppId = null;

// カメラQR状態
let qrStream = null;
let qrVideoTrack = null;
let qrScanRafId = null;
let qrIsRunning = false;
let qrTorchOn = false;
let qrBarcodeDetector = null;
let qrEngineName = '';
let qrDetectBusy = false;
let qrLastCode = '';
let qrLastTime = 0;
let qrFacingMode = 'environment'; // 'environment'（アウト） | 'user'（イン）
let qrWakeLock = null;

// Web NFC状態
let nfcReader = null;
let nfcAbortController = null;
let nfcIsRunning = false;
let nfcLastCode = '';
let nfcLastTime = 0;

// -------------------------------------------------------------------------
// 初期化（複数アプリリスト復元 ＆ 共有URLからの自動登録）
// -------------------------------------------------------------------------
function initDeviceLayer() {
  try {
    const savedFacing = localStorage.getItem(CAMERA_FACING_KEY);
    if (savedFacing === 'user' || savedFacing === 'environment') {
      qrFacingMode = savedFacing;
    }
  } catch (e) {}

  loadAppRegistry();

  // 共有URL（#gas=... または ?gas=...）から開かれた場合、自動でリストへ登録＆切替
  try {
    let incomingUrl = '';
    let incomingName = '';
    const hash = String(window.location.hash || '');
    if (hash.indexOf('gas=') !== -1) {
      const hParams = new URLSearchParams(hash.replace(/^#/, ''));
      incomingUrl = hParams.get('gas') || '';
      incomingName = hParams.get('name') || '';
    }
    if (!incomingUrl && window.location.search) {
      const qParams = new URLSearchParams(window.location.search);
      incomingUrl = qParams.get('gas') || '';
      incomingName = qParams.get('name') || '';
    }

    const validIncoming = normalizeGasUrl(incomingUrl);
    if (validIncoming) {
      let existing = appRegistry.find(a => a.url === validIncoming);
      if (!existing) {
        existing = {
          id: 'app_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          url: validIncoming,
          ssName: incomingName.trim() || '新規共有アプリ',
          customName: '',
          color: '#1e3a8a'
        };
        appRegistry.push(existing);
        if (typeof showToast === 'function') {
          showToast('🔌 共有リンクから切替リストへ自動登録しました');
        }
      }
      activeAppId = existing.id;
      saveAppRegistry();

      if (window.history && window.history.replaceState) {
        const cleanPath = window.location.origin + window.location.pathname;
        window.history.replaceState(null, '', cleanPath);
      }
    }
  } catch (e) {}

  updateConnButtonUi();

  // 画面バックグラウンド移行時は安全のためカメラ停止、復帰時はWakeLock再取得
  document.addEventListener('visibilitychange', function() {
    if (document.hidden && qrIsRunning) {
      stopCameraQr();
    } else if (!document.hidden && qrIsRunning) {
      requestCameraWakeLock();
    }
  });
}

function normalizeGasUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(\?.*)?$/i.test(s)) {
    return '';
  }
  return s.split('?')[0];
}

function loadAppRegistry() {
  try {
    const raw = localStorage.getItem(APP_REGISTRY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) appRegistry = parsed;
    }
    activeAppId = localStorage.getItem(ACTIVE_APP_ID_KEY) || null;
  } catch (e) {
    appRegistry = [];
    activeAppId = null;
  }

  // 旧バージョン（単一URL保存）からの自動引き継ぎ
  if (appRegistry.length === 0) {
    try {
      const legacy = normalizeGasUrl(localStorage.getItem(LEGACY_GAS_URL_KEY) || '');
      if (legacy) {
        const item = {
          id: 'app_' + Date.now(),
          url: legacy,
          ssName: '登録済みアプリ',
          customName: '',
          color: '#1e3a8a'
        };
        appRegistry.push(item);
        activeAppId = item.id;
        saveAppRegistry();
      }
    } catch (e) {}
  }

  if (!getActiveAppObj() && appRegistry.length > 0) {
    activeAppId = appRegistry[0].id;
    saveAppRegistry();
  }
}

function saveAppRegistry() {
  try {
    localStorage.setItem(APP_REGISTRY_KEY, JSON.stringify(appRegistry));
    if (activeAppId) {
      localStorage.setItem(ACTIVE_APP_ID_KEY, activeAppId);
    } else {
      localStorage.removeItem(ACTIVE_APP_ID_KEY);
    }
  } catch (e) {}
}

function getActiveAppObj() {
  return appRegistry.find(a => a.id === activeAppId) || null;
}

function getAppDisplayLabel(app) {
  if (!app) return '';
  return (app.customName && app.customName.trim()) ? app.customName.trim() : (app.ssName || '名称未取得');
}

function getActiveAppDisplayName() {
  return getAppDisplayLabel(getActiveAppObj());
}

function syncActiveAppMeta(ssName, highlightColor) {
  const active = getActiveAppObj();
  if (!active) return;
  let changed = false;
  if (ssName && active.ssName !== ssName) {
    active.ssName = ssName;
    changed = true;
  }
  if (highlightColor && active.color !== highlightColor) {
    active.color = highlightColor;
    changed = true;
  }
  if (changed) saveAppRegistry();
}

function getGasApiUrl() {
  const active = getActiveAppObj();
  return active ? normalizeGasUrl(active.url) : '';
}

function updateConnButtonUi() {
  const btn = document.getElementById('conn-btn');
  if (!btn) return;
  const active = getActiveAppObj();
  if (active && normalizeGasUrl(active.url)) {
    btn.className = 'conn-btn';
    btn.innerText = '🔌 接続済';
  } else {
    btn.className = 'conn-btn disconnected';
    btn.innerText = '🔌 未接続';
  }
}

// -------------------------------------------------------------------------
// GAS API 通信本体（text/plain送信でCORSプリフライトを完全回避）
// -------------------------------------------------------------------------
async function callGasApi(action, args, customUrl) {
  const endpoint = customUrl ? normalizeGasUrl(customUrl) : getGasApiUrl();
  if (!endpoint) {
    throw new Error('接続先GAS URLが未設定です。右上の「🔌 未接続」ボタンから設定してください。');
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: action,
        args: Array.isArray(args) ? args : []
      }),
      redirect: 'follow'
    });
  } catch (netErr) {
    throw new Error('通信に失敗しました。電波状況またはGAS URLを確認してください。');
  }

  const rawText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    if (rawText.indexOf('accounts.google.com') !== -1 || rawText.indexOf('<!DOCTYPE') !== -1) {
      throw new Error('GASからHTMLが返されました。GASデプロイの「アクセスできるユーザー」が【全員】になっているか確認してください。');
    }
    throw new Error('サーバー応答の解析に失敗しました（HTTP ' + response.status + '）');
  }

  if (!parsed || parsed.ok === false) {
    throw new Error((parsed && parsed.error) ? parsed.error : 'GAS側でエラーが発生しました。');
  }
  return parsed.data;
}

// -------------------------------------------------------------------------
// GAS URL 設定 ＆ 複数アプリワンタップ切替モーダル操作
// -------------------------------------------------------------------------
function renderAppRegistryList() {
  const box = document.getElementById('app-registry-list');
  if (!box) return;

  if (appRegistry.length === 0) {
    box.innerHTML = '<div style="font-size:0.78rem; color:#64748b; padding:6px 2px;">まだアプリが登録されていません。下の欄からGASの /exec URLを追加してください。</div>';
    return;
  }

  box.innerHTML = appRegistry.map(app => {
    const isActive = (app.id === activeAppId);
    const disp = getAppDisplayLabel(app);
    const sub = app.customName ? ('シート名: ' + (app.ssName || '未取得')) : app.url;
    const dotColor = app.color || '#1e3a8a';
    return `
      <div class="app-switch-item${isActive ? ' active' : ''}">
        <span class="app-color-dot" style="background:${escapeHtml(dotColor)};"></span>
        <div class="app-switch-info" onclick="switchRegisteredApp('${escapeHtml(app.id)}')">
          <div class="app-switch-name">${isActive ? '🟢 ' : ''}${escapeHtml(disp)}</div>
          <div class="app-switch-sub">${escapeHtml(sub)}</div>
        </div>
        <div class="app-switch-acts">
          <button type="button" class="app-mini-act" onclick="renameRegisteredApp('${escapeHtml(app.id)}')" title="表示名を変更">✏️</button>
          <button type="button" class="app-mini-act del" onclick="removeRegisteredApp('${escapeHtml(app.id)}')" title="リストから削除">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function switchRegisteredApp(id) {
  const target = appRegistry.find(a => a.id === id);
  if (!target) return;
  activeAppId = target.id;
  saveAppRegistry();
  updateConnButtonUi();
  renderAppRegistryList();
  if (typeof closeModal === 'function') closeModal('modal-gas-url');
  if (typeof showToast === 'function') showToast('🔄 切替中: ' + getAppDisplayLabel(target));
  if (typeof fetchDashboard === 'function') fetchDashboard(true);
}

function renameRegisteredApp(id) {
  const target = appRegistry.find(a => a.id === id);
  if (!target) return;
  const next = prompt(
    'このスマホでの表示名を入力してください。\n（空欄でOKするとスプレッドシート名に自動で戻ります）',
    target.customName || target.ssName || ''
  );
  if (next === null) return;
  target.customName = next.trim();
  saveAppRegistry();
  renderAppRegistryList();
  if (target.id === activeAppId) {
    const titleEl = document.getElementById('header-ss-name');
    if (titleEl) titleEl.innerText = '🌸 ' + getAppDisplayLabel(target);
  }
  if (typeof showToast === 'function') showToast('✅ 表示名を更新しました');
}

function removeRegisteredApp(id) {
  const target = appRegistry.find(a => a.id === id);
  if (!target) return;
  if (!confirm('「' + getAppDisplayLabel(target) + '」を切替リストから削除しますか？\n（スプレッドシート本体は消えません）')) return;
  appRegistry = appRegistry.filter(a => a.id !== id);
  if (activeAppId === id) {
    activeAppId = appRegistry.length > 0 ? appRegistry[0].id : null;
  }
  saveAppRegistry();
  updateConnButtonUi();
  renderAppRegistryList();
  if (activeAppId && typeof fetchDashboard === 'function') {
    fetchDashboard(true);
  }
  if (typeof showToast === 'function') showToast('🗑️ リストから削除しました');
}

function openGasUrlModal() {
  renderAppRegistryList();
  const inp = document.getElementById('gas-url-input');
  const nameInp = document.getElementById('gas-app-name-input');
  const msg = document.getElementById('gas-conn-msg');
  if (inp) inp.value = '';
  if (nameInp) nameInp.value = '';
  if (msg) {
    msg.style.color = '#334155';
    const active = getActiveAppObj();
    msg.innerText = active
      ? '✅ 現在の接続先：' + getAppDisplayLabel(active)
      : '⚠️ 未接続です。GASの /exec URLを貼り付けてください';
  }
  if (typeof openModal === 'function') openModal('modal-gas-url');
}

async function saveAndTestGasUrl() {
  const inp = document.getElementById('gas-url-input');
  const nameInp = document.getElementById('gas-app-name-input');
  const msg = document.getElementById('gas-conn-msg');
  const raw = inp ? inp.value.trim() : '';
  const customName = nameInp ? nameInp.value.trim() : '';
  const validUrl = normalizeGasUrl(raw);

  if (!validUrl) {
    if (msg) {
      msg.style.color = '#dc2626';
      msg.innerText = '❌ URLの形式が正しくありません。「https://script.google.com/macros/s/.../exec」を入力してください。';
    }
    return;
  }

  if (msg) {
    msg.style.color = '#1d4ed8';
    msg.innerText = '⏳ GASへ接続テスト中...';
  }

  try {
    const pingData = await callGasApi('ping', [], validUrl);
    const fetchedName = (pingData && pingData.ssName) ? String(pingData.ssName).trim() : '';

    let existing = appRegistry.find(a => a.url === validUrl);
    if (existing) {
      if (fetchedName) existing.ssName = fetchedName;
      if (customName) existing.customName = customName;
      activeAppId = existing.id;
    } else {
      const created = {
        id: 'app_' + Date.now(),
        url: validUrl,
        ssName: fetchedName || customName || '打刻Webアプリ',
        customName: customName,
        color: '#1e3a8a'
      };
      appRegistry.push(created);
      activeAppId = created.id;
    }

    saveAppRegistry();
    updateConnButtonUi();
    renderAppRegistryList();

    if (msg) {
      msg.style.color = '#15803d';
      msg.innerText = '✅ 接続成功！「' + getActiveAppDisplayName() + '」を保存しました。';
    }
    if (typeof showToast === 'function') showToast('✅ GASに接続しました');
    setTimeout(function() {
      if (typeof closeModal === 'function') closeModal('modal-gas-url');
      if (typeof fetchDashboard === 'function') fetchDashboard(true);
    }, 450);
  } catch (err) {
    if (msg) {
      msg.style.color = '#dc2626';
      msg.innerText = '❌ ' + (err.message || err);
    }
  }
}

function copyShareSetupLink() {
  const active = getActiveAppObj();
  const inp = document.getElementById('gas-url-input');
  const url = normalizeGasUrl((inp && inp.value) ? inp.value : (active ? active.url : ''));
  if (!url) {
    alert('先に有効なGASの /exec URLを登録または入力してください。');
    return;
  }
  const base = window.location.origin + window.location.pathname;
  const shareUrl = base + '#gas=' + encodeURIComponent(url);

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareUrl).then(function() {
      if (typeof showToast === 'function') showToast('🔗 スタッフ共有用URLをコピーしました（開くだけで自動登録）');
    }).catch(function() {
      fallbackCopyText(shareUrl);
    });
  } else {
    fallbackCopyText(shareUrl);
  }
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  if (typeof showToast === 'function') showToast('🔗 コピーしました');
}

function clearSavedGasUrl() {
  if (!confirm('この端末に保存されているアプリ登録リストをすべて消去しますか？')) return;
  appRegistry = [];
  activeAppId = null;
  try {
    localStorage.removeItem(APP_REGISTRY_KEY);
    localStorage.removeItem(ACTIVE_APP_ID_KEY);
    localStorage.removeItem(LEGACY_GAS_URL_KEY);
  } catch (e) {}
  renderAppRegistryList();
  updateConnButtonUi();
  const msg = document.getElementById('gas-conn-msg');
  if (msg) {
    msg.style.color = '#dc2626';
    msg.innerText = '🗑️ 登録リストをすべて消去しました。';
  }
  if (typeof showToast === 'function') showToast('🗑️ 接続設定を消去しました');
}

// -------------------------------------------------------------------------
// 🚨 ロック連動（カメラQR・NFCボタンの無効化制御）
// -------------------------------------------------------------------------
function setDeviceToolsLocked(locked) {
  const qrBtn = document.getElementById('qr-cam-btn');
  const nfcBtn = document.getElementById('nfc-btn');
  if (qrBtn) qrBtn.disabled = !!locked;
  if (nfcBtn) nfcBtn.disabled = !!locked;
}

// -------------------------------------------------------------------------
// スマホカメラQR読み取り（前後切替・鏡像・WakeLock・一括ロック連動）
// -------------------------------------------------------------------------
async function initQrEngine() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (Array.isArray(formats) && formats.indexOf('qr_code') !== -1) {
        qrBarcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        qrEngineName = '高速QR';
        return true;
      }
    } catch (e) {}
  }
  qrBarcodeDetector = null;
  if (typeof window.jsQR === 'function') {
    qrEngineName = '標準QR';
    return true;
  }
  return false;
}

async function requestCameraWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (qrWakeLock) return;
    qrWakeLock = await navigator.wakeLock.request('screen');
    qrWakeLock.addEventListener('release', function() {
      qrWakeLock = null;
    });
  } catch (e) {}
}

function releaseCameraWakeLock() {
  if (qrWakeLock) {
    try { qrWakeLock.release(); } catch (e) {}
    qrWakeLock = null;
  }
}

function getCameraFacingLabel() {
  return qrFacingMode === 'user' ? 'インカメラ' : 'アウトカメラ';
}

function updateCameraStatusUi() {
  const panel = document.getElementById('qr-reader-panel');
  const label = document.getElementById('qr-engine-label');
  if (!panel || !label) return;

  panel.classList.remove('cam-fast', 'cam-busy', 'cam-locked');

  const locked = (typeof isAlertLocked !== 'undefined' && isAlertLocked);
  const submitting = (typeof isSubmittingScan !== 'undefined' && isSubmittingScan);
  const slotBusy = (typeof isSlotInputLocked !== 'undefined' && isSlotInputLocked);
  const slotOff = (typeof isSlotFeatureEnabled === 'function' && !isSlotFeatureEnabled());

  if (locked) {
    panel.classList.add('cam-locked');
    label.innerText = '🔒 🚨重要通知の確認待ち';
  } else if (submitting) {
    panel.classList.add('cam-busy');
    label.innerText = '⏳ 照合中…';
  } else if (slotBusy) {
    panel.classList.add('cam-busy');
    label.innerText = '🎰 スロット演出中…';
  } else if (slotOff) {
    panel.classList.add('cam-fast');
    label.innerText = '⚡ 高速スキャンOK（' + getCameraFacingLabel() + '）';
  } else {
    label.innerText = '📷 読取OK（' + getCameraFacingLabel() + '）';
  }
}

function toggleCameraQr() {
  if (typeof isAlertLocked !== 'undefined' && isAlertLocked) {
    if (typeof notifyLockedScanAttempt === 'function') notifyLockedScanAttempt();
    return;
  }
  if (qrIsRunning) {
    stopCameraQr();
  } else {
    startCameraQr();
  }
}

async function openCameraStream(facing) {
  if (qrStream) {
    qrStream.getTracks().forEach(function(t) {
      try { t.stop(); } catch (e) {}
    });
    qrStream = null;
  }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
  } catch (e) {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
  }

  qrStream = stream;
  const video = document.getElementById('qr-video');
  const wrap = document.getElementById('qr-video-wrap');
  const torchBtn = document.getElementById('qr-torch-btn');

  // インカメラ時のみ映像枠に鏡像クラスを付与（Android Chrome 確実反転）
  if (wrap) {
    wrap.classList.toggle('is-front-cam', facing === 'user');
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  try { await video.play(); } catch (e) {}

  // ライト（トーチ）対応チェック（インカメラ時は常に非表示）
  qrTorchOn = false;
  qrVideoTrack = stream.getVideoTracks()[0] || null;
  if (torchBtn) {
    torchBtn.style.display = 'none';
    torchBtn.classList.remove('on');
    if (facing !== 'user' && qrVideoTrack && typeof qrVideoTrack.getCapabilities === 'function') {
      try {
        const caps = qrVideoTrack.getCapabilities();
        if (caps && caps.torch) {
          torchBtn.style.display = 'inline-block';
        }
      } catch (e) {}
    }
  }
}

async function startCameraQr() {
  if (typeof getAudioCtx === 'function') getAudioCtx();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('このブラウザではカメラを利用できません。HTTPS環境（GitHub Pages）のChromeまたはSafariで開いてください。');
    return;
  }

  const okEngine = await initQrEngine();
  if (!okEngine) {
    alert('QR解析ライブラリの読み込み中です。1〜2秒待ってからもう一度押してください。');
    return;
  }

  try {
    await openCameraStream(qrFacingMode);
  } catch (err) {
    alert('カメラを起動できませんでした。\nブラウザのカメラ許可設定を確認してください。\n(' + (err.message || err.name) + ')');
    return;
  }

  qrIsRunning = true;
  await requestCameraWakeLock();

  const panel = document.getElementById('qr-reader-panel');
  const btn = document.getElementById('qr-cam-btn');
  if (panel) panel.style.display = 'block';
  if (btn) {
    btn.classList.add('qr-active');
    btn.innerText = '📷 カメラ停止';
  }
  updateCameraStatusUi();
  scanQrFrameLoop();
}

async function switchCameraFacing() {
  qrFacingMode = (qrFacingMode === 'environment') ? 'user' : 'environment';
  try { localStorage.setItem(CAMERA_FACING_KEY, qrFacingMode); } catch (e) {}

  if (!qrIsRunning) return;
  try {
    await openCameraStream(qrFacingMode);
    updateCameraStatusUi();
    if (typeof showToast === 'function') {
      showToast('🔄 ' + getCameraFacingLabel() + 'に切り替えました');
    }
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast('⚠️ カメラ切替に失敗しました: ' + (err.message || err));
    }
  }
}

function stopCameraQr() {
  qrIsRunning = false;
  qrDetectBusy = false;
  qrTorchOn = false;
  if (qrScanRafId) {
    cancelAnimationFrame(qrScanRafId);
    qrScanRafId = null;
  }
  if (qrStream) {
    qrStream.getTracks().forEach(function(t) {
      try { t.stop(); } catch (e) {}
    });
    qrStream = null;
  }
  qrVideoTrack = null;
  releaseCameraWakeLock();

  const video = document.getElementById('qr-video');
  if (video) video.srcObject = null;
  const wrap = document.getElementById('qr-video-wrap');
  if (wrap) wrap.classList.remove('is-front-cam');
  const panel = document.getElementById('qr-reader-panel');
  if (panel) panel.style.display = 'none';
  const btn = document.getElementById('qr-cam-btn');
  if (btn) {
    btn.classList.remove('qr-active');
    btn.innerText = '📷 カメラQR';
  }
  const torchBtn = document.getElementById('qr-torch-btn');
  if (torchBtn) {
    torchBtn.classList.remove('on');
    torchBtn.style.display = 'none';
  }
}

async function toggleQrTorch() {
  if (!qrVideoTrack || qrFacingMode === 'user') return;
  try {
    qrTorchOn = !qrTorchOn;
    await qrVideoTrack.applyConstraints({ advanced: [{ torch: qrTorchOn }] });
    const b = document.getElementById('qr-torch-btn');
    if (b) b.className = 'qr-mini-btn' + (qrTorchOn ? ' on' : '');
  } catch (e) {
    qrTorchOn = false;
    if (typeof showToast === 'function') showToast('🔦 この端末ではライト制御に非対応です');
  }
}

function isScannerInputBlocked() {
  if (typeof isAlertLocked !== 'undefined' && isAlertLocked) return true;
  if (typeof isSubmittingScan !== 'undefined' && isSubmittingScan) return true;
  if (typeof isSlotInputLocked !== 'undefined' && isSlotInputLocked) return true;
  return false;
}

function scanQrFrameLoop() {
  if (!qrIsRunning) return;
  qrScanRafId = requestAnimationFrame(scanQrFrameLoop);

  if (qrDetectBusy) return;
  // 照合中・スロット演出中・結果後2秒クールダウン・🚨ロック中は映像維持のまま読取スキップ
  if (isScannerInputBlocked()) return;

  const video = document.getElementById('qr-video');
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

  qrDetectBusy = true;

  if (qrBarcodeDetector) {
    qrBarcodeDetector.detect(video).then(function(codes) {
      qrDetectBusy = false;
      if (!qrIsRunning) return;
      if (codes && codes.length > 0 && codes[0].rawValue) {
        handleDetectedQrCode(codes[0].rawValue);
      }
    }).catch(function() {
      qrDetectBusy = false;
    });
    return;
  }

  // jsQR フォールバック（非反転の生映像で解析）
  try {
    const canvas = document.getElementById('qr-canvas');
    if (canvas && typeof window.jsQR === 'function') {
      const targetW = Math.min(video.videoWidth, 640);
      const targetH = Math.round((video.videoHeight / video.videoWidth) * targetW);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, targetW, targetH);
      const imgData = ctx.getImageData(0, 0, targetW, targetH);
      const found = window.jsQR(imgData.data, targetW, targetH, { inversionAttempts: 'dontInvert' });
      if (found && found.data) {
        handleDetectedQrCode(found.data);
      }
    }
  } catch (e) {}
  qrDetectBusy = false;
}

function handleDetectedQrCode(rawVal) {
  const clean = String(rawVal || '').trim();
  if (!clean) return;

  if (typeof isAlertLocked !== 'undefined' && isAlertLocked) {
    if (typeof notifyLockedScanAttempt === 'function') notifyLockedScanAttempt();
    return;
  }
  if (isScannerInputBlocked()) return;

  const now = Date.now();
  if (clean === qrLastCode && (now - qrLastTime) < 2800) {
    return;
  }
  qrLastCode = clean;
  qrLastTime = now;

  if (navigator.vibrate) {
    try { navigator.vibrate(60); } catch (e) {}
  }
  if (typeof submitScan === 'function') {
    submitScan(clean);
  }
}

// -------------------------------------------------------------------------
// Web NFC タグ読み取り（Android Chrome HTTPS専用）
// -------------------------------------------------------------------------
function toggleNfcReader() {
  if (typeof isAlertLocked !== 'undefined' && isAlertLocked) {
    if (typeof notifyLockedScanAttempt === 'function') notifyLockedScanAttempt();
    return;
  }
  if (nfcIsRunning) {
    stopNfcReader();
  } else {
    startNfcReader();
  }
}

async function startNfcReader() {
  if (typeof getAudioCtx === 'function') getAudioCtx();

  if (!('NDEFReader' in window)) {
    alert('この端末・ブラウザはWeb NFCに対応していません。\nNFC読取は Android版 Google Chrome でご利用ください。');
    return;
  }

  const btn = document.getElementById('nfc-btn');
  const bar = document.getElementById('nfc-status-bar');

  try {
    nfcAbortController = new AbortController();
    nfcReader = new window.NDEFReader();
    await nfcReader.scan({ signal: nfcAbortController.signal });

    nfcIsRunning = true;
    if (btn) {
      btn.classList.add('nfc-active');
      btn.innerText = '📶 NFC待機中';
    }
    if (bar) bar.style.display = 'block';
    if (typeof showToast === 'function') showToast('📶 NFC待機を開始しました。タグをかざしてください');

    nfcReader.onreadingerror = function() {
      if (typeof showToast === 'function') showToast('⚠️ NFCタグをうまく読めませんでした。もう一度かざしてください');
    };

    nfcReader.onreading = function(event) {
      if (typeof isAlertLocked !== 'undefined' && isAlertLocked) {
        if (typeof notifyLockedScanAttempt === 'function') notifyLockedScanAttempt();
        return;
      }
      if (isScannerInputBlocked()) return;

      const payload = extractNfcPayload(event);
      if (!payload) {
        if (typeof showToast === 'function') showToast('⚠️ NFCタグ内に読み取れるデータがありません');
        return;
      }

      const now = Date.now();
      if (payload === nfcLastCode && (now - nfcLastTime) < 2500) {
        return;
      }
      nfcLastCode = payload;
      nfcLastTime = now;

      if (navigator.vibrate) {
        try { navigator.vibrate(80); } catch (e) {}
      }
      if (typeof submitScan === 'function') {
        submitScan(payload);
      }
    };
  } catch (err) {
    stopNfcReader();
    if (err && err.name === 'NotAllowedError') {
      alert('NFCの利用が許可されていません。端末のNFC設定をONにし、Chromeの権限を許可してください。');
    } else if (err && err.name !== 'AbortError') {
      alert('NFC読取を開始できませんでした: ' + (err.message || err));
    }
  }
}

function stopNfcReader() {
  nfcIsRunning = false;
  if (nfcAbortController) {
    try { nfcAbortController.abort(); } catch (e) {}
    nfcAbortController = null;
  }
  nfcReader = null;

  const btn = document.getElementById('nfc-btn');
  if (btn) {
    btn.classList.remove('nfc-active');
    btn.innerText = '📶 NFC読取';
  }
  const bar = document.getElementById('nfc-status-bar');
  if (bar) bar.style.display = 'none';
}

function extractNfcPayload(event) {
  try {
    const records = (event && event.message && event.message.records) ? event.message.records : [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || !rec.data) continue;
      if (rec.recordType === 'text' || rec.recordType === 'url' || rec.recordType === 'absolute-url') {
        const decoder = new TextDecoder(rec.encoding || 'utf-8');
        const txt = decoder.decode(rec.data).trim();
        if (txt) return txt;
      }
    }
    for (let j = 0; j < records.length; j++) {
      const rec2 = records[j];
      if (!rec2 || !rec2.data) continue;
      const txt2 = new TextDecoder('utf-8').decode(rec2.data).replace(/[\u0000-\u001F\u007F]/g, '').trim();
      if (txt2) return txt2;
    }
  } catch (e) {}

  if (event && event.serialNumber) {
    return String(event.serialNumber).trim();
  }
  return '';
}

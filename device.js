// =========================================================================
// device.js : GAS API通信 / スマホカメラQR / Web NFC 制御
// =========================================================================

const LOCAL_GAS_URL_KEY = 'NARA_LUCKY_SLOT_GAS_URL_V1';

// カメラQR状態
let qrStream = null;
let qrVideoTrack = null;
let qrScanRafId = null;
let qrIsRunning = false;
let qrContinuous = true;
let qrTorchOn = false;
let qrBarcodeDetector = null;
let qrEngineName = '';
let qrDetectBusy = false;
let qrLastCode = '';
let qrLastTime = 0;

// Web NFC状態
let nfcReader = null;
let nfcAbortController = null;
let nfcIsRunning = false;
let nfcLastCode = '';
let nfcLastTime = 0;

// -------------------------------------------------------------------------
// 初期化（URL共有パラメータからの自動取り込み ＆ 接続ボタン状態反映）
// -------------------------------------------------------------------------
function initDeviceLayer() {
  try {
    let incomingUrl = '';
    const hash = String(window.location.hash || '');
    if (hash.indexOf('gas=') !== -1) {
      const params = new URLSearchParams(hash.replace(/^#/, ''));
      incomingUrl = params.get('gas') || '';
    }
    if (!incomingUrl && window.location.search) {
      const qParams = new URLSearchParams(window.location.search);
      incomingUrl = qParams.get('gas') || '';
    }
    incomingUrl = normalizeGasUrl(incomingUrl);
    if (incomingUrl) {
      localStorage.setItem(LOCAL_GAS_URL_KEY, incomingUrl);
      // URLバーから接続URLを消去して履歴に残さない
      if (window.history && window.history.replaceState) {
        const cleanPath = window.location.origin + window.location.pathname;
        window.history.replaceState(null, '', cleanPath);
      }
      if (typeof showToast === 'function') {
        showToast('🔌 共有リンクから接続先GAS URLを保存しました');
      }
    }
  } catch (e) {}

  updateConnButtonUi();

  // バックグラウンド移行時にカメラを安全に解放
  document.addEventListener('visibilitychange', function() {
    if (document.hidden && qrIsRunning) {
      stopCameraQr();
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

function getGasApiUrl() {
  try {
    return normalizeGasUrl(localStorage.getItem(LOCAL_GAS_URL_KEY) || '');
  } catch (e) {
    return '';
  }
}

function updateConnButtonUi() {
  const btn = document.getElementById('conn-btn');
  if (!btn) return;
  const hasUrl = !!getGasApiUrl();
  if (hasUrl) {
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
// GAS URL 設定モーダル操作
// -------------------------------------------------------------------------
function openGasUrlModal() {
  const inp = document.getElementById('gas-url-input');
  const msg = document.getElementById('gas-conn-msg');
  if (inp) inp.value = getGasApiUrl();
  if (msg) {
    msg.style.color = '#334155';
    msg.innerText = getGasApiUrl() ? '✅ 現在この端末に接続先が保存されています' : '⚠️ 未設定です。GASの /exec URLを貼り付けてください';
  }
  if (typeof openModal === 'function') openModal('modal-gas-url');
}

async function saveAndTestGasUrl() {
  const inp = document.getElementById('gas-url-input');
  const msg = document.getElementById('gas-conn-msg');
  const raw = inp ? inp.value.trim() : '';
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
    await callGasApi('ping', [], validUrl);
    localStorage.setItem(LOCAL_GAS_URL_KEY, validUrl);
    updateConnButtonUi();
    if (msg) {
      msg.style.color = '#15803d';
      msg.innerText = '✅ 接続成功！この端末に保存しました。';
    }
    if (typeof showToast === 'function') showToast('✅ GASに接続しました');
    setTimeout(function() {
      if (typeof closeModal === 'function') closeModal('modal-gas-url');
      if (typeof fetchDashboard === 'function') fetchDashboard(true);
    }, 500);
  } catch (err) {
    if (msg) {
      msg.style.color = '#dc2626';
      msg.innerText = '❌ ' + (err.message || err);
    }
  }
}

function copyShareSetupLink() {
  const inp = document.getElementById('gas-url-input');
  const url = normalizeGasUrl((inp && inp.value) ? inp.value : getGasApiUrl());
  if (!url) {
    alert('先に有効なGASの /exec URLを入力・保存してください。');
    return;
  }
  const base = window.location.origin + window.location.pathname;
  const shareUrl = base + '#gas=' + encodeURIComponent(url);

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareUrl).then(function() {
      if (typeof showToast === 'function') showToast('🔗 スタッフ共有用セットアップURLをコピーしました');
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
  if (!confirm('この端末に保存されているGAS接続設定を消去しますか？')) return;
  try { localStorage.removeItem(LOCAL_GAS_URL_KEY); } catch (e) {}
  const inp = document.getElementById('gas-url-input');
  const msg = document.getElementById('gas-conn-msg');
  if (inp) inp.value = '';
  if (msg) {
    msg.style.color = '#dc2626';
    msg.innerText = '🗑️ 接続設定を消去しました。';
  }
  updateConnButtonUi();
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
// スマホカメラQR読み取り（BarcodeDetector優先 ➔ jsQRフォールバック）
// -------------------------------------------------------------------------
async function initQrEngine() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (Array.isArray(formats) && formats.indexOf('qr_code') !== -1) {
        qrBarcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        qrEngineName = '高速QRエンジン';
        return true;
      }
    } catch (e) {}
  }
  qrBarcodeDetector = null;
  if (typeof window.jsQR === 'function') {
    qrEngineName = '標準QRエンジン';
    return true;
  }
  return false;
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

  const panel = document.getElementById('qr-reader-panel');
  const video = document.getElementById('qr-video');
  const btn = document.getElementById('qr-cam-btn');
  const label = document.getElementById('qr-engine-label');
  const torchBtn = document.getElementById('qr-torch-btn');

  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
  } catch (err) {
    alert('カメラを起動できませんでした。\nブラウザのカメラ許可設定を確認してください。\n(' + (err.message || err.name) + ')');
    return;
  }

  video.srcObject = qrStream;
  video.setAttribute('playsinline', 'true');
  try { await video.play(); } catch (e) {}

  qrIsRunning = true;
  qrTorchOn = false;
  if (panel) panel.style.display = 'block';
  if (btn) {
    btn.classList.add('qr-active');
    btn.innerText = '📷 カメラ停止';
  }
  if (label) label.innerText = '📷 読取中（' + qrEngineName + '）';

  // ライト（トーチ）対応チェック
  qrVideoTrack = qrStream.getVideoTracks()[0] || null;
  if (torchBtn) {
    torchBtn.style.display = 'none';
    torchBtn.classList.remove('on');
    if (qrVideoTrack && typeof qrVideoTrack.getCapabilities === 'function') {
      try {
        const caps = qrVideoTrack.getCapabilities();
        if (caps && caps.torch) {
          torchBtn.style.display = 'inline-block';
        }
      } catch (e) {}
    }
  }

  scanQrFrameLoop();
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

  const video = document.getElementById('qr-video');
  if (video) video.srcObject = null;
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

function toggleQrContinuous() {
  qrContinuous = !qrContinuous;
  const b = document.getElementById('qr-cont-btn');
  if (b) {
    b.innerText = qrContinuous ? '連続ON' : '1回のみ';
    b.className = 'qr-mini-btn' + (qrContinuous ? ' on' : '');
  }
}

async function toggleQrTorch() {
  if (!qrVideoTrack) return;
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

function scanQrFrameLoop() {
  if (!qrIsRunning) return;
  qrScanRafId = requestAnimationFrame(scanQrFrameLoop);

  if (qrDetectBusy) return;
  if (typeof isAlertLocked !== 'undefined' && isAlertLocked) return;
  if (typeof isSubmittingScan !== 'undefined' && isSubmittingScan) return;

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

  // jsQR フォールバック
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

  const now = Date.now();
  if (clean === qrLastCode && (now - qrLastTime) < 2800) {
    return;
  }
  qrLastCode = clean;
  qrLastTime = now;

  if (navigator.vibrate) {
    try { navigator.vibrate(60); } catch (e) {}
  }
  if (!qrContinuous) {
    stopCameraQr();
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
    // テキスト・URL以外のレコードが入っている場合のフォールバック
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

// =========================================================================
// Pokémon GO 奈良 打刻Web Luckyスロット【device.js 完全版】
// （カメラQRリーダー ＆ Web NFC リーダー制御）
// =========================================================================

(function () {
  'use strict';

  var LS_CAM_FACING = 'POGO_NARA_CAM_FACING_V1';
  var SAME_CODE_DEBOUNCE_MS = 2200;
  var QR_CROP_MAX_PX = 360;

  var camState = {
    running: false,
    starting: false,
    facingMode: 'environment', // 'environment' | 'user'
    stream: null,
    track: null,
    torchSupported: false,
    torchOn: false,
    rafId: null,
    isDetecting: false,
    lastFrameAt: 0,
    barcodeDetector: null,
    engineName: '',
    lastCode: '',
    lastCodeAt: 0
  };

  var nfcState = {
    running: false,
    abortController: null,
    lastPayload: '',
    lastReadAt: 0
  };

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, ms) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, ms);
    }
  }

  function isBlocked() {
    return typeof window.isScanBlocked === 'function' ? window.isScanBlocked() : false;
  }

  function isAlertLockedNow() {
    return typeof window.isAlertLocked === 'function' ? window.isAlertLocked() : false;
  }

  function dispatchScannedText(rawText, sourceLabel) {
    var text = String(rawText || '').trim();
    if (!text) return false;
    if (isBlocked()) return false;

    var now = Date.now();
    if (sourceLabel === 'qr') {
      if (text === camState.lastCode && (now - camState.lastCodeAt) < SAME_CODE_DEBOUNCE_MS) {
        return false;
      }
      camState.lastCode = text;
      camState.lastCodeAt = now;
    } else if (sourceLabel === 'nfc') {
      if (text === nfcState.lastPayload && (now - nfcState.lastReadAt) < SAME_CODE_DEBOUNCE_MS) {
        return false;
      }
      nfcState.lastPayload = text;
      nfcState.lastReadAt = now;
    }

    if (typeof window.handleExternalScan === 'function') {
      return !!window.handleExternalScan(text);
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // カメラQR：状態表示・枠色同期（app.js からも呼ばれる）
  // -----------------------------------------------------------------------
  function syncCameraPanelState() {
    var panel = $('qr-reader-panel');
    var label = $('qr-engine-label');
    if (!panel || !camState.running) return;

    panel.classList.remove('cam-fast', 'cam-busy', 'cam-locked');

    if (isAlertLockedNow()) {
      panel.classList.add('cam-locked');
      if (label) label.textContent = '🚨 未確認アラートのため読取停止中';
      return;
    }

    if (isBlocked()) {
      panel.classList.add('cam-busy');
      if (label) label.textContent = '⏳ 処理中・ロック待機中…';
      return;
    }

    panel.classList.add('cam-fast');
    var camTag = camState.facingMode === 'user' ? 'イン' : 'アウト';
    var flipTag = document.body.classList.contains('flip-full') ? '・180°台' : '';
    var engTag = camState.engineName || 'QR';
    if (label) {
      label.textContent = '📷 枠内に合わせて読取（' + camTag + flipTag + ' / ' + engTag + '）';
    }
  }

  function updateQrButtonUI() {
    var btn = $('qr-cam-btn');
    if (!btn) return;
    if (camState.running) {
      btn.textContent = '⏹️ カメラ停止';
      btn.classList.add('qr-active');
    } else {
      btn.textContent = '📷 カメラQR';
      btn.classList.remove('qr-active');
    }
  }

  function updateTorchButtonUI() {
    var btn = $('qr-torch-btn');
    if (!btn) return;
    if (camState.running && camState.torchSupported) {
      btn.style.display = 'inline-block';
      btn.classList.toggle('on', camState.torchOn);
      btn.textContent = camState.torchOn ? '🔦 ON' : '🔦';
    } else {
      btn.style.display = 'none';
      btn.classList.remove('on');
      btn.textContent = '🔦';
    }
  }

  // -----------------------------------------------------------------------
  // BarcodeDetector 初期化（対応端末のみ）
  // -----------------------------------------------------------------------
  async function initQrEngine() {
    camState.barcodeDetector = null;
    camState.engineName = 'jsQR';

    if (typeof window.BarcodeDetector === 'function') {
      try {
        var supported = await window.BarcodeDetector.getSupportedFormats();
        if (Array.isArray(supported) && supported.indexOf('qr_code') !== -1) {
          camState.barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
          camState.engineName = '高速';
          return;
        }
      } catch (e) {
        // 非対応時は jsQR へフォールバック
      }
    }
  }

  // -----------------------------------------------------------------------
  // カメラ起動・停止・前後切替・トーチ
  // -----------------------------------------------------------------------
  async function startCameraQr() {
    if (camState.running || camState.starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('⚠️ このブラウザはカメラ起動に対応していません', 2800);
      return;
    }

    camState.starting = true;
    try {
      var savedFacing = localStorage.getItem(LS_CAM_FACING);
      if (savedFacing === 'user' || savedFacing === 'environment') {
        camState.facingMode = savedFacing;
      }
    } catch (e) {}

    var panel = $('qr-reader-panel');
    var video = $('qr-video');
    var wrap = $('qr-video-wrap');

    try {
      await initQrEngine();

      var constraints = {
        audio: false,
        video: {
          facingMode: { ideal: camState.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      var stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (eFirst) {
        // 指定向きで失敗した場合は汎用指定でリトライ
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }

      camState.stream = stream;
      camState.track = stream.getVideoTracks()[0] || null;
      camState.torchOn = false;
      camState.torchSupported = false;

      if (camState.track && typeof camState.track.getCapabilities === 'function') {
        try {
          var caps = camState.track.getCapabilities();
          if (caps && caps.torch) {
            camState.torchSupported = true;
          }
          // 連続オートフォーカス対応端末は有効化
          if (caps && Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') !== -1) {
            camState.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
          }
        } catch (eCap) {}
      }

      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();

      if (wrap) {
        wrap.classList.toggle('is-front-cam', camState.facingMode === 'user');
      }
      if (panel) {
        panel.style.display = 'block';
      }

      camState.running = true;
      camState.lastCode = '';
      camState.lastCodeAt = 0;
      updateQrButtonUI();
      updateTorchButtonUI();
      syncCameraPanelState();
      scheduleNextQrFrame();
    } catch (err) {
      stopCameraQr();
      toast('❌ カメラを起動できませんでした（権限をご確認ください）', 3200);
    } finally {
      camState.starting = false;
    }
  }

  function stopCameraQr() {
    if (camState.rafId) {
      cancelAnimationFrame(camState.rafId);
      camState.rafId = null;
    }
    camState.isDetecting = false;

    if (camState.stream) {
      try {
        camState.stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {}
      camState.stream = null;
    }
    camState.track = null;
    camState.torchSupported = false;
    camState.torchOn = false;
    camState.running = false;

    var video = $('qr-video');
    if (video) {
      try { video.pause(); } catch (e) {}
      video.srcObject = null;
    }

    var panel = $('qr-reader-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.classList.remove('cam-fast', 'cam-busy', 'cam-locked');
    }

    updateQrButtonUI();
    updateTorchButtonUI();
  }

  function toggleCameraQr() {
    if (camState.running) {
      stopCameraQr();
    } else {
      startCameraQr();
    }
  }

  async function switchCameraFacing() {
    camState.facingMode = (camState.facingMode === 'environment') ? 'user' : 'environment';
    try { localStorage.setItem(LS_CAM_FACING, camState.facingMode); } catch (e) {}
    if (camState.running) {
      stopCameraQr();
      await startCameraQr();
      toast(camState.facingMode === 'user' ? '📷 インカメラに切替ました' : '📷 アウトカメラに切替ました', 1600);
    }
  }

  async function toggleQrTorch() {
    if (!camState.running || !camState.track || !camState.torchSupported) return;
    var next = !camState.torchOn;
    try {
      await camState.track.applyConstraints({ advanced: [{ torch: next }] });
      camState.torchOn = next;
      updateTorchButtonUI();
    } catch (e) {
      toast('⚠️ このカメラではライト制御できませんでした', 2000);
    }
  }

  // -----------------------------------------------------------------------
  // カメラQR：枠内切り出し解析ループ
  // -----------------------------------------------------------------------
  function scheduleNextQrFrame() {
    if (!camState.running) return;
    camState.rafId = requestAnimationFrame(qrScanTick);
  }

  function drawCroppedFrameToCanvas(video, canvas) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (!vw || !vh) return null;

    // 画面上の黄色枠（中央付近）を余裕を持って切り出し
    var cropSize = Math.floor(Math.min(vw, vh) * 0.72);
    var sx = Math.floor((vw - cropSize) / 2);
    var sy = Math.floor((vh - cropSize) / 2);
    var destSize = Math.min(cropSize, QR_CROP_MAX_PX);

    if (canvas.width !== destSize || canvas.height !== destSize) {
      canvas.width = destSize;
      canvas.height = destSize;
    }

    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, destSize, destSize);
    return { ctx: ctx, size: destSize };
  }

  async function qrScanTick(timestamp) {
    if (!camState.running) return;

    // 解析間隔を約110ms（約9fps）に抑えて発熱・バッテリー消費を防止
    if (camState.isDetecting || (timestamp - camState.lastFrameAt) < 110) {
      scheduleNextQrFrame();
      return;
    }

    if (isBlocked() || document.hidden) {
      camState.lastFrameAt = timestamp;
      scheduleNextQrFrame();
      return;
    }

    var video = $('qr-video');
    var canvas = $('qr-canvas');
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) {
      scheduleNextQrFrame();
      return;
    }

    camState.isDetecting = true;
    camState.lastFrameAt = timestamp;

    try {
      var frame = drawCroppedFrameToCanvas(video, canvas);
      if (frame) {
        var foundText = '';

        if (camState.barcodeDetector) {
          try {
            var codes = await camState.barcodeDetector.detect(canvas);
            if (codes && codes.length > 0 && codes[0].rawValue) {
              foundText = String(codes[0].rawValue).trim();
            }
          } catch (eDet) {
            // BarcodeDetector 失敗時は jsQR で補助
            camState.barcodeDetector = null;
            camState.engineName = 'jsQR';
            syncCameraPanelState();
          }
        }

        if (!foundText && typeof window.jsQR === 'function') {
          var imgData = frame.ctx.getImageData(0, 0, frame.size, frame.size);
          var decoded = window.jsQR(imgData.data, frame.size, frame.size, {
            inversionAttempts: 'attemptBoth'
          });
          if (decoded && decoded.data) {
            foundText = String(decoded.data).trim();
          }
        }

        if (foundText) {
          dispatchScannedText(foundText, 'qr');
        }
      }
    } catch (e) {
      // 単発フレームの例外は無視して継続
    } finally {
      camState.isDetecting = false;
      scheduleNextQrFrame();
    }
  }

  function isCameraQrRunning() {
    return camState.running;
  }

  // -----------------------------------------------------------------------
  // Web NFC リーダー（Android Chrome 対応）
  // -----------------------------------------------------------------------
  function updateNfcUI() {
    var btn = $('nfc-btn');
    var bar = $('nfc-status-bar');
    if (btn) {
      btn.textContent = nfcState.running ? '⏹️ NFC停止' : '📶 NFC読取';
      btn.classList.toggle('nfc-active', nfcState.running);
    }
    if (bar) {
      bar.style.display = nfcState.running ? 'block' : 'none';
    }
  }

  function extractTextFromNdefEvent(event) {
    try {
      var records = event && event.message && event.message.records ? event.message.records : [];
      var decoder = new TextDecoder('utf-8');
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (!rec) continue;
        if (rec.recordType === 'text') {
          var txtDecoder = new TextDecoder(rec.encoding || 'utf-8');
          var t = txtDecoder.decode(rec.data).trim();
          if (t) return t;
        } else if (rec.recordType === 'url' || rec.recordType === 'absolute-url') {
          var u = decoder.decode(rec.data).trim();
          if (u) return u;
        } else if (rec.data) {
          var raw = decoder.decode(rec.data).trim();
          if (raw) return raw;
        }
      }
      if (event && event.serialNumber) {
        return String(event.serialNumber).trim();
      }
    } catch (e) {}
    return '';
  }

  async function startNfcReader() {
    if (nfcState.running) return;
    if (typeof window.NDEFReader !== 'function') {
      toast('⚠️ NFC読取は Android 版 Chrome のみ対応しています', 3000);
      return;
    }

    try {
      var ndef = new window.NDEFReader();
      var controller = new AbortController();
      nfcState.abortController = controller;

      await ndef.scan({ signal: controller.signal });
      nfcState.running = true;
      updateNfcUI();
      toast('📶 NFC待機を開始しました。カードをかざしてください', 2200);

      ndef.onreading = function (event) {
        var payload = extractTextFromNdefEvent(event);
        if (payload) {
          dispatchScannedText(payload, 'nfc');
        } else {
          toast('⚠️ NFCタグから有効なIDを読み取れませんでした', 2200);
        }
      };

      ndef.onreadingerror = function () {
        toast('⚠️ NFC読取エラー：もう一度カードをかざしてください', 2000);
      };
    } catch (err) {
      stopNfcReader();
      toast('❌ NFCを開始できませんでした：' + (err.message || err), 3000);
    }
  }

  function stopNfcReader() {
    if (nfcState.abortController) {
      try { nfcState.abortController.abort(); } catch (e) {}
      nfcState.abortController = null;
    }
    nfcState.running = false;
    updateNfcUI();
  }

  function toggleNfcReader() {
    if (nfcState.running) {
      stopNfcReader();
      toast('📶 NFC待機を停止しました', 1600);
    } else {
      startNfcReader();
    }
  }

  // ページ離脱時にカメラとNFCを安全に解放
  window.addEventListener('pagehide', function () {
    stopCameraQr();
    stopNfcReader();
  });

  // -----------------------------------------------------------------------
  // グローバル公開
  // -----------------------------------------------------------------------
  window.toggleCameraQr = toggleCameraQr;
  window.stopCameraQr = stopCameraQr;
  window.switchCameraFacing = switchCameraFacing;
  window.toggleQrTorch = toggleQrTorch;
  window.toggleNfcReader = toggleNfcReader;
  window.syncCameraPanelState = syncCameraPanelState;
  window.isCameraQrRunning = isCameraQrRunning;
})();

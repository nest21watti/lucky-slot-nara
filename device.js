/**
 * device.js - カメラQR / スリープ防止 / ライト / Web NFC / 効果音
 * - インカメラ時は映像のみ鏡像（左右反転）表示、QR解析は正常データで実行
 * - カメラ起動中の自動スリープ防止（Wake Lock API）
 * - app.js の一括ロック状態（canScan）に連動し、演出中・ロック中は映像維持のまま読取停止
 */

(function (global) {
  'use strict';

  // ==========================================
  // 1. 効果音エンジン（Web Audio API）
  // ==========================================
  class SoundEngine {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.preset = 'classic';
    }

    ensureContext() {
      if (!this.ctx) {
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        if (AudioCtx) this.ctx = new AudioCtx();
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    setConfig({ enabled, preset }) {
      if (typeof enabled === 'boolean') this.enabled = enabled;
      if (preset) this.preset = preset;
    }

    getWave() {
      switch (this.preset) {
        case 'arcade': return 'sawtooth';
        case 'retro':  return 'square';
        case 'soft':   return 'sine';
        default:       return 'triangle';
      }
    }

    tone(freq, duration, delay = 0, gainPeak = 0.18, waveOverride = null) {
      if (!this.enabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;

      const start = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = waveOverride || this.getWave();
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    }

    playScan() {
      this.tone(880, 0.08, 0, 0.16);
      this.tone(1320, 0.10, 0.07, 0.16);
    }

    playFastOk() {
      // スロットOFF（高速打刻モード）用の軽快な「ピポン！」
      this.tone(1046.5, 0.08, 0, 0.18, 'sine');
      this.tone(1567.98, 0.13, 0.07, 0.20, 'sine');
    }

    playTick() {
      this.tone(520, 0.03, 0, 0.05);
    }

    playReelStop(idx) {
      const freqs = [440, 554.37, 659.25];
      this.tone(freqs[idx] || 520, 0.09, 0, 0.14);
    }

    playWinSmall() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => this.tone(f, 0.14, i * 0.08, 0.18));
    }

    playWinBig() {
      const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5, 1567.98];
      const times = [0, 0.08, 0.16, 0.24, 0.36, 0.44, 0.54, 0.66];
      notes.forEach((f, i) => this.tone(f, i === notes.length - 1 ? 0.45 : 0.13, times[i], 0.22));
    }

    playMiss() {
      this.tone(330, 0.12, 0, 0.12);
      this.tone(261.63, 0.18, 0.12, 0.12);
    }

    playDup() {
      this.tone(240, 0.12, 0, 0.18, 'sawtooth');
      this.tone(200, 0.18, 0.13, 0.18, 'sawtooth');
    }

    playAlert() {
      // 🚨 重要通知ロック警告音（音OFFでも注意喚起のため鳴らす）
      const prev = this.enabled;
      this.enabled = true;
      for (let i = 0; i < 3; i++) {
        this.tone(920, 0.13, i * 0.26, 0.24, 'square');
        this.tone(620, 0.13, i * 0.26 + 0.13, 0.24, 'square');
      }
      this.enabled = prev;
    }

    playPreview() {
      const prev = this.enabled;
      this.enabled = true;
      this.playWinSmall();
      this.enabled = prev;
    }
  }

  // ==========================================
  // 2. カメラQRスキャナー（前後切替・鏡像・WakeLock・ライト）
  // ==========================================
  class CameraController {
    constructor(opts) {
      this.video = opts.video;
      this.canvas = opts.canvas;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.onDetect = opts.onDetect;
      this.canScan = opts.canScan || (() => true);
      this.onStateChange = opts.onStateChange || (() => {});

      this.stream = null;
      this.active = false;
      this.rafId = null;
      this.torchOn = false;
      this.torchSupported = false;
      this.wakeLock = null;

      // 前回のカメラ向きを記憶（デフォルト：アウトカメラ）
      this.facingMode = localStorage.getItem('dakoku_camera_facing') === 'user' ? 'user' : 'environment';

      // 同一QRの連続誤爆防止（2.5秒）
      this.lastCode = '';
      this.lastScanAt = 0;
      this.lastFrameAt = 0;

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.active) {
          this.acquireWakeLock();
        }
      });
    }

    isFront() {
      return this.facingMode === 'user';
    }

    getFacingLabel() {
      return this.isFront() ? 'インカメラ' : 'アウトカメラ';
    }

    async start() {
      if (this.active) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('このブラウザはカメラ機能に対応していません');
      }

      await this.openStream(this.facingMode);
      this.active = true;
      await this.acquireWakeLock();
      this.emitState();
      this.loop();
      return true;
    }

    async openStream(facing) {
      this.stopTracksOnly();
      let stream = null;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
      } catch (e) {
        // PC等で facingMode 指定に失敗した場合のフォールバック
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true
        });
      }

      this.stream = stream;
      this.video.srcObject = stream;
      this.video.setAttribute('playsinline', 'true');
      await this.video.play();

      // インカメラ時のみ映像を左右反転（鏡像）
      this.video.classList.toggle('mirrored', facing === 'user');

      // ライト（トーチ）対応チェック（インカメラ時は常に非表示）
      this.torchOn = false;
      this.torchSupported = false;
      if (facing !== 'user') {
        const track = this.getVideoTrack();
        if (track && typeof track.getCapabilities === 'function') {
          const caps = track.getCapabilities();
          if (caps && caps.torch) {
            this.torchSupported = true;
          }
        }
      }
    }

    async switchCamera() {
      const next = this.facingMode === 'environment' ? 'user' : 'environment';
      this.facingMode = next;
      localStorage.setItem('dakoku_camera_facing', next);

      if (this.active) {
        await this.openStream(next);
        this.emitState();
      }
    }

    async toggleTorch() {
      if (!this.active || !this.torchSupported || this.isFront()) return false;
      const track = this.getVideoTrack();
      if (!track) return false;

      const nextState = !this.torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: nextState }] });
        this.torchOn = nextState;
        this.emitState();
        return this.torchOn;
      } catch (e) {
        this.torchSupported = false;
        this.torchOn = false;
        this.emitState();
        throw new Error('この端末ではライトを切り替えられませんでした');
      }
    }

    stop() {
      this.active = false;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.stopTracksOnly();
      this.releaseWakeLock();
      this.torchOn = false;
      this.torchSupported = false;
      this.video.classList.remove('mirrored');
      this.emitState();
    }

    stopTracksOnly() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => {
          try { t.stop(); } catch (_) {}
        });
        this.stream = null;
      }
      if (this.video) {
        this.video.srcObject = null;
      }
    }

    getVideoTrack() {
      if (!this.stream) return null;
      const tracks = this.stream.getVideoTracks();
      return tracks.length > 0 ? tracks[0] : null;
    }

    async acquireWakeLock() {
      if (!('wakeLock' in navigator)) return;
      try {
        if (this.wakeLock) return;
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      } catch (_) {
        // 非対応環境・省電力モード等は無視
      }
    }

    releaseWakeLock() {
      if (this.wakeLock) {
        try { this.wakeLock.release(); } catch (_) {}
        this.wakeLock = null;
      }
    }

    emitState() {
      this.onStateChange({
        active: this.active,
        facingMode: this.facingMode,
        facingLabel: this.getFacingLabel(),
        torchSupported: this.torchSupported,
        torchOn: this.torchOn
      });
    }

    loop() {
      if (!this.active) return;
      this.rafId = requestAnimationFrame(() => this.loop());

      const now = Date.now();
      // 約8fpsで解析（バッテリー負荷軽減＆十分な応答速度）
      if (now - this.lastFrameAt < 120) return;
      this.lastFrameAt = now;

      // 一括ロック中（照合中・スロット演出中・結果後クールダウン・🚨ロック中）は映像だけ映して読取停止
      if (!this.canScan()) return;

      if (this.video.readyState !== this.video.HAVE_ENOUGH_DATA) return;
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return;

      // 解析用に適度なサイズへ縮小（非反転の生映像をそのまま描画して解析）
      const scale = Math.min(1, 640 / vw);
      const cw = Math.floor(vw * scale);
      const ch = Math.floor(vh * scale);
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }

      this.ctx.drawImage(this.video, 0, 0, cw, ch);
      const imgData = this.ctx.getImageData(0, 0, cw, ch);

      if (typeof global.jsQR !== 'function') return;
      const qr = global.jsQR(imgData.data, cw, ch, { inversionAttempts: 'dontInvert' });
      if (!qr || !qr.data) return;

      const text = String(qr.data).trim();
      if (!text) return;

      // 同一QRの連続誤読ガード（2.5秒）
      if (text === this.lastCode && (now - this.lastScanAt) < 2500) {
        return;
      }
      this.lastCode = text;
      this.lastScanAt = now;

      if (typeof this.onDetect === 'function') {
        this.onDetect(text, 'camera');
      }
    }
  }

  // ==========================================
  // 3. Web NFC コントローラー（Android Chrome 専用）
  // ==========================================
  class NfcController {
    constructor(opts) {
      this.onDetect = opts.onDetect;
      this.canScan = opts.canScan || (() => true);
      this.onStateChange = opts.onStateChange || (() => {});
      this.active = false;
      this.abortController = null;
      this.lastCode = '';
      this.lastScanAt = 0;
    }

    isSupported() {
      return ('NDEFReader' in global);
    }

    async start() {
      if (this.active) return true;
      if (!this.isSupported()) {
        throw new Error('NFC読取は Android の Google Chrome のみ対応しています');
      }

      this.abortController = new AbortController();
      const ndef = new global.NDEFReader();
      await ndef.scan({ signal: this.abortController.signal });

      this.active = true;
      this.onStateChange({ active: true });

      ndef.addEventListener('reading', (event) => {
        if (!this.active || !this.canScan()) return;
        const text = this.extractPayload(event);
        if (!text) return;

        const now = Date.now();
        if (text === this.lastCode && (now - this.lastScanAt) < 2500) return;
        this.lastCode = text;
        this.lastScanAt = now;

        if (typeof this.onDetect === 'function') {
          this.onDetect(text, 'nfc');
        }
      });

      ndef.addEventListener('readingerror', () => {
        // かざし直し待ち
      });

      return true;
    }

    extractPayload(event) {
      try {
        if (event.message && Array.isArray(event.message.records)) {
          const decoder = new TextDecoder();
          for (const rec of event.message.records) {
            if (rec.recordType === 'text' || rec.recordType === 'url') {
              const decoded = decoder.decode(rec.data).trim();
              if (decoded) return decoded;
            }
          }
        }
      } catch (_) {}
      return event.serialNumber ? String(event.serialNumber).trim() : '';
    }

    stop() {
      this.active = false;
      if (this.abortController) {
        try { this.abortController.abort(); } catch (_) {}
        this.abortController = null;
      }
      this.onStateChange({ active: false });
    }
  }

  global.DakokuDevices = {
    SoundEngine,
    CameraController,
    NfcController
  };
})(window);

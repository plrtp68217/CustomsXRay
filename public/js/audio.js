/**
 * audio.js — простые звуки через Web Audio API без внешних файлов.
 * Звуки: гул сканера (фон), бип совмещения, сирена тревоги, динг очков.
 */
(function (root) {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.enabled = true;
      this.scannerHum = null;
      this.scannerGain = null;
    }

    // Ленивая инициализация (после первого жеста пользователя)
    init() {
      if (this.ctx) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.enabled ? 0.5 : 0;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.enabled = false;
      }
    }

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    setEnabled(v) {
      this.enabled = !!v;
      if (this.ctx && this.master) {
        try { this.master.gain.setTargetAtTime(this.enabled ? 0.5 : 0, this.ctx.currentTime, 0.02); } catch (_) {}
      }
      if (!this.enabled) this.stopScannerHum(); // глушим уже играющий гул сканера
    }

    // Простой тональный сигнал
    beep(freq, duration, type = 'sine', volume = 0.3) {
      if (!this.enabled || !this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
      osc.connect(gain).connect(this.master);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    }

    // Бип успешного совмещения силуэтов
    matchBeep() {
      this.beep(660, 0.12, 'sine', 0.25);
      setTimeout(() => this.beep(880, 0.14, 'sine', 0.25), 90);
    }

    // Динг начисления очков
    scoreDing() {
      this.beep(990, 0.16, 'triangle', 0.3);
      setTimeout(() => this.beep(1320, 0.2, 'triangle', 0.3), 110);
    }

    // Сирена тревоги (находка контрабанды)
    alarm() {
      if (!this.enabled || !this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      // качание частоты
      osc.frequency.setValueAtTime(440, t0);
      osc.frequency.linearRampToValueAtTime(880, t0 + 0.25);
      osc.frequency.linearRampToValueAtTime(440, t0 + 0.5);
      osc.frequency.linearRampToValueAtTime(880, t0 + 0.75);
      osc.frequency.linearRampToValueAtTime(440, t0 + 1.0);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.35, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + 1.05);
    }

    // Старт/остановка гула сканера (низкий фон при проверке)
    startScannerHum() {
      if (!this.enabled || !this.ctx || this.scannerHum) return;
      this.scannerHum = this.ctx.createOscillator();
      this.scannerGain = this.ctx.createGain();
      this.scannerHum.type = 'sine';
      this.scannerHum.frequency.value = 90;
      this.scannerGain.gain.value = 0;
      this.scannerGain.gain.linearRampToValueAtTime(0.12, this.ctx.currentTime + 0.4);
      this.scannerHum.connect(this.scannerGain).connect(this.master);
      this.scannerHum.start();
    }

    stopScannerHum() {
      if (!this.scannerHum) return;
      const t = this.ctx.currentTime;
      this.scannerGain.gain.linearRampToValueAtTime(0, t + 0.2);
      this.scannerHum.stop(t + 0.25);
      this.scannerHum = null;
      this.scannerGain = null;
    }
  }

  const audio = new AudioEngine();
  if (typeof module !== 'undefined' && module.exports) module.exports = audio;
  else root.Audio = audio;
})(typeof globalThis !== 'undefined' ? globalThis : this);
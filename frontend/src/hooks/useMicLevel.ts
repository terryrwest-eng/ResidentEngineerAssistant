/**
 * Daily Reporter V3 — live microphone level
 *
 * WHY: a dictation take that recorded silence is indistinguishable from a good
 * one until the AI comes back with nothing — after five minutes of talking in
 * the field. A muted headset, a browser that granted the permission but handed
 * over a dead device, a phone with the mic occupied by another app: all of them
 * look identical to a working mic while you speak into it.
 *
 * This drives a level bar so a flat line is visible NOW rather than after the
 * take is wasted, and tracks the peak so the whole recording can be judged
 * rather than just the instant the user happened to glance at the screen.
 *
 * Usage:
 *   const mic = useMicLevel();
 *   const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
 *   mic.start(stream);            // begin metering
 *   ...
 *   mic.stop();                   // on stop, and in the error path
 *   <MicLevelMeter {...mic} />
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * RMS below this counts as silence. Chosen to sit above the noise floor of a
 * live-but-quiet mic while still flagging a genuinely dead one.
 */
export const MIC_SILENCE_THRESHOLD = 0.02;

export interface UseMicLevel {
  /** Live level 0..1, updated per animation frame while a stream is attached. */
  micLevel: number;
  /** Loudest level seen since the last start(). Near zero means a dead mic. */
  peakLevel: number;
  /** True once a take has produced no sound worth speaking of. */
  isSilent: boolean;
  /**
   * Peak read straight from the ref. Use this inside MediaRecorder callbacks —
   * `onstop` closes over the render that created it, so `peakLevel` there can be
   * the value from before the take and would mis-report a silent recording.
   */
  getPeak: () => number;
  /** Start metering a recording stream. Safe to call twice. */
  start: (stream: MediaStream) => void;
  /** Tear the audio graph down and reset the live level. Safe if not started. */
  stop: () => void;
}

/**
 * @param label used only in the console warning when Web Audio is unavailable,
 *   so the failing screen is identifiable.
 */
export function useMicLevel(label = 'mic'): UseMicLevel {
  const [micLevel, setMicLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef(0);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const start = useCallback((stream: MediaStream) => {
    // Starting twice would leak the first audio graph and run two rAF loops.
    if (audioCtxRef.current) stop();

    peakRef.current = 0;
    setPeakLevel(0);

    try {
      const Ctx = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        // RMS around the 128 midpoint → rough loudness
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        setMicLevel(level);
        if (level > peakRef.current) {
          peakRef.current = level;
          setPeakLevel(level);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      // A missing meter must never block recording — the take still happens.
      console.warn(`[${label}] Level meter unavailable:`, e);
    }
  }, [label, stop]);

  // Unmounting mid-recording (navigating away, closing a dialog) would otherwise
  // leave the AudioContext open and the rAF loop running.
  useEffect(() => stop, [stop]);

  const getPeak = useCallback(() => peakRef.current, []);

  return {
    micLevel,
    peakLevel,
    isSilent: peakLevel < MIC_SILENCE_THRESHOLD,
    getPeak,
    start,
    stop,
  };
}

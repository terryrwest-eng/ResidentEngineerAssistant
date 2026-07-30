/**
 * Daily Reporter V3 — Activity Update Panel
 *
 * Upload photo/video/audio/document to UPDATE an existing activity.
 * Supports Smart Merge (AI completes/appends) vs Replace mode.
 *
 * Opens inline within ActivityEditor — NOT a modal.
 */

import { useState, useRef, useCallback } from 'react';
import { scanApi } from '@/lib/api';
import type { Activity } from '@/types';
import {
  Camera,
  Mic,
  MicOff,
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface ActivityUpdatePanelProps {
  activity: Activity;
  onApply: (updates: Partial<Activity>) => void;
  onClose: () => void;
}

export function ActivityUpdatePanel({ activity, onApply, onClose }: ActivityUpdatePanelProps) {
  const [mergeMode, setMergeMode] = useState(true); // true = Smart Merge, false = Replace
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  // File upload
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Audio recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- File handling ---
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] || null;
    setFile(selected);
    setError(null);
    setApplied(false);
    e.target.value = '';
  }

  // --- Audio recording ---
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecording(true);
      setRecordingDuration(0);
      setError(null);
      setApplied(false);

      timerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch {
      setError('Microphone access denied.');
    }
  }, []);

  const stopAndProcess = useCallback(async () => {
    if (!mediaRecorderRef.current) return;

    return new Promise<void>((resolve) => {
      mediaRecorderRef.current!.onstop = async () => {
        if (timerRef.current) clearInterval(timerRef.current);
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());

        if (blob.size < 1000) {
          setError('Recording too short.');
          resolve();
          return;
        }

        await processAudio(blob);
        resolve();
      };
      mediaRecorderRef.current!.stop();
    });
  }, []);

  // --- Process file upload ---
  async function processFile() {
    if (!file) return;
    setIsProcessing(true);
    setError(null);

    try {
      const currentData = {
        summary_html: activity.summary || '',
        manpower: activity.manpower || [],
        equipment: activity.equipment || [],
        work_area: activity.work_area || '',
      };

      const data = await scanApi.updateActivity(file, null, currentData, mergeMode);
      applyResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setIsProcessing(false);
    }
  }

  // --- Process audio ---
  async function processAudio(blob: Blob) {
    setIsProcessing(true);
    setError(null);

    try {
      const base64 = await blobToBase64(blob);
      const currentData = {
        summary_html: activity.summary || '',
        manpower: activity.manpower || [],
        equipment: activity.equipment || [],
        work_area: activity.work_area || '',
      };

      const data = await scanApi.updateActivity(null, base64, currentData, mergeMode);
      applyResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setIsProcessing(false);
    }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // --- Apply AI result to the activity ---
  function applyResult(data: Record<string, unknown>) {
    const updates: Partial<Activity> = {};

    if (data.summary_html) {
      updates.summary = String(data.summary_html);
    }

    if (Array.isArray(data.manpower) && data.manpower.length > 0) {
      updates.manpower = (data.manpower as Record<string, unknown>[]).map((r) => ({
        id: generateId(),
        trade: String(r.trade || r.name || ''),
        name: String(r.name || ''),
        qty: Number(r.qty) || 1,
        hours: Number(r.hours) || 8,
        start_time: String(r.start_time || ''),
        stop_time: String(r.stop_time || ''),
        company: String(r.company || ''),
        classification: String(r.classification || ''),
        is_3rd_party: Boolean(r.is_3rd_party),
        is_extra_work: Boolean(r.is_extra_work),
        is_consultant: Boolean(r.is_consultant),
        locked: false,
      }));
    }

    if (Array.isArray(data.equipment) && data.equipment.length > 0) {
      updates.equipment = (data.equipment as Record<string, unknown>[]).map((r) => ({
        id: generateId(),
        name: String(r.name || r.description || ''),
        description: String(r.description || ''),
        qty: Number(r.qty) || 1,
        hours: Number(r.hours) || 8,
        start_time: String(r.start_time || ''),
        stop_time: String(r.stop_time || ''),
        company: String(r.company || ''),
        is_3rd_party: Boolean(r.is_3rd_party),
        is_extra_work: Boolean(r.is_extra_work),
        is_consultant: Boolean(r.is_consultant),
        is_rental: Boolean(r.is_rental),
        locked: false,
      }));
    }

    onApply(updates);
    setApplied(true);
    console.debug('[ActivityUpdatePanel] Applied:', data.merge_strategy_used);
  }

  const formatDuration = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg)',
      marginTop: 'var(--space-md)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Camera size={16} style={{ color: 'var(--color-accent)' }} />
          <span className="font-medium" style={{ fontSize: '0.8125rem' }}>Update with Media</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          {/* Merge mode toggle */}
          <button
            onClick={() => setMergeMode(!mergeMode)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.6875rem',
              fontWeight: 500,
              color: mergeMode ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {mergeMode ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
            {mergeMode ? 'Smart Merge' : 'Replace'}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ padding: '2px' }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: 'var(--space-md)', display: 'flex', gap: 'var(--space-md)', alignItems: 'center' }}>
        {/* File upload */}
        <div style={{ flex: 1 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*,.pdf,.docx"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button
            className="btn btn-outline btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing || isRecording}
            style={{ width: '100%' }}
          >
            <Upload size={14} />
            {file ? file.name : 'Upload File'}
          </button>
        </div>

        {/* Divider */}
        <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-tertiary)' }}>or</span>

        {/* Audio record */}
        <button
          className={`btn btn-sm ${isRecording ? 'btn-danger' : 'btn-outline'}`}
          onClick={isRecording ? stopAndProcess : startRecording}
          disabled={isProcessing}
          style={{ minWidth: '90px' }}
        >
          {isRecording ? (
            <><MicOff size={14} /> {formatDuration(recordingDuration)}</>
          ) : (
            <><Mic size={14} /> Record</>
          )}
        </button>

        {/* Process file button */}
        {file && !applied && (
          <button
            className="btn btn-primary btn-sm"
            onClick={processFile}
            disabled={isProcessing}
          >
            {isProcessing ? (
              <><Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} /> Processing...</>
            ) : (
              'Analyze'
            )}
          </button>
        )}

        {/* Applied indicator */}
        {applied && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--color-success)', fontSize: '0.8125rem', fontWeight: 500 }}>
            <CheckCircle2 size={14} /> Updated
          </div>
        )}
      </div>

      {/* Processing indicator */}
      {isProcessing && !isRecording && (
        <div style={{
          padding: '0 var(--space-md) var(--space-md)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          color: 'var(--color-text-tertiary)',
          fontSize: '0.8125rem',
        }}>
          <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} />
          <span>AI is analyzing the media and {mergeMode ? 'merging' : 'replacing'} data...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          margin: '0 var(--space-md) var(--space-md)',
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--color-danger-light)',
          border: '1px solid var(--color-danger-border)',
          borderRadius: 'var(--radius-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          color: 'var(--color-danger)',
          fontSize: '0.8125rem',
        }}>
          <AlertCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Daily Reporter V3 — AI Report Assistant (Per-Activity)
 *
 * Full conversational chat panel for a single activity.
 * Uses the same /api/ai/report-chat backend as the floating Report Assistant,
 * but scoped to just this one activity.
 *
 * CAN DO:
 * - Add/modify/remove manpower and equipment
 * - Change hours, start/stop times, quantities
 * - Edit work area, stations, summary
 * - AI Rewrite — polishes rough notes into RE-quality bullets
 * - WWWW badges (Who/Where/When/What) — shows what's filled/missing
 *
 * Opens as an overlay from the ActivityEditor toolbar.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { scanApi } from '@/lib/api';
import type { Activity, ManpowerRow, EquipmentRow } from '@/types';
import { useMicLevel } from '@/hooks/useMicLevel';
import { MicLevelMeter } from '@/components/ui/MicLevelMeter';
import {
  X,
  Sparkles,
  Send,
  Loader2,
  Wand2,
  Check,
  XCircle,
  User,
  MapPin,
  Clock,
  FileText,
  Mic,
  MicOff,
} from 'lucide-react';

// --- Types ---

interface AIReportAssistantProps {
  activity: Activity;
  reportDate: string;
  onApply: (updates: Partial<Activity>) => void;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isVoice?: boolean;
  transcription?: string;
}

interface PendingChanges {
  updates: Partial<Activity>;
  description: string;
}

type WWWWStatus = {
  who: boolean;
  where: boolean;
  when: boolean;
  what: boolean;
};

// --- Constants ---

const RECORDING_MAX_MS = 120_000; // 2 minute max

function generateId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function AIReportAssistant({
  activity,
  reportDate,
  onApply,
  onClose,
}: AIReportAssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<PendingChanges | null>(null);
  const { bumpRevision } = useReportStore();

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  /** Live mic level — a flat bar means the mic isn't picking you up. */
  const mic = useMicLevel('ai-assistant');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingChanges, isLoading]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  // --- WWWW Status ---
  const wwww: WWWWStatus = {
    who: (activity.manpower?.length || 0) > 0 || (activity.equipment?.length || 0) > 0,
    where: Boolean(activity.work_area?.trim()),
    when: Boolean(reportDate),
    what: Boolean(activity.summary?.trim()) && activity.summary.trim().length > 20,
  };

  const filledCount = Object.values(wwww).filter(Boolean).length;

  // --- Build single-activity as a "report" for the report-chat endpoint ---
  const buildActivityReport = useCallback(() => {
    return {
      general: { report_date: reportDate },
      activities: [activity],
    };
  }, [activity, reportDate]);

  // --- Build chat history for multi-turn ---
  function buildChatHistory(): Record<string, string>[] {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', content: m.content }));
  }

  // --- Process AI response (shared by text and voice) ---
  function processResponse(response: {
    reply: string;
    transcription?: string;
    modified_general?: Record<string, unknown> | null;
    modified_activities?: Record<string, unknown>[] | null;
  }) {
    const aiMessages: ChatMessage[] = [];

    // Show transcription if voice
    if (response.transcription) {
      aiMessages.push({
        id: generateId(),
        role: 'assistant',
        content: response.transcription,
        transcription: response.transcription,
      });
    }

    aiMessages.push({ id: generateId(), role: 'assistant', content: response.reply });
    setMessages((prev) => [...prev, ...aiMessages]);

    // Check for modifications
    if (response.modified_activities && response.modified_activities.length > 0) {
      const modifiedActivity = response.modified_activities[0] as unknown as Activity;
      // Build the partial update from the modified activity
      const updates: Partial<Activity> = {};
      if (modifiedActivity.work_area !== undefined) updates.work_area = modifiedActivity.work_area;
      if (modifiedActivity.stations !== undefined) updates.stations = modifiedActivity.stations;
      if (modifiedActivity.summary !== undefined) updates.summary = modifiedActivity.summary;
      if (modifiedActivity.manpower) updates.manpower = modifiedActivity.manpower as ManpowerRow[];
      if (modifiedActivity.equipment) updates.equipment = modifiedActivity.equipment as EquipmentRow[];
      if (modifiedActivity.extra_work_manpower) updates.extra_work_manpower = modifiedActivity.extra_work_manpower as ManpowerRow[];
      if (modifiedActivity.extra_work_equipment) updates.extra_work_equipment = modifiedActivity.extra_work_equipment as EquipmentRow[];
      if (modifiedActivity.consultant_manpower) updates.consultant_manpower = modifiedActivity.consultant_manpower as ManpowerRow[];

      // Build a human-readable summary of what changed
      const changedFields: string[] = [];
      if (updates.summary) changedFields.push('summary');
      if (updates.work_area) changedFields.push('work area');
      if (updates.stations) changedFields.push('stations');
      if (updates.manpower) changedFields.push(`${updates.manpower.length} manpower`);
      if (updates.equipment) changedFields.push(`${updates.equipment.length} equipment`);
      if (updates.extra_work_manpower) changedFields.push('extra work manpower');
      if (updates.extra_work_equipment) changedFields.push('extra work equipment');

      setPendingChanges({
        updates,
        description: changedFields.join(', ') || 'activity data',
      });

      console.debug('[AIReportAssistant] Pending changes:', changedFields);
    }
  }

  // --- Send text message ---
  async function handleSend() {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { id: generateId(), role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const response = await scanApi.reportChat({
        message: userMessage,
        report: buildActivityReport() as Record<string, unknown>,
        chat_history: buildChatHistory(),
      });

      processResponse(response);
    } catch (error) {
      console.error('[AIReportAssistant] Send error:', error);
      setMessages((prev) => [...prev, {
        id: generateId(),
        role: 'system',
        content: 'Sorry, I hit an error. Check your connection and try again.',
      }]);
    } finally {
      setIsLoading(false);
    }
  }

  // --- Send voice message ---
  const handleSendAudio = useCallback(async (audioBlob: Blob) => {
    setIsLoading(true);
    setMessages((prev) => [...prev, {
      id: generateId(),
      role: 'user',
      content: ' Voice message',
      isVoice: true,
    }]);

    try {
      const buffer = await audioBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      console.debug(`[AIReportAssistant] Sending audio: ${audioBlob.size} bytes`);

      const response = await scanApi.reportChat({
        audio_data: base64,
        mime_type: audioBlob.type || 'audio/webm',
        report: buildActivityReport() as Record<string, unknown>,
        chat_history: buildChatHistory(),
      });

      processResponse(response);
    } catch (error) {
      console.error('[AIReportAssistant] Audio error:', error);
      setMessages((prev) => [...prev, {
        id: generateId(),
        role: 'system',
        content: 'Sorry, I had trouble processing that recording. Try again or type instead.',
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [activity, reportDate, messages]);

  // --- Recording controls ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];
      mic.start(stream);

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
        mic.stop();
        if (blob.size > 2000) {
          handleSendAudio(blob);
        } else {
          setMessages((prev) => [...prev, {
            id: generateId(),
            role: 'system',
            content: "Too short — I need at least a couple seconds. Try again!",
          }]);
        }
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => {
          if (prev >= RECORDING_MAX_MS / 1000) { stopRecording(); return prev; }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      console.error('[AIReportAssistant] Mic denied:', err);
      setMessages((prev) => [...prev, {
        id: generateId(),
        role: 'system',
        content: "Can't access your microphone. Check browser permissions.",
      }]);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setIsRecording(false);
    setRecordingDuration(0);
  };

  const toggleRecording = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  // --- AI Rewrite (summary only) ---
  async function handleRewrite() {
    if (!activity.summary?.trim()) return;
    setIsRewriting(true);
    try {
      const data = await scanApi.rewrite(activity.summary);
      const rewrittenText = data.text || data.report_text || '';
      if (rewrittenText) {
        onApply({ summary: rewrittenText });
        setMessages((prev) => [...prev, {
          id: generateId(),
          role: 'assistant',
          content: ' Summary polished and applied!',
        }]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rewrite failed';
      setMessages((prev) => [...prev, { id: generateId(), role: 'system', content: ` ${msg}` }]);
    } finally {
      setIsRewriting(false);
    }
  }

  // --- Apply / Discard ---
  function handleApplyChanges() {
    if (!pendingChanges) return;
    onApply(pendingChanges.updates);
    setPendingChanges(null);
    bumpRevision();
    setMessages((prev) => [...prev, {
      id: generateId(),
      role: 'assistant',
      content: ' Changes applied!',
    }]);
    console.debug('[AIReportAssistant] Applied changes');
  }

  function handleDiscardChanges() {
    setPendingChanges(null);
    setMessages((prev) => [...prev, {
      id: generateId(),
      role: 'assistant',
      content: 'Changes discarded. What would you like to do instead?',
    }]);
  }

  // --- Format duration ---
  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // --- Key handler ---
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // --- WWWW Badge ---
  function WWWWBadge({ label, icon, filled }: { label: string; icon: React.ReactNode; filled: boolean }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '3px 8px', borderRadius: 'var(--radius-sm)',
        fontSize: '0.6875rem', fontWeight: 600,
        background: filled ? 'var(--color-success-light)' : 'var(--color-warning-light)',
        color: filled ? 'var(--color-success)' : 'var(--color-warning)',
      }}>
        {icon}
        {label}
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0,
      width: '440px', maxWidth: '100vw',
      background: 'var(--color-surface)',
      borderLeft: '1px solid var(--color-border)',
      display: 'flex', flexDirection: 'column',
      zIndex: 1000,
      boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Sparkles size={18} style={{ color: 'var(--color-accent)' }} />
          <div>
            <span className="font-semibold" style={{ fontSize: '0.9375rem' }}>AI Assistant</span>
            <span style={{
              fontSize: '0.6875rem', marginLeft: '6px',
              color: filledCount === 4 ? 'var(--color-success)' : 'var(--color-text-tertiary)',
              fontWeight: 500,
            }}>
              {filledCount}/4
            </span>
          </div>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {/* WWWW Status Badges + Rewrite */}
      <div style={{
        display: 'flex', gap: 'var(--space-xs)',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: '1px solid var(--color-border)',
        flexWrap: 'wrap', alignItems: 'center',
      }}>
        <WWWWBadge label="Who" icon={<User size={11} />} filled={wwww.who} />
        <WWWWBadge label="Where" icon={<MapPin size={11} />} filled={wwww.where} />
        <WWWWBadge label="When" icon={<Clock size={11} />} filled={wwww.when} />
        <WWWWBadge label="What" icon={<FileText size={11} />} filled={wwww.what} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-xs)' }}>
          {activity.summary?.trim() && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleRewrite}
              disabled={isRewriting}
              style={{ fontSize: '0.6875rem', padding: '2px 8px' }}
            >
              {isRewriting ? <Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} /> : <Wand2 size={12} />}
              Rewrite
            </button>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div style={{
        flex: 1, overflowY: 'auto',
        padding: 'var(--space-md)',
        display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
        backgroundColor: 'var(--color-bg)',
      }}>
        {/* Empty state */}
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center', color: 'var(--color-text-tertiary)',
            fontSize: '0.8125rem', padding: 'var(--space-2xl) 0',
          }}>
            <Sparkles size={32} style={{ margin: '0 auto var(--space-md)', opacity: 0.3 }} />
            <p style={{ fontWeight: 500 }}>What can I help with?</p>
            <p style={{ marginTop: 'var(--space-xs)', fontSize: '0.75rem', maxWidth: '320px', margin: '4px auto 0' }}>
              I can add crew, equipment, change hours, edit the summary — anything for this activity. Talk or type.
            </p>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)',
              justifyContent: 'center', marginTop: 'var(--space-md)',
            }}>
              {[
                'Add 4 laborers for 8 hours',
                'Add a CAT 330 excavator',
                'Set all hours to 10',
                'Change work area to Station 10+00',
              ].map((hint, i) => (
                <button
                  key={i}
                  className="btn btn-outline"
                  style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap' }}
                  onClick={() => setInput(hint)}
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        {messages.map((msg) => (
          <div key={msg.id} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '88%',
          }}>
            {/* Transcription label */}
            {msg.transcription && (
              <div style={{
                fontSize: '0.65rem', color: 'var(--color-text-tertiary)',
                marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px',
              }}>
                <Mic size={9} /> What I heard:
              </div>
            )}
            <div style={{
              padding: 'var(--space-sm) var(--space-md)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.8125rem', lineHeight: 1.5,
              background: msg.role === 'user'
                ? (msg.isVoice ? 'var(--color-info)' : 'var(--color-accent)')
                : msg.role === 'system'
                  ? 'var(--color-danger-light)'
                  : (msg.transcription ? 'var(--color-info-light)' : 'var(--color-bg)'),
              color: msg.role === 'user' ? '#fff'
                : msg.role === 'system' ? 'var(--color-danger)'
                  : 'var(--color-text-primary)',
              border: msg.role !== 'user' ? '1px solid var(--color-border)' : 'none',
              whiteSpace: 'pre-wrap',
              fontStyle: msg.transcription ? 'italic' : 'normal',
            }}>
              {msg.content}
            </div>
          </div>
        ))}

        {/* Loading */}
        {isLoading && (
          <div style={{
            alignSelf: 'flex-start',
            padding: 'var(--space-sm) var(--space-md)',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            display: 'flex', gap: 'var(--space-sm)', alignItems: 'center',
            fontSize: '0.8125rem',
          }}>
            <Sparkles style={{ color: 'var(--color-accent)' }} size={14} />
            <span style={{ color: 'var(--color-text-tertiary)' }}>
              {isRecording ? 'Processing voice...' : 'Thinking...'}
            </span>
          </div>
        )}

        {/* Pending changes card */}
        {pendingChanges && (
          <div style={{
            backgroundColor: 'var(--color-surface)',
            border: '2px solid var(--color-accent)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-md)',
            marginTop: 'var(--space-xs)',
          }}>
            <h4 style={{ margin: '0 0 var(--space-xs) 0', color: 'var(--color-accent)', fontSize: '0.85rem' }}>
               Proposed Changes
            </h4>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-sm)' }}>
              {pendingChanges.description}
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <button className="btn btn-primary btn-sm" onClick={handleApplyChanges} style={{ flex: 1, fontSize: '0.8rem' }}>
                <Check size={14} /> Apply
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleDiscardChanges} style={{ flex: 1, fontSize: '0.8rem' }}>
                <XCircle size={14} /> Discard
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div style={{
        padding: 'var(--space-sm) var(--space-md)',
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-bg)',
      }}>
        {/* Recording indicator */}
        {isRecording && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 'var(--space-xs)', marginBottom: 'var(--space-sm)',
            padding: 'var(--space-xs) var(--space-sm)',
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 'var(--space-sm)',
            }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%',
                backgroundColor: 'var(--color-danger)',
                animation: 'pulse-dot 1.2s ease-in-out infinite',
              }} />
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-danger)' }}>
                Recording {formatDuration(recordingDuration)}
              </span>
            </div>
            <MicLevelMeter {...mic} />
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}>
          {/* Mic button */}
          <button
            type="button"
            onClick={toggleRecording}
            disabled={isLoading || !!pendingChanges}
            aria-label={isRecording ? 'Stop recording' : 'Start recording'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '36px', height: '36px', borderRadius: '50%',
              border: isRecording ? '2px solid var(--color-danger)' : '1px solid var(--color-border)',
              backgroundColor: isRecording ? 'rgba(239, 68, 68, 0.1)' : 'var(--color-bg)',
              color: isRecording ? 'var(--color-danger)' : 'var(--color-text-tertiary)',
              cursor: (isLoading || !!pendingChanges) ? 'not-allowed' : 'pointer',
              opacity: (isLoading || !!pendingChanges) ? 0.5 : 1,
              transition: 'all 0.2s ease',
              flexShrink: 0,
            }}
          >
            {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
          </button>

          {/* Text input */}
          <input
            ref={inputRef}
            type="text"
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRecording ? 'Recording...' : 'Add 4 laborers, change hours...'}
            disabled={isLoading || !!pendingChanges || isRecording}
            style={{ flex: 1, fontSize: '0.8125rem' }}
          />

          {/* Send button */}
          <button
            className="btn btn-primary btn-icon btn-sm"
            onClick={handleSend}
            disabled={!input.trim() || isLoading || !!pendingChanges || isRecording}
            style={{ flexShrink: 0 }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

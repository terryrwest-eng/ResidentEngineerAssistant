/**
 * Daily Reporter V3 — Report Chat (Full Report AI Assistant)
 *
 * Conversational AI overlay that can manipulate the ENTIRE report:
 *   - General info (weather, project, dates, times, notes)
 *   - Activities (create, edit, delete, move resources)
 *
 * INPUT MODES:
 *   - Text: type a message and hit Send
 *   - Voice: tap the mic button, speak, tap again to send
 *
 * AUDIO HANDLING:
 *   Two-pass on the backend: faithful transcription first (text mode),
 *   then intent processing against the report (JSON mode).
 *   If the AI can't hear you, it says so — no hallucination.
 *
 * CHANGE FLOW:
 *   AI proposes changes → user sees Apply/Discard card → changes applied to store.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { scanApi, scheduleApi } from '@/lib/api';
import { Sparkles, Send, X, Check, XCircle, Mic, MicOff, MessageSquare } from 'lucide-react';
import type { Activity, GeneralInfo, Schedule } from '@/types';

// --- Types ---

interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  /** If this was a voice message, show the transcription */
  transcription?: string;
  /** Was this message sent via voice? */
  isVoice?: boolean;
}

interface PendingChanges {
  general: Record<string, unknown> | null;
  activities: Activity[] | null;
}

// --- Constants ---

const RECORDING_MAX_MS = 120_000; // 2 minute max recording

// --- Component ---

export function ReportChat({ onClose }: { onClose: () => void }) {
  const { report, updateGeneral, replaceActivities, bumpRevision } = useReportStore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<PendingChanges | null>(null);

  // --- Voice recording state ---
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // --- Scroll to bottom ---
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);

  // --- Active schedule (for AI context) ---
  const [activeSchedule, setActiveSchedule] = useState<Schedule | null>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingChanges, isLoading]);

  // Fetch active schedule on mount
  useEffect(() => {
    scheduleApi.getActive()
      .then(data => {
        setActiveSchedule(data);
        console.debug('[ReportChat] Active schedule loaded:', data.filename, data.total_shifts, 'shifts');
      })
      .catch(() => {
        // No schedule — that's fine
        console.debug('[ReportChat] No active schedule found');
      });
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

  if (!report) return null;

  // --- Send text message ---
  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const response = await scanApi.reportChat({
        message: userMessage,
        report: {
          general: report.general,
          activities: report.activities,
          ...(activeSchedule ? { schedule: activeSchedule } : {}),
        } as Record<string, unknown>,
        chat_history: messages.map(m => ({ role: m.role, content: m.content })),
      });

      setMessages(prev => [...prev, { role: 'model', content: response.reply }]);

      if (response.modified_general || response.modified_activities) {
        setPendingChanges({
          general: response.modified_general,
          activities: response.modified_activities as Activity[] | null,
        });
      }
    } catch (error) {
      console.error('[ReportChat] Send error:', error);
      setMessages(prev => [...prev, {
        role: 'model',
        content: 'Sorry, I hit an error talking to the server. Check your connection and try again.',
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  // --- Send voice message ---
  const handleSendAudio = useCallback(async (audioBlob: Blob) => {
    setIsLoading(true);
    setMessages(prev => [...prev, {
      role: 'user',
      content: '🎤 Voice message',
      isVoice: true,
    }]);

    try {
      // Convert blob to base64
      const buffer = await audioBlob.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      console.debug(`[ReportChat] Sending audio: ${audioBlob.size} bytes, type: ${audioBlob.type}`);

      const response = await scanApi.reportChat({
        audio_data: base64,
        mime_type: audioBlob.type || 'audio/webm',
        report: {
          general: report.general,
          activities: report.activities,
          ...(activeSchedule ? { schedule: activeSchedule } : {}),
        } as Record<string, unknown>,
        chat_history: messages.map(m => ({ role: m.role, content: m.content })),
      });

      // Show what the AI heard
      const aiMessages: ChatMessage[] = [];

      if (response.transcription) {
        aiMessages.push({
          role: 'model',
          content: response.transcription,
          transcription: response.transcription,
        });
      }

      aiMessages.push({ role: 'model', content: response.reply });
      setMessages(prev => [...prev, ...aiMessages]);

      if (response.modified_general || response.modified_activities) {
        setPendingChanges({
          general: response.modified_general,
          activities: response.modified_activities as Activity[] | null,
        });
      }
    } catch (error) {
      console.error('[ReportChat] Audio send error:', error);
      setMessages(prev => [...prev, {
        role: 'model',
        content: 'Sorry, I had trouble processing that recording. Try again, or type your message instead.',
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [report, messages]);

  // --- Recording controls ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        console.debug(`[ReportChat] Recording stopped: ${blob.size} bytes`);

        // Cleanup stream
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }

        // Only send if we have meaningful audio (>2KB)
        if (blob.size > 2000) {
          handleSendAudio(blob);
        } else {
          console.warn('[ReportChat] Recording too short, discarding');
          setMessages(prev => [...prev, {
            role: 'model',
            content: "That recording was too short — I need at least a couple seconds. Try again!",
          }]);
        }
      };

      mediaRecorder.start(250); // Collect data every 250ms
      setIsRecording(true);
      setRecordingDuration(0);

      // Duration counter
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(prev => {
          if (prev >= RECORDING_MAX_MS / 1000) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);

      console.debug('[ReportChat] Recording started');
    } catch (err) {
      console.error('[ReportChat] Mic access denied:', err);
      setMessages(prev => [...prev, {
        role: 'model',
        content: "I can't access your microphone. Please allow mic permissions in your browser settings and try again.",
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
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // --- Apply / Discard changes ---
  const handleApply = () => {
    if (!pendingChanges) return;

    if (pendingChanges.general) {
      updateGeneral(pendingChanges.general as Partial<GeneralInfo>);
      console.debug('[ReportChat] Applied general info changes:', Object.keys(pendingChanges.general));
    }

    if (pendingChanges.activities) {
      replaceActivities(pendingChanges.activities);
      console.debug('[ReportChat] Applied activities changes:', pendingChanges.activities.length, 'activities');
    }

    setPendingChanges(null);
    bumpRevision();
    setMessages(prev => [...prev, { role: 'model', content: '✅ Changes applied! What else can I help with?' }]);
  };

  const handleDiscard = () => {
    setPendingChanges(null);
    setMessages(prev => [...prev, { role: 'model', content: 'Changes discarded. What would you like to do instead?' }]);
  };

  // --- Format duration ---
  const formatDuration = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // --- Count pending changes ---
  const changesSummary = (): string => {
    if (!pendingChanges) return '';
    const parts: string[] = [];
    if (pendingChanges.general) {
      const keys = Object.keys(pendingChanges.general);
      parts.push(`${keys.length} field${keys.length > 1 ? 's' : ''} in General Info`);
    }
    if (pendingChanges.activities) {
      parts.push(`${pendingChanges.activities.length} activit${pendingChanges.activities.length === 1 ? 'y' : 'ies'}`);
    }
    return parts.join(' + ');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(4px)',
    }}>
      <div className="card" style={{
        width: '92%', maxWidth: '640px', height: '85vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}>

        {/* ─── Header ─── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--surface)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <Sparkles style={{ color: 'var(--color-accent)' }} size={22} />
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', lineHeight: 1.2 }}>Report Assistant</h3>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                Voice & text • Controls entire report
              </span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close report chat">
            <X size={20} />
          </button>
        </div>

        {/* ─── Chat Area ─── */}
        <div
          ref={chatAreaRef}
          style={{
            flex: 1, overflowY: 'auto', padding: 'var(--space-md)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
            backgroundColor: 'var(--background)',
          }}
        >
          {/* Empty state */}
          {messages.length === 0 && (
            <div style={{
              textAlign: 'center', color: 'var(--text-secondary)',
              marginTop: 'var(--space-xl)', padding: '0 var(--space-md)',
            }}>
              <MessageSquare size={48} style={{ opacity: 0.15, margin: '0 auto var(--space-md)' }} />
              <p style={{ fontWeight: 600, fontSize: '1.05rem', marginBottom: 'var(--space-xs)' }}>
                How can I help with today's report?
              </p>
              <p className="text-sm" style={{ lineHeight: 1.5, maxWidth: '400px', margin: '0 auto' }}>
                Talk or type naturally. I can fill in weather, create activities, add crew and equipment — anything on the report.
              </p>
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)',
                justifyContent: 'center', marginTop: 'var(--space-md)',
              }}>
                {[
                  'It was sunny and 85°F today',
                  'We had 4 laborers at Station 10+00',
                  'Add a CAT 330 excavator for 8 hours',
                  'Set project name to Morena Pipeline',
                ].map((hint, i) => (
                  <button
                    key={i}
                    className="btn btn-outline"
                    style={{
                      fontSize: '0.75rem', padding: '4px 10px',
                      borderRadius: '999px', whiteSpace: 'nowrap',
                    }}
                    onClick={() => { setInput(hint); }}
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, idx) => (
            <div key={idx} style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
            }}>
              {/* Transcription label for voice messages */}
              {msg.transcription && (
                <div style={{
                  fontSize: '0.7rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '2px',
                  display: 'flex', alignItems: 'center', gap: '4px',
                }}>
                  <Mic size={10} /> What I heard:
                </div>
              )}
              <div style={{
                padding: 'var(--space-sm) var(--space-md)',
                borderRadius: 'var(--radius)',
                backgroundColor: msg.role === 'user'
                  ? (msg.isVoice ? 'var(--color-info)' : 'var(--color-accent)')
                  : (msg.transcription ? 'var(--color-info-light, #e8f4fd)' : 'var(--surface)'),
                color: msg.role === 'user' ? 'white' : 'var(--text)',
                border: msg.role === 'model' ? '1px solid var(--border)' : 'none',
                boxShadow: 'var(--shadow-sm)',
                lineHeight: 1.5,
                fontSize: msg.transcription ? '0.8rem' : '0.9rem',
                fontStyle: msg.transcription ? 'italic' : 'normal',
                whiteSpace: 'pre-wrap',
              }}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Loading indicator */}
          {isLoading && (
            <div style={{
              alignSelf: 'flex-start',
              padding: 'var(--space-sm) var(--space-md)',
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              display: 'flex', gap: 'var(--space-sm)', alignItems: 'center',
            }}>
              <Sparkles style={{ color: 'var(--color-accent)' }} size={16} />
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {isRecording ? 'Processing voice...' : 'Thinking...'}
              </span>
            </div>
          )}

          {/* Pending changes card */}
          {pendingChanges && (
            <div style={{
              backgroundColor: 'var(--surface)',
              border: '2px solid var(--color-accent)',
              borderRadius: 'var(--radius)',
              padding: 'var(--space-md)',
              marginTop: 'var(--space-xs)',
            }}>
              <h4 style={{ margin: '0 0 var(--space-xs) 0', color: 'var(--color-accent)', fontSize: '0.9rem' }}>
                📋 Proposed Changes
              </h4>
              <p className="text-sm" style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-sm)' }}>
                {changesSummary()}
              </p>

              {/* Show what general fields changed */}
              {pendingChanges.general && (
                <div style={{
                  fontSize: '0.75rem', backgroundColor: 'var(--background)',
                  borderRadius: 'var(--radius-sm, 4px)', padding: 'var(--space-xs) var(--space-sm)',
                  marginBottom: 'var(--space-sm)', maxHeight: '120px', overflowY: 'auto',
                }}>
                  {Object.entries(pendingChanges.general).map(([key, val]) => (
                    <div key={key} style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-secondary)', minWidth: '100px' }}>
                        {key.replace(/_/g, ' ')}:
                      </span>
                      <span>{typeof val === 'object' ? JSON.stringify(val) : String(val)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                <button className="btn btn-primary" onClick={handleApply} style={{ flex: 1, fontSize: '0.85rem' }}>
                  <Check size={16} /> Apply
                </button>
                <button className="btn btn-outline" onClick={handleDiscard} style={{ flex: 1, fontSize: '0.85rem' }}>
                  <XCircle size={16} /> Discard
                </button>
              </div>
            </div>
          )}

          <div ref={endOfMessagesRef} />
        </div>

        {/* ─── Input Area ─── */}
        <div style={{
          padding: 'var(--space-sm) var(--space-md)',
          borderTop: '1px solid var(--border)',
          backgroundColor: 'var(--surface)',
        }}>
          {/* Recording indicator */}
          {isRecording && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)',
              padding: 'var(--space-xs) var(--space-sm)',
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              borderRadius: 'var(--radius)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
            }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%',
                backgroundColor: '#ef4444',
                animation: 'pulse-dot 1.2s ease-in-out infinite',
              }} />
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#ef4444' }}>
                Recording {formatDuration(recordingDuration)}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                Tap mic to stop
              </span>
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}
          >
            {/* Mic button */}
            <button
              type="button"
              onClick={toggleRecording}
              disabled={isLoading || !!pendingChanges}
              aria-label={isRecording ? 'Stop recording' : 'Start recording'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '40px', height: '40px', borderRadius: '50%',
                border: isRecording ? '2px solid #ef4444' : '1px solid var(--border)',
                backgroundColor: isRecording ? 'rgba(239, 68, 68, 0.1)' : 'var(--background)',
                color: isRecording ? '#ef4444' : 'var(--text-secondary)',
                cursor: (isLoading || !!pendingChanges) ? 'not-allowed' : 'pointer',
                opacity: (isLoading || !!pendingChanges) ? 0.5 : 1,
                transition: 'all 0.2s ease',
                flexShrink: 0,
              }}
            >
              {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
            </button>

            {/* Text input */}
            <input
              type="text"
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isRecording ? 'Recording...' : 'Type or tap mic to speak...'}
              disabled={isLoading || !!pendingChanges || isRecording}
              style={{ flex: 1, fontSize: '0.9rem' }}
            />

            {/* Send button */}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!input.trim() || isLoading || !!pendingChanges || isRecording}
              style={{
                padding: 'var(--space-xs) var(--space-sm)',
                flexShrink: 0,
                minWidth: '40px',
              }}
            >
              <Send size={16} />
            </button>
          </form>
        </div>
      </div>

      {/* Pulse animation for recording dot */}
      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.3); }
        }
      `}</style>
    </div>
  );
}

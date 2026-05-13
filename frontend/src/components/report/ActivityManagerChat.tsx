import { useState, useRef, useEffect } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { scanApi } from '@/lib/api';
import { Sparkles, Send, X, Check, XCircle } from 'lucide-react';
import type { Activity } from '@/types';

interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

export function ActivityManagerChat({ onClose }: { onClose: () => void }) {
  const { report, replaceActivities } = useReportStore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingActivities, setPendingActivities] = useState<Activity[] | null>(null);
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingActivities]);

  if (!report) return null;

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      // Send chat history along with the new message
      const response = await scanApi.activityManagerChat(
        userMessage, 
        report.activities as unknown as Record<string, unknown>[], 
        messages as unknown as Record<string, string>[]
      );

      setMessages((prev) => [...prev, { role: 'model', content: response.reply }]);

      if (response.modified_activities) {
        setPendingActivities(response.modified_activities);
      }
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'model', content: 'Sorry, I encountered an error communicating with the server.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApply = () => {
    if (pendingActivities) {
      replaceActivities(pendingActivities);
      setPendingActivities(null);
      setMessages((prev) => [...prev, { role: 'model', content: 'Changes applied successfully! Any other requests?' }]);
    }
  };

  const handleReject = () => {
    setPendingActivities(null);
    setMessages((prev) => [...prev, { role: 'model', content: 'Changes discarded. What would you like to do instead?' }]);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(4px)'
    }}>
      <div className="card" style={{
        width: '90%', maxWidth: '600px', height: '80vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        border: '1px solid var(--border)',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-md)', borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--surface)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <Sparkles className="text-primary" size={24} />
            <h3 style={{ margin: 0 }}>Activity Manager Co-Pilot</h3>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Chat Area */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: 'var(--space-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-md)',
          backgroundColor: 'var(--background)'
        }}>
          {messages.length === 0 && (
            <div style={{
              textAlign: 'center', color: 'var(--text-secondary)',
              marginTop: 'var(--space-xl)'
            }}>
              <Sparkles size={48} style={{ opacity: 0.2, margin: '0 auto var(--space-md)' }} />
              <p>Hi! I'm your Activity Manager.</p>
              <p className="text-sm" style={{ marginTop: 'var(--space-xs)' }}>
                I can help you move resources, copy activities, merge descriptions, and more. Just ask!
              </p>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: 'var(--space-sm) var(--space-md)',
              borderRadius: 'var(--radius)',
              backgroundColor: msg.role === 'user' ? 'var(--primary)' : 'var(--surface)',
              color: msg.role === 'user' ? 'white' : 'var(--text)',
              border: msg.role === 'model' ? '1px solid var(--border)' : 'none',
              boxShadow: 'var(--shadow-sm)',
              lineHeight: 1.5
            }}>
              {msg.content}
            </div>
          ))}

          {isLoading && (
            <div style={{
              alignSelf: 'flex-start', padding: 'var(--space-sm) var(--space-md)',
              borderRadius: 'var(--radius)', backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)', display: 'flex', gap: 'var(--space-sm)',
              alignItems: 'center'
            }}>
              <Sparkles className="text-primary" size={16} />
              <span className="text-sm text-secondary">Thinking...</span>
            </div>
          )}

          {pendingActivities && (
            <div style={{
              backgroundColor: 'var(--surface)', border: '1px solid var(--primary)',
              borderRadius: 'var(--radius)', padding: 'var(--space-md)',
              marginTop: 'var(--space-sm)'
            }}>
              <h4 style={{ margin: '0 0 var(--space-sm) 0', color: 'var(--primary)' }}>Proposed Changes</h4>
              <p className="text-sm text-secondary" style={{ marginBottom: 'var(--space-md)' }}>
                I've prepared the changes to your activities. Review and apply them.
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                <button className="btn btn-primary" onClick={handleApply} style={{ flex: 1 }}>
                  <Check size={16} /> Apply Changes
                </button>
                <button className="btn btn-outline" onClick={handleReject} style={{ flex: 1 }}>
                  <XCircle size={16} /> Discard
                </button>
              </div>
            </div>
          )}
          <div ref={endOfMessagesRef} />
        </div>

        {/* Input Area */}
        <div style={{
          padding: 'var(--space-md)', borderTop: '1px solid var(--border)',
          backgroundColor: 'var(--surface)'
        }}>
          <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <input
              type="text"
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. Move John Doe from activity 1 to activity 2..."
              disabled={isLoading || !!pendingActivities}
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!input.trim() || isLoading || !!pendingActivities}
            >
              <Send size={16} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

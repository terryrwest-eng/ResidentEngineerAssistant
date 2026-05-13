/**
 * Daily Reporter V3 — Activity List
 *
 * Container for all activities in the current report.
 * Handles adding/removing activities.
 * Each activity is its own collapsible section on the page — NOT a modal.
 */

import { useState } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { ActivityEditor } from '@/components/report/ActivityEditor';
import { ActivityManagerChat } from '@/components/report/ActivityManagerChat';
import type { Activity } from '@/types';
import { Plus, ClipboardList, Sparkles } from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ActivityList() {
  const { report, addActivity, removeActivity } = useReportStore();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [isChatOpen, setIsChatOpen] = useState(false);

  if (!report) return null;

  function handleAddActivity() {
    const newActivity: Activity = {
      id: generateId(),
      work_area: '',
      stations: '',
      summary: '',
      manpower: [],
      equipment: [],
      extra_work_manpower: [],
      extra_work_equipment: [],
      consultant_manpower: [],
    };

    addActivity(newActivity);
    // Auto-expand the new activity
    setExpandedIds((prev) => new Set(prev).add(newActivity.id));
  }

  function handleRemoveActivity(activityId: string) {
    removeActivity(activityId);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.delete(activityId);
      return next;
    });
  }

  function toggleExpand(activityId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(activityId)) {
        next.delete(activityId);
      } else {
        next.add(activityId);
      }
      return next;
    });
  }

  const activities = report.activities || [];

  return (
    <div>
      {/* Section Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--space-md)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <h2 style={{ margin: 0 }}>Activities</h2>
          {activities.length > 0 && (
            <span className="badge badge-info">{activities.length}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <button className="btn btn-outline text-primary" onClick={() => setIsChatOpen(true)}>
            <Sparkles size={16} />
            AI Manager
          </button>
          <button className="btn btn-primary" onClick={handleAddActivity}>
            <Plus size={16} />
            Add Activity
          </button>
        </div>
      </div>

      {/* Empty State */}
      {activities.length === 0 && (
        <div className="card">
          <div className="card-body empty-state">
            <ClipboardList size={48} />
            <h3 style={{ marginTop: 'var(--space-md)' }}>No Activities Yet</h3>
            <p>Add an activity to start documenting today's work.</p>
            <p className="text-sm" style={{ marginTop: 'var(--space-xs)' }}>
              You can also scan a timesheet or use voice dictation to populate activities automatically.
            </p>
            <button
              className="btn btn-primary"
              onClick={handleAddActivity}
              style={{ marginTop: 'var(--space-md)' }}
            >
              <Plus size={16} />
              Add First Activity
            </button>
          </div>
        </div>
      )}

      {/* Activity Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {activities.map((activity, index) => (
          <ActivityEditor
            key={activity.id}
            activity={activity}
            index={index}
            isExpanded={expandedIds.has(activity.id)}
            onToggle={() => toggleExpand(activity.id)}
            onRemove={() => handleRemoveActivity(activity.id)}
          />
        ))}
      </div>

      {isChatOpen && <ActivityManagerChat onClose={() => setIsChatOpen(false)} />}
    </div>
  );
}

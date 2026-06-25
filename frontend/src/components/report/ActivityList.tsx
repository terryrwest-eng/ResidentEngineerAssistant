/**
 * Daily Reporter V3 — Activity List
 *
 * Container for all activities in the current report.
 * Handles adding/removing activities.
 * Each activity is its own collapsible section on the page — NOT a modal.
 *
 * AI Features:
 *   - AI Manager (Co-Pilot chat)
 *   - Bulk Dictate All Activities
 *   - Import Report (parse .docx/.pdf)
 */

import { useState, useEffect } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { ActivityEditor } from '@/components/report/ActivityEditor';
import { BulkDictateButton } from '@/components/report/BulkDictateButton';
import { ParseReportDialog } from '@/components/report/ParseReportDialog';
import { DispatchImportDialog } from '@/components/report/DispatchImportDialog';
import type { Activity } from '@/types';
import { settingsApi } from '@/lib/settingsApi';
import { Plus, ClipboardList, FileText, Truck } from 'lucide-react';

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ActivityList() {
  const { report, addActivity, removeActivity } = useReportStore();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [isParseOpen, setIsParseOpen] = useState(false);
  const [isDispatchOpen, setIsDispatchOpen] = useState(false);
  const [companyOptions, setCompanyOptions] = useState<string[]>([]);

  // Load company list from settings on mount
  useEffect(() => {
    settingsApi.get()
      .then((s) => {
        if (s.companies?.length) {
          setCompanyOptions(s.companies);
          console.debug('[ActivityList] Loaded', s.companies.length, 'companies from settings');
        }
      })
      .catch((err) => console.warn('[ActivityList] Could not load settings:', err));
  }, []);

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
        flexWrap: 'wrap',
        gap: 'var(--space-sm)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <h2 style={{ margin: 0 }}>Activities</h2>
          {activities.length > 0 && (
            <span className="badge badge-info">{activities.length}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
          <button
            className="btn btn-outline"
            onClick={() => setIsDispatchOpen(true)}
            title="Import crew from dispatch PDF"
          >
            <Truck size={16} />
            Dispatch
          </button>
          <button
            className="btn btn-outline"
            onClick={() => setIsParseOpen(true)}
            title="Import a completed report (.docx / .pdf)"
          >
            <FileText size={16} />
            Import
          </button>
          <BulkDictateButton />
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
              You can also scan a timesheet, use voice dictation, or import a completed report.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-md)', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                className="btn btn-primary"
                onClick={handleAddActivity}
              >
                <Plus size={16} />
                Add First Activity
              </button>
              <BulkDictateButton />
              <button className="btn btn-outline" onClick={() => setIsDispatchOpen(true)}>
                <Truck size={16} />
                Dispatch
              </button>
              <button className="btn btn-outline" onClick={() => setIsParseOpen(true)}>
                <FileText size={16} />
                Import Report
              </button>
            </div>
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
            companyOptions={companyOptions}
          />
        ))}
      </div>

      {isParseOpen && <ParseReportDialog onClose={() => setIsParseOpen(false)} />}
      {isDispatchOpen && <DispatchImportDialog onClose={() => setIsDispatchOpen(false)} />}
    </div>
  );
}

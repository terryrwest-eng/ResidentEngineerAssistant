/**
 * Daily Reporter V3 — Activity Editor
 *
 * A single collapsible activity section.
 * Contains: work area, summary, manpower table, equipment table.
 * Supports extra work and consultant sections.
 *
 * This is an ON-PAGE section, NOT a modal.
 * Clicking outside does nothing. You close it by collapsing it.
 */

import { useReportStore } from '@/stores/reportStore';
import { ResourceTable } from '@/components/report/ResourceTable';
import type { Activity, ManpowerRow, EquipmentRow } from '@/types';
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  HardHat,
  Truck,
  AlertTriangle,
  Users,
} from 'lucide-react';

interface ActivityEditorProps {
  activity: Activity;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
}

export function ActivityEditor({
  activity,
  index,
  isExpanded,
  onToggle,
  onRemove,
}: ActivityEditorProps) {
  const { updateActivity } = useReportStore();

  function handleChange(field: string, value: string) {
    updateActivity(activity.id, { [field]: value });
  }

  function handleManpowerChange(rows: ManpowerRow[]) {
    updateActivity(activity.id, { manpower: rows });
  }

  function handleEquipmentChange(rows: EquipmentRow[]) {
    updateActivity(activity.id, { equipment: rows });
  }

  function handleExtraWorkManpowerChange(rows: ManpowerRow[]) {
    updateActivity(activity.id, { extra_work_manpower: rows });
  }

  function handleExtraWorkEquipmentChange(rows: EquipmentRow[]) {
    updateActivity(activity.id, { extra_work_equipment: rows });
  }

  function handleConsultantManpowerChange(rows: ManpowerRow[]) {
    updateActivity(activity.id, { consultant_manpower: rows });
  }

  // Summary for collapsed view
  const mpCount = (activity.manpower?.length || 0) +
    (activity.extra_work_manpower?.length || 0) +
    (activity.consultant_manpower?.length || 0);
  const eqCount = (activity.equipment?.length || 0) +
    (activity.extra_work_equipment?.length || 0);

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: 'var(--space-md) var(--space-lg)',
          border: 'none',
          background: isExpanded ? 'var(--color-accent-light)' : 'var(--color-surface)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          transition: 'background 0.12s ease',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <span className="font-semibold" style={{ fontSize: '0.9375rem' }}>
            Activity {index + 1}
            {activity.work_area ? ` — ${activity.work_area}` : ''}
          </span>
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-md)',
          fontSize: '0.75rem',
          color: 'var(--color-text-tertiary)',
        }}>
          {mpCount > 0 && <span>{mpCount} personnel</span>}
          {eqCount > 0 && <span>{eqCount} equipment</span>}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="card-body" style={{ borderTop: '1px solid var(--color-border)' }}>
          {/* Work Area + Stations */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr',
            gap: 'var(--space-md)',
            marginBottom: 'var(--space-md)',
          }}>
            <div>
              <label className="label">Work Area</label>
              <input
                className="input"
                value={activity.work_area}
                onChange={(e) => handleChange('work_area', e.target.value)}
                placeholder="e.g. North Tunnel Portal, Morena Pipeline"
              />
            </div>
            <div>
              <label className="label">Stations</label>
              <input
                className="input"
                value={activity.stations}
                onChange={(e) => handleChange('stations', e.target.value)}
                placeholder="e.g. Sta 10+00 to 15+50"
              />
            </div>
          </div>

          {/* Summary */}
          <div style={{ marginBottom: 'var(--space-lg)' }}>
            <label className="label">Work Summary</label>
            <textarea
              className="textarea"
              value={activity.summary}
              onChange={(e) => handleChange('summary', e.target.value)}
              placeholder="Describe the work performed in this area today..."
              style={{ minHeight: '80px' }}
            />
          </div>

          {/* --- Contract Manpower --- */}
          <SectionHeader icon={<HardHat size={16} />} label="Manpower" color="var(--color-accent)" />
          <ResourceTable
            type="manpower"
            rows={activity.manpower}
            onChange={handleManpowerChange}
          />

          {/* --- Contract Equipment --- */}
          <SectionHeader icon={<Truck size={16} />} label="Equipment" color="var(--color-accent)" />
          <ResourceTable
            type="equipment"
            rows={activity.equipment}
            onChange={handleEquipmentChange}
          />

          {/* --- Extra Work Manpower --- */}
          <SectionHeader icon={<AlertTriangle size={16} />} label="Extra Work — Manpower" color="var(--color-warning)" />
          <ResourceTable
            type="manpower"
            rows={activity.extra_work_manpower}
            onChange={handleExtraWorkManpowerChange}
            isExtraWork
          />

          {/* --- Extra Work Equipment --- */}
          <SectionHeader icon={<AlertTriangle size={16} />} label="Extra Work — Equipment" color="var(--color-warning)" />
          <ResourceTable
            type="equipment"
            rows={activity.extra_work_equipment}
            onChange={handleExtraWorkEquipmentChange}
            isExtraWork
          />

          {/* --- Consultants --- */}
          <SectionHeader icon={<Users size={16} />} label="Consultants" color="#8B5CF6" />
          <ResourceTable
            type="manpower"
            rows={activity.consultant_manpower}
            onChange={handleConsultantManpowerChange}
            isConsultant
          />

          {/* Delete button */}
          <div style={{
            borderTop: '1px solid var(--color-border)',
            paddingTop: 'var(--space-md)',
            marginTop: 'var(--space-lg)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}>
            <button className="btn btn-danger btn-sm" onClick={onRemove}>
              <Trash2 size={14} />
              Remove Activity
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small colored section header within an activity */
function SectionHeader({
  icon,
  label,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  color: string;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-sm)',
      marginTop: 'var(--space-lg)',
      marginBottom: 'var(--space-sm)',
      color,
    }}>
      {icon}
      <span className="font-medium" style={{ fontSize: '0.8125rem' }}>{label}</span>
    </div>
  );
}

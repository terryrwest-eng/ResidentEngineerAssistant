/**
 * Daily Reporter V3 — General Info Form
 *
 * Project header section of a daily report.
 * Fields: project name, number, location, inspector, RE,
 *         date, times, weather, notes.
 */

import { useReportStore } from '@/stores/reportStore';
import { SKY_CONDITIONS } from '@/lib/constants';
import { Cloud, Thermometer, Wind } from 'lucide-react';

export function GeneralInfoForm() {
  const { report, updateGeneral } = useReportStore();
  if (!report) return null;

  const gen = report.general;

  function handleChange(field: string, value: string) {
    updateGeneral({ [field]: value });
  }

  function toggleSky(skyId: string) {
    const current = gen.sky_conditions || [];
    const exists = current.find((s) => s.id === skyId);
    const skyItem = SKY_CONDITIONS.find((s) => s.id === skyId);
    if (!skyItem) return;

    if (exists) {
      updateGeneral({
        sky_conditions: current.filter((s) => s.id !== skyId),
      });
    } else {
      updateGeneral({
        sky_conditions: [...current, skyItem],
      });
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 style={{ margin: 0 }}>Report Details</h3>
      </div>
      <div className="card-body">
        {/* Row 1: Project info */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
          <div>
            <label className="label">Project Name</label>
            <input
              className="input"
              value={gen.project_name}
              onChange={(e) => handleChange('project_name', e.target.value)}
              placeholder="e.g. Pure Water Program"
            />
          </div>
          <div>
            <label className="label">Project Number</label>
            <input
              className="input"
              value={gen.project_number}
              onChange={(e) => handleChange('project_number', e.target.value)}
              placeholder="e.g. K-22-1234"
            />
          </div>
        </div>

        {/* Row 2: Location + Inspector */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
          <div>
            <label className="label">Project Location</label>
            <input
              className="input"
              value={gen.project_location}
              onChange={(e) => handleChange('project_location', e.target.value)}
              placeholder="e.g. Morena Blvd, San Diego"
            />
          </div>
          <div>
            <label className="label">Inspector Name</label>
            <input
              className="input"
              value={gen.inspector_name}
              onChange={(e) => handleChange('inspector_name', e.target.value)}
              placeholder="Your name"
            />
          </div>
        </div>

        {/* Row 3: RE + Date */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
          <div>
            <label className="label">Resident Engineer</label>
            <input
              className="input"
              value={gen.resident_engineer}
              onChange={(e) => handleChange('resident_engineer', e.target.value)}
              placeholder="RE name"
            />
          </div>
          <div>
            <label className="label">Report Date</label>
            <input
              className="input"
              type="date"
              value={gen.report_date}
              onChange={(e) => handleChange('report_date', e.target.value)}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
            <div>
              <label className="label">Start Time</label>
              <input
                className="input"
                type="time"
                value={gen.start_time}
                onChange={(e) => handleChange('start_time', e.target.value)}
              />
            </div>
            <div>
              <label className="label">End Time</label>
              <input
                className="input"
                type="time"
                value={gen.end_time}
                onChange={(e) => handleChange('end_time', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Weather Section */}
        <div style={{
          background: 'var(--color-bg)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-md)',
          marginBottom: 'var(--space-md)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            marginBottom: 'var(--space-md)',
          }}>
            <Cloud size={18} style={{ color: 'var(--color-accent)' }} />
            <span className="font-medium" style={{ fontSize: '0.875rem' }}>Weather</span>
          </div>

          {/* Sky condition chips */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-sm)',
            marginBottom: 'var(--space-md)',
          }}>
            {SKY_CONDITIONS.map((sky) => {
              const isSelected = gen.sky_conditions?.some((s) => s.id === sky.id);
              return (
                <button
                  key={sky.id}
                  type="button"
                  onClick={() => toggleSky(sky.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '6px 14px',
                    borderRadius: 'var(--radius-full)',
                    border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    background: isSelected ? 'var(--color-accent-light)' : 'var(--color-surface)',
                    color: isSelected ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    fontSize: '0.8125rem',
                    fontWeight: isSelected ? 500 : 400,
                    fontFamily: 'var(--font-sans)',
                    transition: 'all 0.12s ease',
                  }}
                >
                  <span>{sky.emoji}</span>
                  <span>{sky.label}</span>
                </button>
              );
            })}
          </div>

          {/* Temp + wind */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-md)' }}>
            <div>
              <label className="label">
                <Thermometer size={12} style={{ display: 'inline', marginRight: '4px' }} />
                High (°F)
              </label>
              <input
                className="input"
                value={gen.temperature_high}
                onChange={(e) => handleChange('temperature_high', e.target.value)}
                placeholder="e.g. 85"
              />
            </div>
            <div>
              <label className="label">
                <Thermometer size={12} style={{ display: 'inline', marginRight: '4px' }} />
                Low (°F)
              </label>
              <input
                className="input"
                value={gen.temperature_low}
                onChange={(e) => handleChange('temperature_low', e.target.value)}
                placeholder="e.g. 62"
              />
            </div>
            <div>
              <label className="label">
                <Wind size={12} style={{ display: 'inline', marginRight: '4px' }} />
                Wind
              </label>
              <input
                className="input"
                value={gen.wind_info}
                onChange={(e) => handleChange('wind_info', e.target.value)}
                placeholder="e.g. 5-10 mph NW"
              />
            </div>
          </div>
        </div>

        {/* General Notes */}
        <div>
          <label className="label">General Notes</label>
          <textarea
            className="textarea"
            value={gen.notes}
            onChange={(e) => handleChange('notes', e.target.value)}
            placeholder="Site conditions, delays, visitor log, general observations..."
            style={{ minHeight: '100px' }}
          />
        </div>
      </div>
    </div>
  );
}

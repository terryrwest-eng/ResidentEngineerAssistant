/**
 * Daily Reporter V3 — General Info Form
 *
 * Project header section of a daily report.
 * Fields: project name, number, location, inspector, RE,
 * date, times, weather, notes.
 *
 * Weather auto-fill: fetches current weather from Open-Meteo API
 * using GPS geolocation or user-specified ZIP code.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useReportStore } from '@/stores/reportStore';
import { SKY_CONDITIONS } from '@/lib/constants';
import { SkyIcon } from '@/lib/skyIcons';
import { weatherApi } from '@/lib/api';
import type { WeatherData } from '@/lib/api';
import { settingsApi } from '@/lib/settingsApi';
import { Thermometer, Wind, MapPin, Loader2 } from 'lucide-react';
import { Sheet } from '@/components/ui/Sheet';

export function GeneralInfoForm() {
  const { report, updateGeneral } = useReportStore();
  const [isLoadingWeather, setIsLoadingWeather] = useState(false);
  const [weatherError, setWeatherError] = useState('');
  // Revision counter — incremented when weather auto-fill updates fields.
  // Used as a key on defaultValue inputs to force remount with new values.
  const [weatherRevision, setWeatherRevision] = useState(0);

  // Project list from settings for autocomplete suggestions
  const [projectSuggestions, setProjectSuggestions] = useState<string[]>([]);
  // Saved ZIP — lets weather resolve without asking when GPS is unavailable
  // (which is most of the time on a desktop browser).
  const [defaultZip, setDefaultZip] = useState('');
  const [askingZip, setAskingZip] = useState(false);
  const [zipDraft, setZipDraft] = useState('');

  useEffect(() => {
    settingsApi.get().then((s) => {
      if (s.projects?.length) {
        setProjectSuggestions(s.projects);
        console.debug('[GeneralInfoForm] Loaded project suggestions:', s.projects.length);
      }
      if (s.default_zip_code) {
        setDefaultZip(s.default_zip_code);
        console.debug('[GeneralInfoForm] Default ZIP loaded:', s.default_zip_code);
      }
    }).catch((err) => {
      console.warn('[GeneralInfoForm] Failed to load project suggestions:', err);
    });
  }, []);

  // IME composition tracking — prevents React from overwriting input values
  // during swipe/glide typing on Android WebView.
  const composingFieldRef = useRef<string | null>(null);

  const handleChange = useCallback((field: string, value: string) => {
    updateGeneral({ [field]: value });
  }, [updateGeneral]);

  /** onChange handler that skips store updates during IME composition */
  const handleInputChange = useCallback(
    (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (composingFieldRef.current === field) {
        // Swipe in progress — let the IME work uninterrupted
        console.debug(`[GeneralInfoForm] Composing "${field}" — skipping store update`);
        return;
      }
      updateGeneral({ [field]: e.target.value });
    },
    [updateGeneral],
  );

  const handleCompositionStart = useCallback(
    (field: string) => () => {
      composingFieldRef.current = field;
      console.debug(`[GeneralInfoForm] Composition started on "${field}"`);
    },
    [],
  );

  const handleCompositionEnd = useCallback(
    (field: string) => (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composingFieldRef.current = null;
      const finalValue = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
      console.debug(`[GeneralInfoForm] Composition ended on "${field}":`, finalValue);
      updateGeneral({ [field]: finalValue });
    },
    [updateGeneral],
  );

  if (!report) return null;

  const gen = report.general;

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

  /** Apply weather data to the form fields */
  function applyWeather(data: WeatherData) {
    const updates: Record<string, unknown> = {
      temperature_high: data.temperature_high,
      temperature_low: data.temperature_low,
      wind_info: data.wind_info,
    };

    // Auto-select the sky condition chip
    if (data.sky_condition_id) {
      const skyItem = SKY_CONDITIONS.find((s) => s.id === data.sky_condition_id);
      if (skyItem) {
        const current = gen.sky_conditions || [];
        const exists = current.find((s) => s.id === skyItem.id);
        if (!exists) {
          updates.sky_conditions = [...current, skyItem];
        }
      }
    }

    updateGeneral(updates);
    // Force temperature/wind inputs to remount with new defaultValues
    setWeatherRevision((r) => r + 1);
    console.debug('[Weather] Applied:', data);
  }

  /** Fetch weather via GPS → fallback to ZIP prompt */
  async function handleFetchWeather() {
    setIsLoadingWeather(true);
    setWeatherError('');

    try {
      // Try GPS geolocation first
      if (navigator.geolocation) {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            timeout: 8000,
            enableHighAccuracy: false,
          });
        });

        const data = await weatherApi.fetchByCoords(
          position.coords.latitude,
          position.coords.longitude,
          gen.report_date || undefined,
        );

        if (data.status === 'success') {
          applyWeather(data);
          return;
        }
      }
    } catch (geoErr) {
      console.warn('[Weather] GPS failed, trying ZIP fallback:', geoErr);
    }

    // Fallback: the ZIP saved in Settings. Only ask if there isn't one — being
    // prompted for the same ZIP on every report is the actual complaint here.
    try {
      const zip = defaultZip;

      if (!zip) {
        // No saved ZIP — ask in-app rather than with a browser prompt, and
        // remember the answer so this is the only time.
        setAskingZip(true);
        setIsLoadingWeather(false);
        return;
      }

      const data = await weatherApi.fetchByZip(zip, gen.report_date || undefined);
      if (data.status === 'success') {
        applyWeather(data);
      } else {
        setWeatherError(data.status === 'error' ? 'Weather unavailable' : 'Unknown error');
      }
    } catch (err) {
      console.error('[Weather] Fetch error:', err);
      setWeatherError('Failed to fetch weather');
    } finally {
      setIsLoadingWeather(false);
    }
  }

  /** Look up weather with a ZIP the user just typed, and remember it. */
  async function submitZip() {
    const zip = zipDraft.trim();
    if (!zip) return;

    setAskingZip(false);
    setIsLoadingWeather(true);
    setWeatherError('');

    // Save first so the next report never asks. Best-effort — a failed save
    // must not cost the weather that was just requested.
    try {
      const current = await settingsApi.get();
      await settingsApi.update({ ...current, default_zip_code: zip });
      setDefaultZip(zip);
    } catch (saveErr) {
      console.warn('[Weather] Could not save default ZIP:', saveErr);
    }

    try {
      const data = await weatherApi.fetchByZip(zip, gen.report_date || undefined);
      if (data.status === 'success') {
        applyWeather(data);
      } else {
        setWeatherError('Weather unavailable for that ZIP');
      }
    } catch (err) {
      console.error('[Weather] Fetch error:', err);
      setWeatherError('Failed to fetch weather');
    } finally {
      setIsLoadingWeather(false);
    }
  }

  return (
    <div>
      <Sheet
        open={askingZip}
        onClose={() => setAskingZip(false)}
        title="Which ZIP code?"
        subtitle="Saved to Settings — you'll only be asked once."
        icon={<MapPin size={18} />}
        closeOnEscape
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setAskingZip(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submitZip} disabled={!zipDraft.trim()}>
              Get weather
            </button>
          </>
        }
      >
        <label className="doc-field-label">Project ZIP code</label>
        <input
          className="doc-input"
          value={zipDraft}
          onChange={(e) => setZipDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitZip(); }}
          placeholder="e.g. 92122"
          inputMode="numeric"
          maxLength={10}
        />
        <p style={{ marginTop: 'var(--space-sm)', fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
          Used whenever GPS isn't available, and by the Backfill wizard for
          historical weather on past dates.
        </p>
      </Sheet>

      <div className="doc-section-head">
        <span className="doc-section-label">Report Details</span>
        <span className="doc-section-rule" aria-hidden />
      </div>
      <div>
        {/* Row 1: Project info */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
          <div>
            <label className="doc-field-label">Project Name</label>
            <input
              className="doc-input"
              type="text"
              defaultValue={gen.project_name}
              onChange={handleInputChange('project_name')}
              onCompositionStart={handleCompositionStart('project_name')}
              onCompositionEnd={handleCompositionEnd('project_name')}
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="words"
              placeholder="e.g. Pure Water Program"
              list="project-suggestions"
            />
            {projectSuggestions.length > 0 && (
              <datalist id="project-suggestions">
                {projectSuggestions.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            )}
          </div>
          <div>
            <label className="doc-field-label">Project Number</label>
            <input
              className="doc-input"
              type="text"
              defaultValue={gen.project_number}
              onChange={handleInputChange('project_number')}
              onCompositionStart={handleCompositionStart('project_number')}
              onCompositionEnd={handleCompositionEnd('project_number')}
              autoComplete="off"
              autoCorrect="off"
              placeholder="e.g. K-22-1234"
            />
          </div>
        </div>

        {/* Row 2: Location + Inspector */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
          <div>
            <label className="doc-field-label">Project Location</label>
            <input
              className="doc-input"
              type="text"
              defaultValue={gen.project_location}
              onChange={handleInputChange('project_location')}
              onCompositionStart={handleCompositionStart('project_location')}
              onCompositionEnd={handleCompositionEnd('project_location')}
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="words"
              placeholder="e.g. Morena Blvd, San Diego"
            />
          </div>
          <div>
            <label className="doc-field-label">Inspector Name</label>
            <input
              className="doc-input"
              type="text"
              defaultValue={gen.inspector_name}
              onChange={handleInputChange('inspector_name')}
              onCompositionStart={handleCompositionStart('inspector_name')}
              onCompositionEnd={handleCompositionEnd('inspector_name')}
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="words"
              placeholder="Your name"
            />
          </div>
        </div>

        {/* Row 3: RE + Date */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
          <div>
            <label className="doc-field-label">Resident Engineer</label>
            <input
              className="doc-input"
              type="text"
              defaultValue={gen.resident_engineer}
              onChange={handleInputChange('resident_engineer')}
              onCompositionStart={handleCompositionStart('resident_engineer')}
              onCompositionEnd={handleCompositionEnd('resident_engineer')}
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="words"
              placeholder="RE name"
            />
          </div>
          <div>
            <label className="doc-field-label">Report Date</label>
            <input
              className="doc-input"
              type="date"
              value={gen.report_date}
              onChange={(e) => handleChange('report_date', e.target.value)}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
            <div>
              <label className="doc-field-label">Start Time</label>
              <input
                className="doc-input"
                type="time"
                value={gen.start_time}
                onChange={(e) => handleChange('start_time', e.target.value)}
              />
            </div>
            <div>
              <label className="doc-field-label">End Time</label>
              <input
                className="doc-input"
                type="time"
                value={gen.end_time}
                onChange={(e) => handleChange('end_time', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Weather — a section of the document, not a grey box nested inside a
            white card. That container-in-a-container was the loudest thing on
            the old page and it was the least important content on it. */}
        <div style={{ marginTop: 'var(--space-xl)', marginBottom: 'var(--space-md)' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            marginBottom: 'var(--space-md)',
          }}>
            <span className="doc-section-label">Weather</span>
            <span className="doc-section-rule" aria-hidden />
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
              {weatherError && (
                <span style={{ fontSize: '0.7rem', color: 'var(--color-danger)' }}>
                  {weatherError}
                </span>
              )}
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleFetchWeather}
                disabled={isLoadingWeather}
                style={{ fontSize: '0.75rem', padding: '4px 10px' }}
              >
                {isLoadingWeather ? (
                  <>
                    <Loader2 size={12} style={{ animation: 'spin 0.6s linear infinite' }} />
                    Fetching...
                  </>
                ) : (
                  <>
                    <MapPin size={12} />
                    Fetch Weather
                  </>
                )}
              </button>
            </div>
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
                  <SkyIcon id={sky.id} />
                  <span>{sky.label}</span>
                </button>
              );
            })}
          </div>

          {/* Temp + wind */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-md)' }}>
            <div>
              <label className="doc-field-label">
                <Thermometer size={12} style={{ display: 'inline', marginRight: '4px' }} />
                High (°F)
              </label>
              <input
                key={`temp_high_${weatherRevision}`}
                className="doc-input"
                type="text"
                inputMode="numeric"
                defaultValue={gen.temperature_high}
                onChange={handleInputChange('temperature_high')}
                onCompositionStart={handleCompositionStart('temperature_high')}
                onCompositionEnd={handleCompositionEnd('temperature_high')}
                autoComplete="off"
                placeholder="e.g. 85"
              />
            </div>
            <div>
              <label className="doc-field-label">
                <Thermometer size={12} style={{ display: 'inline', marginRight: '4px' }} />
                Low (°F)
              </label>
              <input
                key={`temp_low_${weatherRevision}`}
                className="doc-input"
                type="text"
                inputMode="numeric"
                defaultValue={gen.temperature_low}
                onChange={handleInputChange('temperature_low')}
                onCompositionStart={handleCompositionStart('temperature_low')}
                onCompositionEnd={handleCompositionEnd('temperature_low')}
                autoComplete="off"
                placeholder="e.g. 62"
              />
            </div>
            <div>
              <label className="doc-field-label">
                <Wind size={12} style={{ display: 'inline', marginRight: '4px' }} />
                Wind
              </label>
              <input
                key={`wind_${weatherRevision}`}
                className="doc-input"
                type="text"
                defaultValue={gen.wind_info}
                onChange={handleInputChange('wind_info')}
                onCompositionStart={handleCompositionStart('wind_info')}
                onCompositionEnd={handleCompositionEnd('wind_info')}
                autoComplete="off"
                autoCorrect="on"
                placeholder="e.g. 5-10 mph NW"
              />
            </div>
          </div>
        </div>

        {/* General Notes */}
        <div>
          <label className="doc-field-label">General Notes</label>
          <textarea
            className="textarea"
            defaultValue={gen.notes}
            onChange={handleInputChange('notes')}
            onCompositionStart={handleCompositionStart('notes')}
            onCompositionEnd={handleCompositionEnd('notes')}
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            placeholder="Site conditions, delays, visitor log, general observations..."
            style={{ minHeight: '100px' }}
          />
        </div>
      </div>
    </div>
  );
}

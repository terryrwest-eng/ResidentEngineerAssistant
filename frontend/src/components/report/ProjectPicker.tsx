/**
 * Daily Reporter V3 — Project picker
 *
 * The first thing a new report asks, because everything downstream depends on
 * it: which sections print, which questions get asked, and which export layout
 * is used. Two jobs with two different daily reports means the project can no
 * longer be a field you fill in later.
 *
 * Weather is fetched the moment a project is chosen rather than waiting to be
 * asked for. It is the one field on the report that is only correct if it is
 * captured for the right day and place, it is the same two taps every time, and
 * it is the easiest thing in the world to forget at the end of a shift.
 */

import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Cloud, Check } from 'lucide-react';
import { interviewApi, type ProfileSummary } from '@/lib/interviewApi';

interface ProjectPickerProps {
  reportDate: string;
  /** Fallback ZIP from Settings, used when the device will not give coordinates. */
  fallbackZip?: string;
  onPicked: (profile: ProfileSummary, weather: WeatherSnapshot | null) => void;
}

export interface WeatherSnapshot {
  summary: string;
  raw: unknown;
}

type WeatherState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; snapshot: WeatherSnapshot }
  | { kind: 'failed'; reason: string };

export function ProjectPicker({ reportDate, fallbackZip, onPicked }: ProjectPickerProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ProfileSummary | null>(null);
  const [weather, setWeather] = useState<WeatherState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    interviewApi.profiles()
      .then((list) => { if (!cancelled) setProfiles(list); })
      .catch((err) => {
        console.error('[ProjectPicker] Could not load projects:', err);
        if (!cancelled) setLoadError('Could not load the project list.');
      });
    return () => { cancelled = true; };
  }, []);

  async function choose(profile: ProfileSummary) {
    setChosen(profile);
    setWeather({ kind: 'loading' });

    let snapshot: WeatherSnapshot | null = null;
    try {
      snapshot = await fetchWeather(reportDate, fallbackZip);
      setWeather({ kind: 'ok', snapshot });
    } catch (err) {
      // Weather never blocks the report. A failure is reported and the
      // interview starts anyway — a missing weather line is a gap the
      // inspector can fill, a blocked report is a shift that goes unwritten.
      const reason = err instanceof Error ? err.message : 'Weather lookup failed.';
      console.warn('[ProjectPicker] Weather unavailable:', reason);
      setWeather({ kind: 'failed', reason });
    }

    onPicked(profile, snapshot);
  }

  if (loadError) {
    return (
      <div style={wrap}>
        <AlertCircle size={18} style={{ color: 'var(--color-danger)' }} />
        <p>{loadError}</p>
      </div>
    );
  }

  if (!profiles) {
    return <div style={wrap}><Loader2 size={18} className="spin" /> Loading projects…</div>;
  }

  return (
    <div style={wrap}>
      <h2 style={{ margin: '0 0 4px', fontSize: '1.375rem' }}>Which project?</h2>
      <p style={{ margin: '0 0 var(--space-lg)', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
        This sets the report format and the questions you'll be asked.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {profiles.map((p, i) => {
          const isChosen = chosen?.key === p.key;
          return (
            <button
              key={p.key}
              className="btn"
              onClick={() => choose(p)}
              disabled={!!chosen}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: 'var(--space-md)', textAlign: 'left',
                border: `1px solid ${isChosen ? 'var(--color-success)' : 'var(--color-border)'}`,
                background: isChosen ? 'var(--color-success-light, #F0FDF4)' : 'var(--color-surface)',
                opacity: chosen && !isChosen ? 0.45 : 1,
              }}
            >
              <span style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--color-surface-active)', fontWeight: 700, fontSize: '0.8125rem',
              }}>
                {isChosen ? <Check size={14} /> : String.fromCharCode(65 + i)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600 }}>{p.project_name}</span>
                <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                  {p.title} · {p.contractor} · {p.question_count} questions
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {weather.kind !== 'idle' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginTop: 'var(--space-lg)', padding: '10px 12px',
          borderRadius: 'var(--radius-sm)', fontSize: '0.8125rem',
          background: weather.kind === 'failed'
            ? 'var(--color-warning-light, #FFFBEB)'
            : 'var(--color-surface-active)',
        }}>
          {weather.kind === 'loading' && <><Loader2 size={14} className="spin" /> Getting the weather…</>}
          {weather.kind === 'ok' && <><Cloud size={14} /> {weather.snapshot.summary}</>}
          {weather.kind === 'failed' && (
            <>
              <AlertCircle size={14} />
              <span>Weather unavailable — you can add it in the report. ({weather.reason})</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Device location first, Settings ZIP second.
 *
 * Coordinates describe where the inspector actually is, which on a linear job
 * is not the same place as the project's ZIP centroid.
 */
async function fetchWeather(reportDate: string, fallbackZip?: string): Promise<WeatherSnapshot> {
  const { weatherApi } = await import('@/lib/api');

  const coords = await new Promise<{ lat: number; lon: number } | null>((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 300_000 },
    );
  });

  const data = coords
    ? await weatherApi.fetchByCoords(coords.lat, coords.lon, reportDate)
    : fallbackZip
      ? await weatherApi.fetchByZip(fallbackZip, reportDate)
      : (() => { throw new Error('no device location and no ZIP in Settings'); })();

  const w = data as unknown as Record<string, unknown>;
  const bits = [w.temperature, w.conditions, w.summary]
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map(String);

  return { summary: bits.join(' · ') || 'Weather captured', raw: data };
}

const wrap: React.CSSProperties = {
  maxWidth: 520, margin: '0 auto', padding: 'var(--space-lg)',
};

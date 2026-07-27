/**
 * Daily Reporter V3 — Top Header Bar
 *
 * Compact header showing app name and contextual info.
 * Stays out of the way. No navigation here — that's the bottom bar's job.
 */

import { useLocation } from 'react-router-dom';
import { HardHat, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { healthApi } from '@/lib/api';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/report/new': 'New Report',
  '/history': 'Report History',
  '/tools': 'Field Tools',
  '/backfill': 'Backfill Reports',
  '/settings': 'Settings',
};

export function TopHeader() {
  const location = useLocation();
  const [connected, setConnected] = useState(true);

  // Determine page title from route
  const title = PAGE_TITLES[location.pathname]
    || (location.pathname.startsWith('/report/') ? 'Edit Report' : 'Daily Reporter');

  // Check server connectivity periodically
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    async function checkHealth() {
      try {
        await healthApi.check();
        setConnected(true);
      } catch {
        setConnected(false);
      }
    }

    checkHealth();
    interval = setInterval(checkHealth, 30000); // Check every 30s

    return () => clearInterval(interval);
  }, []);

  return (
    <header className="top-header">
      <div className="top-header-left">
        <HardHat size={22} style={{ color: 'var(--color-accent)' }} />
        <h1 className="top-header-title">{title}</h1>
      </div>

      <div className="top-header-right">
        <div
          className="top-header-status"
          title={connected ? 'Connected to server' : 'Server offline'}
        >
          {connected ? (
            <Wifi size={16} style={{ color: 'var(--color-success)' }} />
          ) : (
            <WifiOff size={16} style={{ color: 'var(--color-danger)' }} />
          )}
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * Daily Reporter V3 — Bottom Navigation Bar
 *
 * Fixed bottom tab bar for primary navigation.
 * Thumb-reachable on phones, familiar on tablets, works on desktop.
 * 5 tabs max — Dashboard, New Report, History, Tools, Settings.
 */

import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FilePlus,
  History,
  Wrench,
  Settings,
} from 'lucide-react';

interface TabItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  matchPrefix?: boolean;
}

const TABS: TabItem[] = [
  { path: '/', label: 'Home', icon: LayoutDashboard },
  { path: '/history', label: 'History', icon: History },
  { path: '/report/new', label: 'New', icon: FilePlus, matchPrefix: true },
  { path: '/tools', label: 'Tools', icon: Wrench },
  { path: '/settings', label: 'Settings', icon: Settings },
];

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  function isActive(tab: TabItem): boolean {
    if (tab.matchPrefix) {
      return location.pathname.startsWith('/report');
    }
    return location.pathname === tab.path;
  }

  return (
    <nav className="bottom-nav">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isActive(tab);
        const isCenter = tab.path === '/report/new';

        return (
          <button
            key={tab.path}
            className={`bottom-nav-item ${active ? 'active' : ''} ${isCenter ? 'center' : ''}`}
            onClick={() => navigate(tab.path)}
            aria-label={tab.label}
          >
            {isCenter ? (
              <div className="bottom-nav-fab">
                <Icon size={22} />
              </div>
            ) : (
              <>
                <Icon size={20} />
                <span className="bottom-nav-label">{tab.label}</span>
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Daily Reporter V3 — App Shell
 *
 * Bottom tab navigation + top header layout.
 * Maximizes content area on all screen sizes.
 * NO modals for data entry — everything is a page.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { BottomNav } from '@/components/layout/BottomNav';
import { TopHeader } from '@/components/layout/TopHeader';
import { DashboardPage } from '@/pages/DashboardPage';
import { NewReportPage } from '@/pages/NewReportPage';
import { ConversationPage } from '@/pages/ConversationPage';
import { ScanPage } from '@/pages/ScanPage';
import { TrackersPage } from '@/pages/TrackersPage';
import { ReportHistoryPage } from '@/pages/ReportHistoryPage';
import { ToolsPage } from '@/pages/ToolsPage';
import { BackfillPage } from '@/pages/BackfillPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UsersPage } from '@/pages/UsersPage';
import { SignInPage } from '@/pages/SignInPage';
import { AuthProvider } from '@/lib/AuthProvider';
import { useAuth } from '@/lib/authContext';
import { UIProvider } from '@/components/ui/ConfirmProvider';
import './index.css';

/**
 * Nothing renders until we know who is signed in.
 *
 * The gate is here rather than per-route so there is one place that decides,
 * and no page can be reached by typing its URL while signed out. The server
 * enforces this too — this only saves the round trip and the broken-looking
 * screen that would follow it.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', backgroundColor: 'var(--background)',
      }}>
        <div className="spinner spinner-lg" />
      </div>
    );
  }

  if (!user) return <SignInPage />;
  return <>{children}</>;
}

function AppShell() {
  return (
      <div className="app-shell">
        <TopHeader />
        <main className="app-content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/report/new" element={<NewReportPage />} />
            {/* The conversation. Writes a report only when the record can
                support one, so it never leaves a half-filled draft behind. */}
            <Route path="/report/talk" element={<ConversationPage />} />
            <Route path="/report/:id" element={<NewReportPage />} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="/trackers" element={<TrackersPage />} />
            <Route path="/history" element={<ReportHistoryPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/backfill" element={<BackfillPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <UIProvider>
        <AuthProvider>
          <AuthGate>
            <AppShell />
          </AuthGate>
        </AuthProvider>
      </UIProvider>
    </BrowserRouter>
  );
}

export default App;

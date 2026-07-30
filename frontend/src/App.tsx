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
import { ScanPage } from '@/pages/ScanPage';
import { TrackersPage } from '@/pages/TrackersPage';
import { ReportHistoryPage } from '@/pages/ReportHistoryPage';
import { ToolsPage } from '@/pages/ToolsPage';
import { BackfillPage } from '@/pages/BackfillPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UIProvider } from '@/components/ui/ConfirmProvider';
import './index.css';

function App() {
  return (
    <BrowserRouter>
      <UIProvider>
      <div className="app-shell">
        <TopHeader />
        <main className="app-content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/report/new" element={<NewReportPage />} />
            <Route path="/report/:id" element={<NewReportPage />} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="/trackers" element={<TrackersPage />} />
            <Route path="/history" element={<ReportHistoryPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/backfill" element={<BackfillPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
      </UIProvider>
    </BrowserRouter>
  );
}

export default App;

/**
 * Daily Reporter V3 — Report History Page (stub)
 * Phase 3 will implement search, filter, and full history view.
 */

import { History } from 'lucide-react';

export function ReportHistoryPage() {
  return (
    <div>
      <div className="page-header">
        <h1>Report History</h1>
        <p>Browse, search, and filter past reports</p>
      </div>

      <div className="card">
        <div className="card-body empty-state">
          <History size={48} />
          <h3 style={{ marginTop: 'var(--space-md)' }}>Report History</h3>
          <p>Phase 3 — Full history with search, date range filtering, and bulk export.</p>
        </div>
      </div>
    </div>
  );
}

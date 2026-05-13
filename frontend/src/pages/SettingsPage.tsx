/**
 * Daily Reporter V3 — Settings Page
 *
 * Tabs:
 *   Preferences  → Project defaults, default RE, default times, projects list, companies list, API key
 *   Master Lists → Manpower trades + Equipment types (used as dropdowns in report editor)
 *   Templates    → Built-in activity templates (read-only) + user custom templates (add/delete)
 *
 * WHY: All lists from the legacy app are migrated here. They feed dropdowns in the report
 *      editor (trade selector, equipment selector, company field, project field).
 */

import { useEffect, useState } from 'react';
import {
  Settings,
  Save,
  Plus,
  Trash2,
  Key,
  CheckCircle2,
  FileText,
  ListChecks,
  Building2,
  Clock,
  Loader2,
  X,
} from 'lucide-react';
import { settingsApi, type AppSettings } from '../lib/settingsApi';

// ── Types ──────────────────────────────────────────────────────────────────────

interface UserTemplate {
  id: string;
  name: string;
  body: string;
}

const BUILTIN_TEMPLATES: UserTemplate[] = [
  { id: 'excavation',      name: 'Excavation',             body: 'Excavated Sta ___ to ___. Maintained trench width and limits per plans.' },
  { id: 'pipe-install',    name: 'Pipe Installation',      body: 'Installed pipe Sta ___ to ___. Checked bedding, alignment, and joint spacing.' },
  { id: 'backfill',        name: 'Backfill / Compaction',  body: 'Backfilled Sta ___ to ___ in lifts. Compacted per spec.' },
  { id: 'concrete',        name: 'Concrete Placement',     body: 'Placed concrete at ___. Verified forms, rebar, and embeds prior to pour.' },
  { id: 'shoring',         name: 'Shoring / Trench Safety',body: 'Installed/adjusted shoring at ___ per manufacturer data.' },
  { id: 'dewatering',      name: 'Dewatering',             body: 'Dewatered trench at ___. Pumps set, discharge directed to approved location.' },
  { id: 'traffic-control', name: 'Traffic Control',        body: 'Traffic control set per approved plan. Flaggers and signs in place.' },
  { id: 'hydrotest',       name: 'Hydrostatic Test',       body: 'Hydrostatic test on segment Sta ___ to ___ at ___ psi for ___ hours.' },
  { id: 'grading',         name: 'Grading / Subgrade',     body: 'Graded subgrade at ___. Checked elevations and slopes.' },
  { id: 'cctv',            name: 'CCTV Inspection',        body: 'CCTV inspection performed Sta ___ to ___. Video recorded and submitted.' },
  { id: 'manhole',         name: 'Manhole Installation',   body: 'Manhole installed at Sta ___. Grade rings set. Frame and cover set to grade.' },
  { id: 'paving',          name: 'AC Paving',              body: 'AC paving placed at ___. Thickness ___". Compacted and checked for smoothness.' },
];

type Tab = 'preferences' | 'masterlists' | 'templates';

// ── Component ──────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('preferences');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

  // Preferences form state
  const [defaultProject, setDefaultProject]   = useState('');
  const [defaultRE, setDefaultRE]              = useState('');
  const [defaultStart, setDefaultStart]        = useState('7:00 AM');
  const [defaultStop, setDefaultStop]          = useState('3:30 PM');
  const [projects, setProjects]                = useState<string[]>([]);
  const [newProject, setNewProject]            = useState('');
  const [companies, setCompanies]              = useState<string[]>([]);
  const [newCompany, setNewCompany]            = useState('');

  // Gemini key state
  const [geminiKey, setGeminiKey]     = useState('');
  const [hasKey, setHasKey]           = useState(false);
  const [savingKey, setSavingKey]     = useState(false);

  // Master lists state
  const [manpowerList, setManpowerList]   = useState<string[]>([]);
  const [equipmentList, setEquipmentList] = useState<string[]>([]);
  const [newManpower, setNewManpower]     = useState('');
  const [newEquipment, setNewEquipment]   = useState('');

  // Templates state
  const [userTemplates, setUserTemplates]   = useState<UserTemplate[]>([]);
  const [newTplName, setNewTplName]         = useState('');
  const [newTplBody, setNewTplBody]         = useState('');

  // ── Load ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      try {
        const [s, keyStatus] = await Promise.all([
          settingsApi.get(),
          settingsApi.getKeyStatus(),
        ]);
        setSettings(s);
        setDefaultProject(s.default_project || '');
        setDefaultRE(s.default_resident_engineer || '');
        setDefaultStart(s.default_start_time || '7:00 AM');
        setDefaultStop(s.default_stop_time || '3:30 PM');
        setProjects(s.projects || []);
        setCompanies(s.companies || []);
        setManpowerList(s.master_lists?.manpower || []);
        setEquipmentList(s.master_lists?.equipment || []);
        setUserTemplates(s.user_templates || []);
        setHasKey(keyStatus.has_key);
      } catch (err) {
        showToast('Failed to load settings', 'err');
        console.error('[settings] load error', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ── Toast helper ────────────────────────────────────────────────────────────

  function showToast(msg: string, type: 'ok' | 'err') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Preferences save ────────────────────────────────────────────────────────

  async function savePreferences() {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await settingsApi.update({
        ...settings,
        default_project: defaultProject.trim(),
        default_resident_engineer: defaultRE.trim(),
        default_start_time: defaultStart.trim(),
        default_stop_time: defaultStop.trim(),
        projects,
        companies,
        master_lists: { manpower: manpowerList, equipment: equipmentList },
        user_templates: userTemplates,
      });
      setSettings(updated.settings);
      showToast('Settings saved', 'ok');
    } catch {
      showToast('Failed to save settings', 'err');
    } finally {
      setSaving(false);
    }
  }

  // ── Master Lists save ────────────────────────────────────────────────────────

  async function saveMasterLists() {
    setSaving(true);
    try {
      await settingsApi.updateMasterLists({ manpower: manpowerList, equipment: equipmentList });
      showToast('Master lists saved', 'ok');
    } catch {
      showToast('Failed to save master lists', 'err');
    } finally {
      setSaving(false);
    }
  }

  // ── Template helpers ─────────────────────────────────────────────────────────

  async function addTemplate() {
    const name = newTplName.trim();
    const body = newTplBody.trim();
    if (!name || !body) { showToast('Enter both name and text', 'err'); return; }
    try {
      const res = await settingsApi.addTemplate({ id: '', name, body });
      setUserTemplates(prev => [...prev, res.template]);
      setNewTplName('');
      setNewTplBody('');
      showToast('Template added', 'ok');
    } catch {
      showToast('Failed to add template', 'err');
    }
  }

  async function deleteTemplate(id: string) {
    try {
      await settingsApi.deleteTemplate(id);
      setUserTemplates(prev => prev.filter(t => t.id !== id));
      showToast('Template deleted', 'ok');
    } catch {
      showToast('Failed to delete template', 'err');
    }
  }

  // ── Gemini key ────────────────────────────────────────────────────────────────

  async function saveGeminiKey() {
    if (!geminiKey.trim()) { showToast('Enter your API key', 'err'); return; }
    setSavingKey(true);
    try {
      await settingsApi.saveGeminiKey(geminiKey.trim());
      setHasKey(true);
      setGeminiKey('');
      showToast('Gemini API key saved', 'ok');
    } catch {
      showToast('Failed to save API key', 'err');
    } finally {
      setSavingKey(false);
    }
  }

  // ── Tag helpers ──────────────────────────────────────────────────────────────

  function addProject() {
    const v = newProject.trim();
    if (!v) return;
    if (projects.includes(v)) { showToast('Already in list', 'err'); return; }
    setProjects(prev => [...prev, v]);
    setNewProject('');
  }

  function addCompany() {
    const v = newCompany.trim();
    if (!v) return;
    if (companies.includes(v)) { showToast('Already in list', 'err'); return; }
    setCompanies(prev => [...prev, v]);
    setNewCompany('');
  }

  function addManpower() {
    const v = newManpower.trim();
    if (!v) return;
    if (manpowerList.includes(v)) { showToast('Already in list', 'err'); return; }
    setManpowerList(prev => [...prev, v]);
    setNewManpower('');
  }

  function addEquipment() {
    const v = newEquipment.trim();
    if (!v) return;
    if (equipmentList.includes(v)) { showToast('Already in list', 'err'); return; }
    setEquipmentList(prev => [...prev, v]);
    setNewEquipment('');
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  function TagList({ items, onRemove }: { items: string[]; onRemove: (v: string) => void }) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)', minHeight: 44, padding: 'var(--space-sm)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
        {items.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>None yet</span>}
        {items.map(item => (
          <span key={item} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', background: 'var(--accent-primary)', color: '#fff', borderRadius: 20, fontSize: 12, fontWeight: 500 }}>
            {item}
            <button onClick={() => onRemove(item)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, lineHeight: 1, opacity: 0.8 }} aria-label={`Remove ${item}`}>
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    );
  }

  function AddRow({ value, onChange, onAdd, placeholder }: { value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string }) {
    return (
      <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
        <input
          className="input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ flex: 1 }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
        />
        <button className="btn btn-primary" onClick={onAdd} style={{ flexShrink: 0 }}>
          <Plus size={16} />
        </button>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 300 }}>
        <Loader2 size={32} className="spin" style={{ color: 'var(--accent-primary)' }} />
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'preferences',  label: 'Preferences',  icon: <Settings size={16} /> },
    { id: 'masterlists',  label: 'Master Lists',  icon: <ListChecks size={16} /> },
    { id: 'templates',    label: 'Templates',     icon: <FileText size={16} /> },
  ];

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          background: toast.type === 'ok' ? 'var(--success)' : 'var(--danger)',
          color: '#fff', padding: '10px 20px', borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)', fontSize: 14, fontWeight: 500,
          animation: 'fadeIn 0.2s ease',
        }}>
          {toast.msg}
        </div>
      )}

      <div className="page-header">
        <h1><Settings size={24} style={{ verticalAlign: 'middle', marginRight: 10 }} />Settings</h1>
        <p>Project defaults, master lists, and API keys</p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-lg)', borderBottom: '2px solid var(--border)', paddingBottom: 0 }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 20px', border: 'none', cursor: 'pointer',
              background: 'none', borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
              fontSize: 14, fontWeight: activeTab === t.id ? 600 : 400,
              color: activeTab === t.id ? 'var(--accent-primary)' : 'var(--text-secondary)',
              borderBottom: activeTab === t.id ? '2px solid var(--accent-primary)' : '2px solid transparent',
              marginBottom: -2, transition: 'all 0.15s',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── PREFERENCES TAB ── */}
      {activeTab === 'preferences' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>

          {/* Report Defaults */}
          <div className="card">
            <div className="card-header">
              <h3><Building2 size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />Report Defaults</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Pre-filled values on every new report. You can still change them per report.</p>
            </div>
            <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
              <div>
                <label className="label">Default Project Name</label>
                <input className="input" value={defaultProject} onChange={e => setDefaultProject(e.target.value)} placeholder="e.g., Morena Conveyance North" />
              </div>
              <div>
                <label className="label">Default Resident Engineer</label>
                <input className="input" value={defaultRE} onChange={e => setDefaultRE(e.target.value)} placeholder="e.g., John Smith" />
              </div>
            </div>
          </div>

          {/* Default Times */}
          <div className="card">
            <div className="card-header">
              <h3><Clock size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />Default Work Hours</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Default start / stop times used in bulk manpower and equipment entry.</p>
            </div>
            <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
              <div>
                <label className="label">Default Start Time</label>
                <input className="input" value={defaultStart} onChange={e => setDefaultStart(e.target.value)} placeholder="7:00 AM" />
              </div>
              <div>
                <label className="label">Default Stop Time</label>
                <input className="input" value={defaultStop} onChange={e => setDefaultStop(e.target.value)} placeholder="3:30 PM" />
              </div>
            </div>
          </div>

          {/* Projects List */}
          <div className="card">
            <div className="card-header">
              <h3>Projects List</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>These appear in the project dropdown on new reports. New projects typed on a report are auto-added here.</p>
            </div>
            <div className="card-body">
              <TagList items={projects} onRemove={v => setProjects(prev => prev.filter(p => p !== v))} />
              <AddRow value={newProject} onChange={setNewProject} onAdd={addProject} placeholder="New project name..." />
            </div>
          </div>

          {/* Companies List */}
          <div className="card">
            <div className="card-header">
              <h3>Companies List</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>These appear in the Company field on manpower and equipment rows.</p>
            </div>
            <div className="card-body">
              <TagList items={companies} onRemove={v => setCompanies(prev => prev.filter(c => c !== v))} />
              <AddRow value={newCompany} onChange={setNewCompany} onAdd={addCompany} placeholder="New company name..." />
            </div>
          </div>

          {/* Gemini API Key */}
          <div className="card">
            <div className="card-header">
              <h3><Key size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />Gemini API Key</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Required for AI scanning, dictation, and the AI assistant. Stored server-side only — never sent back to the browser.</p>
            </div>
            <div className="card-body">
              {hasKey && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--space-sm)', color: 'var(--success)', fontSize: 13 }}>
                  <CheckCircle2 size={16} /> API key is saved and active
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={geminiKey}
                  onChange={e => setGeminiKey(e.target.value)}
                  placeholder={hasKey ? '••••••••••• (replace existing)' : 'AIza...'}
                  style={{ flex: 1 }}
                  onKeyDown={e => { if (e.key === 'Enter') saveGeminiKey(); }}
                />
                <button className="btn btn-primary" onClick={saveGeminiKey} disabled={savingKey || !geminiKey.trim()}>
                  {savingKey ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                </button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>aistudio.google.com</a>. The paid tier is recommended for production use.
              </p>
            </div>
          </div>

          {/* Save button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-lg" onClick={savePreferences} disabled={saving}>
              {saving ? <><Loader2 size={16} className="spin" style={{ marginRight: 8 }} />Saving...</> : <><Save size={16} style={{ marginRight: 8 }} />Save Preferences</>}
            </button>
          </div>
        </div>
      )}

      {/* ── MASTER LISTS TAB ── */}
      {activeTab === 'masterlists' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div style={{ background: 'var(--info-bg, #eff6ff)', border: '1px solid var(--info-border, #bfdbfe)', borderRadius: 'var(--radius-md)', padding: 'var(--space-md)', fontSize: 13, color: 'var(--info-text, #1e40af)' }}>
            <strong>Master Lists</strong> populate the trade and equipment type dropdowns when adding manpower and equipment to a report activity. Add field-specific trades or equipment your crew regularly uses.
          </div>

          {/* Manpower Trades */}
          <div className="card">
            <div className="card-header">
              <h3>Manpower Trades</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Trade / classification options in the manpower row editor.</p>
            </div>
            <div className="card-body">
              <TagList items={manpowerList} onRemove={v => setManpowerList(prev => prev.filter(m => m !== v))} />
              <AddRow value={newManpower} onChange={setNewManpower} onAdd={addManpower} placeholder="e.g., Grade Checker" />
            </div>
          </div>

          {/* Equipment Types */}
          <div className="card">
            <div className="card-header">
              <h3>Equipment Types</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Equipment name options in the equipment row editor.</p>
            </div>
            <div className="card-body">
              <TagList items={equipmentList} onRemove={v => setEquipmentList(prev => prev.filter(e => e !== v))} />
              <AddRow value={newEquipment} onChange={setNewEquipment} onAdd={addEquipment} placeholder="e.g., Vacuum Excavator" />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-lg" onClick={saveMasterLists} disabled={saving}>
              {saving ? <><Loader2 size={16} className="spin" style={{ marginRight: 8 }} />Saving...</> : <><Save size={16} style={{ marginRight: 8 }} />Save Master Lists</>}
            </button>
          </div>
        </div>
      )}

      {/* ── TEMPLATES TAB ── */}
      {activeTab === 'templates' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>

          {/* Built-in templates */}
          <div className="card">
            <div className="card-header">
              <h3>Built-In Templates</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Standard construction activity templates. Always available, not editable.</p>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {BUILTIN_TEMPLATES.map(t => (
                <div key={t.id} style={{ padding: 'var(--space-sm) var(--space-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 2 }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.body}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Custom templates */}
          <div className="card">
            <div className="card-header">
              <h3>Your Custom Templates</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Saved activity text snippets. Use ___ for blanks you fill in later.</p>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              {userTemplates.length === 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No custom templates yet. Add one below.</p>
              )}
              {userTemplates.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-sm)', padding: 'var(--space-sm) var(--space-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 2 }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.body}</div>
                  </div>
                  <button className="btn btn-danger" style={{ padding: '4px 8px', flexShrink: 0 }} onClick={() => deleteTemplate(t.id)} aria-label="Delete template">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-md)' }}>
                <label className="label">Add New Template</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                  <input className="input" value={newTplName} onChange={e => setNewTplName(e.target.value)} placeholder="Template name (e.g., Vault Excavation)" />
                  <textarea
                    className="input"
                    rows={3}
                    value={newTplBody}
                    onChange={e => setNewTplBody(e.target.value)}
                    placeholder="Template text... use ___ for placeholders"
                    style={{ resize: 'vertical' }}
                  />
                  <button className="btn btn-primary" onClick={addTemplate} style={{ alignSelf: 'flex-start' }}>
                    <Plus size={16} style={{ marginRight: 6 }} /> Add Template
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

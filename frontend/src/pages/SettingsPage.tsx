/**
 * Daily Reporter V3 — Settings Page
 *
 * Tabs:
 * Preferences → Project defaults, default RE, default times, projects list, companies list, API key
 * Resource Codes → Custom labor (LL-) and equipment (LE-) codes for resource table dropdowns
 * Templates → Built-in activity templates (read-only) + user custom templates (add/delete)
 *
 * WHY: All lists from the legacy app are migrated here. They feed dropdowns in the report
 * editor (trade selector, equipment selector, company field, project field).
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
  MapPin,
  X,
  BookMarked,
  User as UserIcon,
  Users as UsersIcon,
  LogOut,
  Copy,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/authContext';
import { getToken } from '@/lib/authClient';
import {
  settingsApi,
  type AppSettings,
  type Vocabulary,
  type PreferredTerm,
  type BannedTerm,
} from '../lib/settingsApi';
import { DEFAULT_MANPOWER, DEFAULT_EQUIPMENT } from '../lib/constants';

// ── Types ──────────────────────────────────────────────────────────────────────

interface UserTemplate {
  id: string;
  name: string;
  body: string;
}

const BUILTIN_TEMPLATES: UserTemplate[] = [
  { id: 'excavation', name: 'Excavation', body: 'Excavated Sta ___ to ___. Maintained trench width and limits per plans.' },
  { id: 'pipe-install', name: 'Pipe Installation', body: 'Installed pipe Sta ___ to ___. Checked bedding, alignment, and joint spacing.' },
  { id: 'backfill', name: 'Backfill / Compaction', body: 'Backfilled Sta ___ to ___ in lifts. Compacted per spec.' },
  { id: 'concrete', name: 'Concrete Placement', body: 'Placed concrete at ___. Verified forms, rebar, and embeds prior to pour.' },
  { id: 'shoring', name: 'Shoring / Trench Safety',body: 'Installed/adjusted shoring at ___ per manufacturer data.' },
  { id: 'dewatering', name: 'Dewatering', body: 'Dewatered trench at ___. Pumps set, discharge directed to approved location.' },
  { id: 'traffic-control', name: 'Traffic Control', body: 'Traffic control set per approved plan. Flaggers and signs in place.' },
  { id: 'hydrotest', name: 'Hydrostatic Test', body: 'Hydrostatic test on segment Sta ___ to ___ at ___ psi for ___ hours.' },
  { id: 'grading', name: 'Grading / Subgrade', body: 'Graded subgrade at ___. Checked elevations and slopes.' },
  { id: 'cctv', name: 'CCTV Inspection', body: 'CCTV inspection performed Sta ___ to ___. Video recorded and submitted.' },
  { id: 'manhole', name: 'Manhole Installation', body: 'Manhole installed at Sta ___. Grade rings set. Frame and cover set to grade.' },
  { id: 'paving', name: 'AC Paving', body: 'AC paving placed at ___. Thickness ___". Compacted and checked for smoothness.' },
];

type Tab = 'preferences' | 'resourcecodes' | 'templates';

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * Who is signed in, and the way out.
 *
 * Lives here rather than in the bottom navigation, which is full at five tabs.
 * The People link only appears for administrators — it is the approval queue,
 * and it is the only way anybody else gets access.
 */
function AccountCard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  if (!user) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
      flexWrap: 'wrap', padding: 'var(--space-sm) var(--space-md)',
      marginBottom: 'var(--space-lg)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', backgroundColor: 'var(--surface)',
    }}>
      <UserIcon size={18} style={{ color: 'var(--text-secondary)' }} />
      <div style={{ flex: 1, minWidth: '150px' }}>
        <div style={{ fontWeight: 600 }}>{user.name}</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {user.email}
          {user.role === 'admin' && ' · administrator'}
        </div>
      </div>
      {/*
        The Chrome extension is a separate origin with no session of its own, so
        it needs a token pasted in. This is the only place to get one.
      */}
      <button
        className="btn btn-outline" style={{ fontSize: '0.8rem' }}
        onClick={async () => {
          const token = getToken();
          if (!token) return;
          try {
            await navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch {
            // Clipboard is blocked over plain http and in some webviews.
            window.prompt('Copy this access token for the Chrome extension:', token);
          }
        }}
      >
        <Copy size={14} /> {copied ? 'Copied' : 'Copy access token'}
      </button>
      {user.role === 'admin' && (
        <button className="btn btn-outline" style={{ fontSize: '0.8rem' }}
                onClick={() => navigate('/users')}>
          <UsersIcon size={14} /> People
        </button>
      )}
      <button className="btn btn-outline" style={{ fontSize: '0.8rem' }} onClick={signOut}>
        <LogOut size={14} /> Sign out
      </button>
    </div>
  );
}

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('preferences');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

  // Preferences form state
  const [defaultProject, setDefaultProject]   = useState('');
  const [defaultRE, setDefaultRE]              = useState('');
  const [defaultProjectNumber, setDefaultProjectNumber]     = useState('');
  const [defaultProjectLocation, setDefaultProjectLocation] = useState('');
  const [defaultInspector, setDefaultInspector]             = useState('');
  const [defaultCompany, setDefaultCompany]                 = useState('');
  const [defaultZip, setDefaultZip]                         = useState('');
  const [defaultStart, setDefaultStart]        = useState('7:00 AM');
  const [defaultStop, setDefaultStop]          = useState('3:30 PM');
  const [projects, setProjects]                = useState<string[]>([]);
  const [newProject, setNewProject]            = useState('');
  const [companies, setCompanies]              = useState<string[]>([]);
  const [newCompany, setNewCompany]            = useState('');
  // ── Vocabulary library ──────────────────────────────────────────────────────
  const [protectedTerms, setProtectedTerms]    = useState<string[]>([]);
  const [newProtected, setNewProtected]        = useState('');
  const [knownAcronyms, setKnownAcronyms]      = useState<string[]>([]);
  const [newAcronym, setNewAcronym]            = useState('');
  const [preferredTerms, setPreferredTerms]    = useState<PreferredTerm[]>([]);
  const [newWrong, setNewWrong]                = useState('');
  const [newRight, setNewRight]                = useState('');
  const [bannedTerms, setBannedTerms]          = useState<BannedTerm[]>([]);
  const [newBanned, setNewBanned]              = useState('');
  const [newBannedWhy, setNewBannedWhy]        = useState('');
  // Backfill reads its own settings keys (project_number / project_location).
  // These mirror the default_* values above so one visible field keeps both in
  // sync — see the Project Number / Project Location inputs below.
  const [projectNumber, setProjectNumber] = useState('');
  const [projectLocation, setProjectLocation] = useState('');
  const [filenamePrefix, setFilenamePrefix] = useState('');

  // Gemini key state
  const [geminiKey, setGeminiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  // Custom resource codes state
  const [customLabor, setCustomLabor] = useState<string[]>([]);
  const [customEquipment, setCustomEquipment] = useState<string[]>([]);
  const [newLaborDesc, setNewLaborDesc] = useState('');
  const [newEquipDesc, setNewEquipDesc] = useState('');

  // Templates state
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [newTplName, setNewTplName] = useState('');
  const [newTplBody, setNewTplBody] = useState('');

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
        // The default_* and bare keys mirror each other (one visible field
        // writes both), so fall back across them — settings saved before the
        // merge only populated one of the pair.
        setDefaultProjectNumber(s.default_project_number || s.project_number || '');
        setDefaultProjectLocation(s.default_project_location || s.project_location || '');
        setDefaultInspector(s.default_inspector_name || '');
        setDefaultCompany(s.default_company || '');
        setDefaultZip(s.default_zip_code || '');
        setDefaultStart(s.default_start_time || '7:00 AM');
        setDefaultStop(s.default_stop_time || '3:30 PM');
        setProjects(s.projects || []);
        setCompanies(s.companies || []);
        setProjectNumber(s.project_number || s.default_project_number || '');
        setProjectLocation(s.project_location || s.default_project_location || '');
        setFilenamePrefix(s.word_filename_prefix || '');
        setCustomLabor(s.custom_resource_codes?.labor || []);
        setCustomEquipment(s.custom_resource_codes?.equipment || []);
        setProtectedTerms(s.vocabulary?.protected_terms || []);
        setKnownAcronyms(s.vocabulary?.known_acronyms || []);
        setPreferredTerms(s.vocabulary?.preferred_terms || []);
        setBannedTerms(s.vocabulary?.banned_terms || []);
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

  // ── Vocabulary ──────────────────────────────────────────────────────────────

  /**
   * Persist the vocabulary immediately on every add/remove.
   *
   * WHY not wait for the Save button: this list is edited one word at a time,
   * usually right after the AI got a word wrong. Losing three entries because
   * the page was closed before saving would teach you not to bother using it.
   */
  function saveVocabulary(next: Partial<Vocabulary>) {
    if (!settings) return;
    const vocabulary: Vocabulary = {
      protected_terms: protectedTerms,
      known_acronyms: knownAcronyms,
      preferred_terms: preferredTerms,
      banned_terms: bannedTerms,
      ...next,
    };
    settingsApi.update({ ...settings, vocabulary })
      .then((r) => setSettings(r.settings))
      .catch(() => showToast('Failed to save vocabulary', 'err'));
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
        default_project_number: defaultProjectNumber.trim(),
        default_project_location: defaultProjectLocation.trim(),
        default_inspector_name: defaultInspector.trim(),
        default_company: defaultCompany.trim(),
        default_zip_code: defaultZip.trim(),
        default_start_time: defaultStart.trim(),
        default_stop_time: defaultStop.trim(),
        project_number: projectNumber.trim(),
        project_location: projectLocation.trim(),
        word_filename_prefix: filenamePrefix.trim(),
        projects,
        companies,
        user_templates: userTemplates,
        vocabulary: {
          protected_terms: protectedTerms,
          known_acronyms: knownAcronyms,
          preferred_terms: preferredTerms,
          banned_terms: bannedTerms,
        },
      });
      setSettings(updated.settings);
      showToast('Settings saved', 'ok');
    } catch {
      showToast('Failed to save settings', 'err');
    } finally {
      setSaving(false);
    }
  }

  // ── Custom Resource Codes save ──────────────────────────────────────────────

  async function saveResourceCodes() {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await settingsApi.update({
        ...settings,
        custom_resource_codes: { labor: customLabor, equipment: customEquipment },
      });
      setSettings(updated.settings);
      showToast('Resource codes saved', 'ok');
    } catch {
      showToast('Failed to save resource codes', 'err');
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
    const updated = [...companies, v];
    setCompanies(updated);
    setNewCompany('');
    // Auto-save to backend immediately
    if (settings) {
      settingsApi.update({ ...settings, companies: updated })
        .then(() => showToast(`"${v}" added`, 'ok'))
        .catch(() => showToast('Failed to save company', 'err'));
    }
  }

  function addCustomLabor() {
    const desc = newLaborDesc.trim();
    if (!desc) return;
    // Find next available LL- number (after hardcoded + existing custom)
    const allCodes = [...DEFAULT_MANPOWER, ...customLabor];
    let maxNum = 0;
    for (const code of allCodes) {
      const match = code.match(/^LL-(\d+)/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    const nextNum = String(maxNum + 1).padStart(2, '0');
    const newCode = `LL-${nextNum}- ${desc}`;
    if (customLabor.includes(newCode)) { showToast('Already exists', 'err'); return; }
    setCustomLabor(prev => [...prev, newCode]);
    setNewLaborDesc('');
  }

  function addCustomEquipment() {
    const desc = newEquipDesc.trim();
    if (!desc) return;
    // Find next available LE- number (after hardcoded + existing custom)
    const allCodes = [...DEFAULT_EQUIPMENT, ...customEquipment];
    let maxNum = 0;
    for (const code of allCodes) {
      const match = code.match(/^LE-(\d+)/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    const nextNum = String(maxNum + 1).padStart(2, '0');
    const newCode = `LE-${nextNum}- ${desc}`;
    if (customEquipment.includes(newCode)) { showToast('Already exists', 'err'); return; }
    setCustomEquipment(prev => [...prev, newCode]);
    setNewEquipDesc('');
  }

  // ── Render helpers are defined at module level below to avoid focus loss ──

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 300 }}>
        <Loader2 size={32} className="spin" style={{ color: 'var(--accent-primary)' }} />
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'preferences', label: 'Preferences', icon: <Settings size={16} /> },
    { id: 'resourcecodes', label: 'Resource Codes', icon: <ListChecks size={16} /> },
    { id: 'templates', label: 'Templates', icon: <FileText size={16} /> },
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

      <AccountCard />

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
              <div>
                <label className="label">Project Number</label>
                {/* Writes both settings keys: Quick Create reads
                    default_project_number, Backfill reads project_number. */}
                <input
                  className="input"
                  value={defaultProjectNumber}
                  onChange={e => { setDefaultProjectNumber(e.target.value); setProjectNumber(e.target.value); }}
                  placeholder="e.g., C-346"
                />
              </div>
              <div>
                <label className="label">Project Location</label>
                <input
                  className="input"
                  value={defaultProjectLocation}
                  onChange={e => { setDefaultProjectLocation(e.target.value); setProjectLocation(e.target.value); }}
                  placeholder="e.g., San Diego, CA"
                />
              </div>
              <div>
                <label className="label">Default Inspector</label>
                <input className="input" value={defaultInspector} onChange={e => setDefaultInspector(e.target.value)} placeholder="e.g., Jane Doe" />
              </div>
              <div>
                <label className="label">Default Company</label>
                <input className="input" value={defaultCompany} onChange={e => setDefaultCompany(e.target.value)} placeholder="e.g., OHL NA" list="default-company-opts" autoComplete="off" />
                <datalist id="default-company-opts">
                  {companies.map((c, i) => <option key={i} value={c} />)}
                </datalist>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">File name fallback</label>
                <input
                  className="input"
                  value={filenamePrefix}
                  onChange={e => setFilenamePrefix(e.target.value)}
                  placeholder="Morena Conveyance North"
                />
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                  Word files are named from the report's <strong>project name</strong>:{' '}
                  <code style={{ fontFamily: 'var(--font-mono)' }}>
                    {(defaultProject || filenamePrefix || 'Morena Conveyance North')} - Daily-TW-MM-DD-YYYY.docx
                  </code>
                  <br />
                  This box is only used for a report with no project name set.
                </p>
              </div>
              <div>
                <label className="label">
                  <MapPin size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                  Project ZIP Code
                </label>
                <input
                  className="input"
                  value={defaultZip}
                  onChange={e => setDefaultZip(e.target.value)}
                  placeholder="e.g., 92122"
                  inputMode="numeric"
                  maxLength={10}
                />
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                  Used for weather when GPS isn't available, and by the Backfill wizard to
                  look up historical weather for past dates.
                </p>
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
              <TagList items={companies} onRemove={v => {
                const updated = companies.filter(c => c !== v);
                setCompanies(updated);
                if (settings) {
                  settingsApi.update({ ...settings, companies: updated }).catch(() => {});
                }
              }} />
              <AddRow value={newCompany} onChange={setNewCompany} onAdd={addCompany} placeholder="New company name..." />
            </div>
          </div>

          {/* Vocabulary library — feeds Rewrite and Check */}
          <div className="card">
            <div className="card-header">
              <h3><BookMarked size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />Vocabulary</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                The words this project uses. Fed to both Rewrite and Check, so the AI stops
                "correcting" real field terms and writes the words you actually use.
              </p>
            </div>
            <div className="card-body">

              {/* Protected terms */}
              <label className="label">Known terms — never flagged, never reworded</label>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                Trades, equipment and companies. Anything here is treated as spelled correctly.
              </p>
              <TagList items={protectedTerms} onRemove={v => {
                const updated = protectedTerms.filter(t => t !== v);
                setProtectedTerms(updated);
                saveVocabulary({ protected_terms: updated });
              }} />
              <AddRow
                value={newProtected}
                onChange={setNewProtected}
                onAdd={() => {
                  const v = newProtected.trim();
                  if (!v || protectedTerms.includes(v)) { setNewProtected(''); return; }
                  const updated = [...protectedTerms, v].sort((a, b) => a.localeCompare(b));
                  setProtectedTerms(updated);
                  setNewProtected('');
                  saveVocabulary({ protected_terms: updated });
                }}
                placeholder="e.g. blowoff, Vactor, RJ Noble..."
              />

              {/* Known acronyms */}
              <label className="label" style={{ marginTop: 'var(--space-lg)' }}>
                Known acronyms — never spelled out
              </label>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                The reader knows these. Writing "Best Management Practice (BMP)" instead of "BMP"
                is the clearest sign a machine wrote the text.
              </p>
              <TagList items={knownAcronyms} onRemove={v => {
                const updated = knownAcronyms.filter(t => t !== v);
                setKnownAcronyms(updated);
                saveVocabulary({ known_acronyms: updated });
              }} />
              <AddRow
                value={newAcronym}
                onChange={setNewAcronym}
                onAdd={() => {
                  const v = newAcronym.trim().toUpperCase();
                  if (!v || knownAcronyms.includes(v)) { setNewAcronym(''); return; }
                  const updated = [...knownAcronyms, v];
                  setKnownAcronyms(updated);
                  setNewAcronym('');
                  saveVocabulary({ known_acronyms: updated });
                }}
                placeholder="e.g. SWPPP, CLSM, RCP..."
              />

              {/* Preferred spellings */}
              <label className="label" style={{ marginTop: 'var(--space-lg)' }}>
                House spelling — always write the second, never the first
              </label>
              {preferredTerms.length > 0 && (
                <div style={{ marginBottom: 'var(--space-sm)' }}>
                  {preferredTerms.map((p, i) => (
                    <div key={`${p.wrong}-${i}`} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 0', fontSize: 13,
                    }}>
                      <s style={{ color: 'var(--text-muted)' }}>{p.wrong}</s>
                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                      <strong style={{ flex: 1 }}>{p.right}</strong>
                      <button
                        className="btn btn-ghost btn-icon"
                        aria-label={`Remove ${p.wrong}`}
                        onClick={() => {
                          const updated = preferredTerms.filter((_, x) => x !== i);
                          setPreferredTerms(updated);
                          saveVocabulary({ preferred_terms: updated });
                        }}
                        style={{ width: 22, height: 22, padding: 0 }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
                <input
                  className="input" value={newWrong} onChange={e => setNewWrong(e.target.value)}
                  placeholder="blow-off" style={{ flex: 1 }}
                />
                <input
                  className="input" value={newRight} onChange={e => setNewRight(e.target.value)}
                  placeholder="blowoff" style={{ flex: 1 }}
                />
                <button
                  className="btn btn-primary" style={{ flexShrink: 0 }}
                  onClick={() => {
                    const w = newWrong.trim(), r = newRight.trim();
                    if (!w || !r) return;
                    const updated = [...preferredTerms, { wrong: w, right: r }];
                    setPreferredTerms(updated);
                    setNewWrong(''); setNewRight('');
                    saveVocabulary({ preferred_terms: updated });
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>

              {/* Banned terms */}
              <label className="label" style={{ marginTop: 'var(--space-lg)' }}>
                Banned words — flagged wherever they appear
              </label>
              {bannedTerms.length > 0 && (
                <div style={{ marginBottom: 'var(--space-sm)' }}>
                  {bannedTerms.map((b, i) => (
                    <div key={`${b.term}-${i}`} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 0', fontSize: 13,
                    }}>
                      <strong>{b.term}</strong>
                      {b.why && <span style={{ color: 'var(--text-muted)', flex: 1 }}>— {b.why}</span>}
                      {!b.why && <span style={{ flex: 1 }} />}
                      <button
                        className="btn btn-ghost btn-icon"
                        aria-label={`Remove ${b.term}`}
                        onClick={() => {
                          const updated = bannedTerms.filter((_, x) => x !== i);
                          setBannedTerms(updated);
                          saveVocabulary({ banned_terms: updated });
                        }}
                        style={{ width: 22, height: 22, padding: 0 }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
                <input
                  className="input" value={newBanned} onChange={e => setNewBanned(e.target.value)}
                  placeholder="Word to ban" style={{ flex: 1 }}
                />
                <input
                  className="input" value={newBannedWhy} onChange={e => setNewBannedWhy(e.target.value)}
                  placeholder="Why (optional)" style={{ flex: 1 }}
                />
                <button
                  className="btn btn-primary" style={{ flexShrink: 0 }}
                  onClick={() => {
                    const t = newBanned.trim();
                    if (!t) return;
                    const updated = [...bannedTerms, { term: t, why: newBannedWhy.trim() }];
                    setBannedTerms(updated);
                    setNewBanned(''); setNewBannedWhy('');
                    saveVocabulary({ banned_terms: updated });
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
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

      {/* ── RESOURCE CODES TAB ── */}
      {activeTab === 'resourcecodes' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div style={{ background: 'var(--color-info-light)', border: '1px solid var(--color-info-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-md)', fontSize: 13, color: 'var(--color-info)' }}>
            <strong>Custom Resource Codes</strong> are added to the resource table dropdowns alongside the built-in PMWeb codes. Enter a description and the next available code number will be auto-assigned.
          </div>

          {/* Custom Labor Codes */}
          <div className="card">
            <div className="card-header">
              <h3>Custom Labor Codes</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Added to the manpower resource dropdown (LL- codes). {DEFAULT_MANPOWER.length} built-in + {customLabor.length} custom.</p>
            </div>
            <div className="card-body">
              {customLabor.length === 0 && (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 'var(--space-sm)' }}>No custom labor codes added yet.</p>
              )}
              <TagList items={customLabor} onRemove={v => setCustomLabor(prev => prev.filter(c => c !== v))} />
              <AddRow value={newLaborDesc} onChange={setNewLaborDesc} onAdd={addCustomLabor} placeholder="e.g., Grade Checker" />
            </div>
          </div>

          {/* Custom Equipment Codes */}
          <div className="card">
            <div className="card-header">
              <h3>Custom Equipment Codes</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Added to the equipment resource dropdown (LE- codes). {DEFAULT_EQUIPMENT.length} built-in + {customEquipment.length} custom.</p>
            </div>
            <div className="card-body">
              {customEquipment.length === 0 && (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 'var(--space-sm)' }}>No custom equipment codes added yet.</p>
              )}
              <TagList items={customEquipment} onRemove={v => setCustomEquipment(prev => prev.filter(c => c !== v))} />
              <AddRow value={newEquipDesc} onChange={setNewEquipDesc} onAdd={addCustomEquipment} placeholder="e.g., Vacuum Excavator" />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-lg" onClick={saveResourceCodes} disabled={saving}>
              {saving ? <><Loader2 size={16} className="spin" style={{ marginRight: 8 }} />Saving...</> : <><Save size={16} style={{ marginRight: 8 }} />Save Resource Codes</>}
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

// ── Module-level render helpers (stable identity, no focus loss) ──────────────

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

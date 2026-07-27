/**
 * Daily Reporter V3 — Tools Page
 *
 * Field calculator tools — all computed client-side, no backend call needed.
 *
 * Tools:
 *   1. Pipe Water Volume Calculator (linear feet → gallons)
 *   2. Excavation Volume Calculator (L×W×D → CY)
 *   3. Unit Converter (feet↔inches, LF↔CY, °F↔°C)
 *   4. Concrete Calculator (volume → bags or yards)
 *
 * UX: Tab-based. All results appear inline immediately.
 * No forms that disappear when you tap outside.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { pdfApi } from '@/lib/api';
import type { PdfDocument } from '@/lib/api';

import {
  Droplets,
  Shovel,
  ArrowLeftRight,
  Box,

  Calculator,
  CalendarClock,
  ChevronRight,
  Search,
  Upload,
  Trash2,
  FileText,
  Send,
  Loader2,
} from 'lucide-react';

type ToolTab = 'pipe' | 'excavation' | 'converter' | 'concrete' | 'pdf';

export function ToolsPage() {
  const [activeTab, setActiveTab] = useState<ToolTab>('pipe');
  const navigate = useNavigate();

  const tabs: { id: ToolTab; label: string; icon: React.ReactNode }[] = [
    { id: 'pipe', label: 'Pipe Volume', icon: <Droplets size={18} /> },
    { id: 'excavation', label: 'Excavation', icon: <Shovel size={18} /> },
    { id: 'converter', label: 'Converter', icon: <ArrowLeftRight size={18} /> },
    { id: 'concrete', label: 'Concrete', icon: <Box size={18} /> },
    { id: 'pdf', label: 'PDF Search', icon: <Search size={18} /> },
  ];

  return (
    <div>
      <div style={{ marginBottom: 'var(--space-lg)' }}>
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Calculator size={24} style={{ color: 'var(--color-accent)' }} />
          Field Tools
        </h1>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-tertiary)', fontSize: '0.875rem' }}>
          Construction calculators — results update instantly
        </p>
      </div>

      {/* Backfill lives on its own page — it is a workflow, not a calculator */}
      <button
        onClick={() => navigate('/backfill')}
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-md)',
          width: '100%',
          padding: 'var(--space-md)',
          marginBottom: 'var(--space-lg)',
          textAlign: 'left',
          cursor: 'pointer',
          border: '1px solid var(--color-border)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <CalendarClock size={22} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Backfill Reports</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
            Rebuild missed days from scanned contractor timesheets
          </div>
        </div>
        <ChevronRight size={18} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
      </button>

      {/* Tool tabs */}
      <div style={{
        display: 'flex',
        gap: 'var(--space-xs)',
        marginBottom: 'var(--space-lg)',
        overflowX: 'auto',
        paddingBottom: '2px',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-xs)',
              padding: '10px 20px',
              border: `2px solid ${activeTab === tab.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-full)',
              background: activeTab === tab.id ? 'var(--color-accent)' : 'var(--color-surface)',
              color: activeTab === tab.id ? '#fff' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              fontWeight: activeTab === tab.id ? 600 : 400,
              fontSize: '0.875rem',
              whiteSpace: 'nowrap',
              transition: 'all 0.12s ease',
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active tool */}
      {activeTab === 'pipe' && <PipeVolumeCalculator />}
      {activeTab === 'excavation' && <ExcavationCalculator />}
      {activeTab === 'converter' && <UnitConverter />}
      {activeTab === 'concrete' && <ConcreteCalculator />}
      {activeTab === 'pdf' && <PDFSearchTool />}
    </div>
  );
}


// ============================================
// TOOL 1: Pipe Water Volume Calculator
// ============================================

function PipeVolumeCalculator() {
  const [diameter, setDiameter] = useState('');
  const [length, setLength] = useState('');

  const d = parseFloat(diameter);
  const l = parseFloat(length);

  let gallons = 0;
  let cubicFeet = 0;
  let cubicYards = 0;

  if (d > 0 && l > 0) {
    const radiusInches = d / 2;
    const radiusFt = radiusInches / 12;
    cubicFeet = Math.PI * radiusFt * radiusFt * l;
    gallons = cubicFeet * 7.48052;
    cubicYards = cubicFeet / 27;
  }

  const hasResult = gallons > 0;

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Droplets size={20} style={{ color: 'var(--color-accent)' }} />
          <h3 style={{ margin: 0 }}>Pipe Water Volume</h3>
        </div>
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
          Calculates fill volume for flushing &amp; testing
        </span>
      </div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
          <div>
            <label className="label">Inside Diameter (inches)</label>
            <input
              className="input"
              type="number"
              min="0"
              step="0.5"
              value={diameter}
              onChange={(e) => setDiameter(e.target.value)}
              placeholder="e.g. 12"
            />
          </div>
          <div>
            <label className="label">Length (feet)</label>
            <input
              className="input"
              type="number"
              min="0"
              value={length}
              onChange={(e) => setLength(e.target.value)}
              placeholder="e.g. 500"
            />
          </div>
        </div>

        {hasResult ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 'var(--space-md)',
          }}>
            <ResultCard label="Gallons" value={gallons.toLocaleString('en-US', { maximumFractionDigits: 0 })} accent />
            <ResultCard label="Cubic Feet" value={cubicFeet.toFixed(1)} />
            <ResultCard label="Cubic Yards" value={cubicYards.toFixed(2)} />
          </div>
        ) : (
          <div style={{
            padding: 'var(--space-xl)',
            textAlign: 'center',
            color: 'var(--color-text-tertiary)',
            fontSize: '0.875rem',
          }}>
            Enter diameter and length above to see results
          </div>
        )}

        {/* Formula note */}
        <p style={{
          marginTop: 'var(--space-md)',
          fontSize: '0.75rem',
          color: 'var(--color-text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}>
          Formula: π × (D/2)² × L × 7.48 gal/ft³
        </p>
      </div>
    </div>
  );
}


// ============================================
// TOOL 2: Excavation Volume Calculator
// ============================================

type ExcavShape = 'trench' | 'rectangular' | 'conical';

function ExcavationCalculator() {
  const [shape, setShape] = useState<ExcavShape>('trench');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [depth, setDepth] = useState('');
  const [swell, setSwell] = useState('25'); // % swell factor default

  const l = parseFloat(length);
  const w = parseFloat(width);
  const d = parseFloat(depth);
  const swellPct = parseFloat(swell) || 0;

  let bankCY = 0; // Bank Measure (in-place)
  if (l > 0 && w > 0 && d > 0) {
    if (shape === 'trench' || shape === 'rectangular') {
      bankCY = (l * w * d) / 27;
    } else if (shape === 'conical') {
      // Cone: V = π/3 × r² × h
      const r = w / 2;
      bankCY = ((Math.PI / 3) * r * r * d) / 27;
    }
  }

  const looseCY = bankCY * (1 + swellPct / 100);
  const truckLoads = looseCY / 14; // ~14 CY per super 10 truck

  const hasResult = bankCY > 0;

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Shovel size={20} style={{ color: 'var(--color-accent)' }} />
          <h3 style={{ margin: 0 }}>Excavation Volume</h3>
        </div>
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
          Bank CY, loose CY, and truck load estimates
        </span>
      </div>
      <div className="card-body">
        {/* Shape selector */}
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
          {(['trench', 'rectangular', 'conical'] as ExcavShape[]).map((s) => (
            <button
              key={s}
              onClick={() => setShape(s)}
              className={`btn btn-sm ${shape === s ? 'btn-primary' : 'btn-secondary'}`}
              style={{ textTransform: 'capitalize' }}
            >
              {s}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
          <div>
            <label className="label">Length (ft)</label>
            <input className="input" type="number" min="0" value={length} onChange={(e) => setLength(e.target.value)} placeholder="e.g. 100" />
          </div>
          <div>
            <label className="label">{shape === 'conical' ? 'Diameter (ft)' : 'Width (ft)'}</label>
            <input className="input" type="number" min="0" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="e.g. 4" />
          </div>
          <div>
            <label className="label">Depth (ft)</label>
            <input className="input" type="number" min="0" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="e.g. 6" />
          </div>
          <div>
            <label className="label">Swell % </label>
            <input className="input" type="number" min="0" max="100" value={swell} onChange={(e) => setSwell(e.target.value)} placeholder="25" />
          </div>
        </div>

        {hasResult ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-md)' }}>
            <ResultCard label="Bank CY (In-Place)" value={bankCY.toFixed(1)} accent />
            <ResultCard label="Loose CY (Truck)" value={looseCY.toFixed(1)} />
            <ResultCard label="Truck Loads (14 CY)" value={truckLoads.toFixed(1)} />
          </div>
        ) : (
          <div style={{ padding: 'var(--space-xl)', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: '0.875rem' }}>
            Enter dimensions above to see results
          </div>
        )}

        <p style={{ marginTop: 'var(--space-md)', fontSize: '0.75rem', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          Bank CY = L × W × D / 27 | Loose = Bank × (1 + Swell%)
        </p>
      </div>
    </div>
  );
}


// ============================================
// TOOL 3: Unit Converter
// ============================================

type ConversionGroup = {
  label: string;
  units: { from: string; to: string; factor: number; label: string }[];
};

const CONVERSION_GROUPS: ConversionGroup[] = [
  {
    label: 'Length',
    units: [
      { from: 'ft', to: 'in', factor: 12, label: 'Feet → Inches' },
      { from: 'in', to: 'ft', factor: 1 / 12, label: 'Inches → Feet' },
      { from: 'ft', to: 'm', factor: 0.3048, label: 'Feet → Meters' },
      { from: 'm', to: 'ft', factor: 1 / 0.3048, label: 'Meters → Feet' },
      { from: 'mi', to: 'ft', factor: 5280, label: 'Miles → Feet' },
    ],
  },
  {
    label: 'Volume',
    units: [
      { from: 'gal', to: 'cf', factor: 1 / 7.48052, label: 'Gallons → Cubic Feet' },
      { from: 'cf', to: 'gal', factor: 7.48052, label: 'Cubic Feet → Gallons' },
      { from: 'cf', to: 'cy', factor: 1 / 27, label: 'Cubic Feet → Cubic Yards' },
      { from: 'cy', to: 'cf', factor: 27, label: 'Cubic Yards → Cubic Feet' },
      { from: 'gal', to: 'liter', factor: 3.78541, label: 'Gallons → Liters' },
    ],
  },
  {
    label: 'Temperature',
    units: [
      { from: 'F', to: 'C', factor: 0, label: '°F → °C' }, // handled specially
      { from: 'C', to: 'F', factor: 0, label: '°C → °F' }, // handled specially
    ],
  },
  {
    label: 'Pressure',
    units: [
      { from: 'psi', to: 'bar', factor: 0.0689476, label: 'PSI → Bar' },
      { from: 'bar', to: 'psi', factor: 14.5038, label: 'Bar → PSI' },
      { from: 'psi', to: 'kpa', factor: 6.89476, label: 'PSI → kPa' },
    ],
  },
  {
    label: 'Weight',
    units: [
      { from: 'lb', to: 'ton', factor: 1 / 2000, label: 'Pounds → Tons (short)' },
      { from: 'ton', to: 'lb', factor: 2000, label: 'Tons → Pounds' },
      { from: 'lb', to: 'kg', factor: 0.453592, label: 'Pounds → kg' },
      { from: 'kg', to: 'lb', factor: 2.20462, label: 'kg → Pounds' },
    ],
  },
];

function UnitConverter() {
  const [groupIdx, setGroupIdx] = useState(0);
  const [unitIdx, setUnitIdx] = useState(0);
  const [inputVal, setInputVal] = useState('');

  const group = CONVERSION_GROUPS[groupIdx];
  const unit = group.units[unitIdx];
  const val = parseFloat(inputVal);

  function convert(v: number, u: typeof unit): number | null {
    if (isNaN(v)) return null;
    // Temperature special cases
    if (u.from === 'F' && u.to === 'C') return (v - 32) * (5 / 9);
    if (u.from === 'C' && u.to === 'F') return (v * 9) / 5 + 32;
    return v * u.factor;
  }

  const result = convert(val, unit);

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <ArrowLeftRight size={20} style={{ color: 'var(--color-accent)' }} />
          <h3 style={{ margin: 0 }}>Unit Converter</h3>
        </div>
      </div>
      <div className="card-body">
        {/* Category */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)' }}>
          {CONVERSION_GROUPS.map((g, gi) => (
            <button
              key={gi}
              onClick={() => { setGroupIdx(gi); setUnitIdx(0); setInputVal(''); }}
              className={`btn btn-sm ${gi === groupIdx ? 'btn-primary' : 'btn-ghost'}`}
            >
              {g.label}
            </button>
          ))}
        </div>

        {/* Unit type */}
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <label className="label">Conversion</label>
          <select
            className="input"
            value={unitIdx}
            onChange={(e) => { setUnitIdx(Number(e.target.value)); setInputVal(''); }}
          >
            {group.units.map((u, ui) => (
              <option key={ui} value={ui}>{u.label}</option>
            ))}
          </select>
        </div>

        {/* Input */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 'var(--space-md)' }}>
          <div>
            <label className="label">Enter {unit.from.toUpperCase()}</label>
            <input
              className="input"
              type="number"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder="Enter value..."
              style={{ fontSize: '1.25rem', fontWeight: 600, textAlign: 'center' }}
            />
          </div>
          <div style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
            <ArrowLeftRight size={20} />
          </div>
          <div>
            <label className="label">Result {unit.to.toUpperCase()}</label>
            <div style={{
              padding: 'var(--space-sm) var(--space-md)',
              background: result !== null ? 'var(--color-accent-light)' : 'var(--color-bg)',
              border: `1px solid ${result !== null ? 'var(--color-accent)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius-md)',
              fontSize: '1.25rem',
              fontWeight: 700,
              color: result !== null ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
              textAlign: 'center',
              minHeight: '48px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              {result !== null ? result.toFixed(4).replace(/\.?0+$/, '') : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


// ============================================
// TOOL 4: Concrete Calculator
// ============================================

type ConcreteInput = 'volume' | 'dimensions';

function ConcreteCalculator() {
  const [inputMode, setInputMode] = useState<ConcreteInput>('dimensions');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [depth, setDepth] = useState(''); // in inches
  const [volumeCY, setVolumeCY] = useState('');
  const [wastePct, setWastePct] = useState('10');

  let cy = 0;
  if (inputMode === 'dimensions') {
    const l = parseFloat(length);
    const w = parseFloat(width);
    const d = parseFloat(depth); // inches → feet = /12
    if (l > 0 && w > 0 && d > 0) {
      cy = (l * w * (d / 12)) / 27;
    }
  } else {
    cy = parseFloat(volumeCY) || 0;
  }

  const waste = parseFloat(wastePct) || 0;
  const cyWithWaste = cy * (1 + waste / 100);
  const bags80lb = cyWithWaste * 45; // ~45 × 80lb bags per CY
  const bags60lb = cyWithWaste * 60; // ~60 × 60lb bags per CY

  const hasResult = cyWithWaste > 0;

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Box size={20} style={{ color: 'var(--color-accent)' }} />
          <h3 style={{ margin: 0 }}>Concrete Calculator</h3>
        </div>
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
          CY, bag count, and waste factor
        </span>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
          <button
            className={`btn btn-sm ${inputMode === 'dimensions' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setInputMode('dimensions')}
          >
            From Dimensions
          </button>
          <button
            className={`btn btn-sm ${inputMode === 'volume' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setInputMode('volume')}
          >
            From Volume (CY)
          </button>
        </div>

        {inputMode === 'dimensions' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
            <div>
              <label className="label">Length (ft)</label>
              <input className="input" type="number" min="0" value={length} onChange={(e) => setLength(e.target.value)} placeholder="e.g. 20" />
            </div>
            <div>
              <label className="label">Width (ft)</label>
              <input className="input" type="number" min="0" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="e.g. 10" />
            </div>
            <div>
              <label className="label">Thickness (in)</label>
              <input className="input" type="number" min="0" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="e.g. 4" />
            </div>
            <div>
              <label className="label">Waste %</label>
              <input className="input" type="number" min="0" max="50" value={wastePct} onChange={(e) => setWastePct(e.target.value)} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
            <div>
              <label className="label">Volume (CY)</label>
              <input className="input" type="number" min="0" step="0.5" value={volumeCY} onChange={(e) => setVolumeCY(e.target.value)} placeholder="e.g. 5.5" />
            </div>
            <div>
              <label className="label">Waste %</label>
              <input className="input" type="number" min="0" max="50" value={wastePct} onChange={(e) => setWastePct(e.target.value)} />
            </div>
          </div>
        )}

        {hasResult ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-md)' }}>
            <ResultCard label="Net CY" value={cy.toFixed(2)} />
            <ResultCard label="CY w/ Waste" value={cyWithWaste.toFixed(2)} accent />
            <ResultCard label="80-lb Bags" value={Math.ceil(bags80lb).toLocaleString()} />
            <ResultCard label="60-lb Bags" value={Math.ceil(bags60lb).toLocaleString()} />
          </div>
        ) : (
          <div style={{ padding: 'var(--space-xl)', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: '0.875rem' }}>
            Enter dimensions or volume above to see results
          </div>
        )}

        <p style={{ marginTop: 'var(--space-md)', fontSize: '0.75rem', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          CY = L × W × (D in/12) / 27 | ~45 × 80-lb bags per CY
        </p>
      </div>
    </div>
  );
}


// ============================================
// SHARED: Result card
// ============================================

function ResultCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      padding: 'var(--space-md)',
      background: accent ? 'var(--color-accent)' : 'var(--color-bg)',
      border: `1px solid ${accent ? 'var(--color-accent)' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius-md)',
      textAlign: 'center',
    }}>
      <div style={{
        fontSize: '1.5rem',
        fontWeight: 700,
        color: accent ? '#fff' : 'var(--color-text-primary)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{
        fontSize: '0.75rem',
        color: accent ? 'rgba(255,255,255,0.8)' : 'var(--color-text-tertiary)',
        marginTop: '4px',
      }}>
        {label}
      </div>
    </div>
  );
}


// ============================================
// TOOL 5: PDF Search (Smart Document Search)
// ============================================

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function PDFSearchTool() {
  const [documents, setDocuments] = useState<PdfDocument[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isUploading, setIsUploading] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Load documents on mount
  useEffect(() => {
    loadDocuments();
  }, []);

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isAsking]);

  const loadDocuments = useCallback(async () => {
    try {
      const result = await pdfApi.list();
      setDocuments(result.documents || []);
      console.debug('[PDF] Loaded documents:', result.count);
    } catch (err) {
      console.error('[PDF] Failed to load documents:', err);
    }
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setIsUploading(true);
    try {
      const result = await pdfApi.upload(files);
      console.debug('[PDF] Upload result:', result);
      await loadDocuments();

      // Auto-select newly uploaded docs
      const newIds = (result.files || [])
        .filter((f: { id?: string }) => f.id)
        .map((f: { id?: string }) => f.id as string);
      setSelectedIds(prev => {
        const next = new Set(prev);
        newIds.forEach((id: string) => next.add(id));
        return next;
      });
    } catch (err) {
      console.error('[PDF] Upload failed:', err);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (docId: string) => {
    if (!confirm('Delete this document?')) return;
    try {
      await pdfApi.delete(docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
    } catch (err) {
      console.error('[PDF] Delete failed:', err);
    }
  };

  const toggleSelect = (docId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const handleAsk = async () => {
    if (!question.trim() || selectedIds.size === 0) return;

    const userQ = question.trim();
    setQuestion('');
    setChatHistory(prev => [...prev, { role: 'user', content: userQ }]);
    setIsAsking(true);

    try {
      const result = await pdfApi.ask(
        userQ,
        Array.from(selectedIds),
        chatHistory,
      );

      setChatHistory(prev => [...prev, {
        role: 'assistant',
        content: result.answer,
      }]);
    } catch (err) {
      console.error('[PDF] Ask failed:', err);
      setChatHistory(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I encountered an error analyzing the documents. Please try again.',
      }]);
    } finally {
      setIsAsking(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Search size={20} style={{ color: 'var(--color-accent)' }} />
          <h3 style={{ margin: 0 }}>Smart PDF Search</h3>
        </div>
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)' }}>
          Upload PDFs and ask questions — AI reads the documents for you
        </span>
      </div>
      <div className="card-body">

        {/* Upload + Document List */}
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 'var(--space-sm)',
          }}>
            <label className="label" style={{ margin: 0 }}>
              Documents ({documents.length})
            </label>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                multiple
                onChange={handleUpload}
                style={{ display: 'none' }}
              />
              <button
                className="btn btn-outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                style={{ fontSize: '0.8rem', padding: '4px 12px' }}
              >
                {isUploading ? (
                  <>
                    <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite' }} />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload size={14} />
                    Upload PDFs
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Document list */}
          {documents.length === 0 ? (
            <div style={{
              padding: 'var(--space-lg)',
              textAlign: 'center',
              color: 'var(--color-text-tertiary)',
              fontSize: '0.875rem',
              background: 'var(--color-bg)',
              borderRadius: 'var(--radius-md)',
              border: '1px dashed var(--color-border)',
            }}>
              <FileText size={32} style={{ opacity: 0.3, marginBottom: 'var(--space-sm)' }} />
              <p style={{ margin: 0 }}>No documents uploaded yet</p>
              <p style={{ margin: '4px 0 0', fontSize: '0.75rem' }}>
                Upload spec books, submittals, or drawings to search them
              </p>
            </div>
          ) : (
            <div style={{
              maxHeight: '200px', overflowY: 'auto',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}>
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                    padding: 'var(--space-sm) var(--space-md)',
                    borderBottom: '1px solid var(--color-border)',
                    background: selectedIds.has(doc.id) ? 'var(--color-accent-light)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'background 0.12s ease',
                  }}
                  onClick={() => toggleSelect(doc.id)}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(doc.id)}
                    onChange={() => toggleSelect(doc.id)}
                    style={{ flexShrink: 0 }}
                  />
                  <FileText size={16} style={{
                    color: selectedIds.has(doc.id) ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: '0.8125rem', fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {doc.filename}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary)' }}>
                      {doc.page_count} pages • {formatFileSize(doc.file_size)}
                    </div>
                  </div>
                  <button
                    className="btn-icon"
                    onClick={(e) => { e.stopPropagation(); handleDelete(doc.id); }}
                    title="Delete document"
                    style={{ flexShrink: 0 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {selectedIds.size > 0 && (
            <div style={{
              marginTop: 'var(--space-xs)',
              fontSize: '0.7rem',
              color: 'var(--color-accent)',
              fontWeight: 500,
            }}>
              {selectedIds.size} document{selectedIds.size > 1 ? 's' : ''} selected for search
            </div>
          )}
        </div>

        {/* Chat area */}
        <div style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}>
          {/* Messages */}
          <div style={{
            height: '300px', overflowY: 'auto',
            padding: 'var(--space-md)',
            display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
            background: 'var(--color-bg)',
          }}>
            {chatHistory.length === 0 && (
              <div style={{
                textAlign: 'center', color: 'var(--color-text-tertiary)',
                marginTop: 'var(--space-xl)', fontSize: '0.8125rem',
              }}>
                <Search size={32} style={{ opacity: 0.2, marginBottom: 'var(--space-sm)' }} />
                <p style={{ margin: 0 }}>Select documents and ask a question</p>
                <p style={{ margin: '4px 0 0', fontSize: '0.75rem' }}>
                  "What are the pipe material specs?" • "Find the compaction requirements"
                </p>
              </div>
            )}

            {chatHistory.map((msg, idx) => (
              <div key={idx} style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '90%',
                padding: 'var(--space-sm) var(--space-md)',
                borderRadius: 'var(--radius)',
                backgroundColor: msg.role === 'user' ? 'var(--primary, var(--color-accent))' : 'var(--color-surface)',
                color: msg.role === 'user' ? 'white' : 'var(--color-text-primary)',
                border: msg.role === 'assistant' ? '1px solid var(--color-border)' : 'none',
                fontSize: '0.85rem',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}>
                {msg.content}
              </div>
            ))}

            {isAsking && (
              <div style={{
                alignSelf: 'flex-start',
                padding: 'var(--space-sm) var(--space-md)',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                display: 'flex', gap: 'var(--space-sm)', alignItems: 'center',
              }}>
                <Loader2 size={14} style={{ animation: 'spin 0.6s linear infinite', color: 'var(--color-accent)' }} />
                <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  Analyzing documents...
                </span>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => { e.preventDefault(); handleAsk(); }}
            style={{
              display: 'flex', gap: 'var(--space-xs)',
              padding: 'var(--space-sm)',
              borderTop: '1px solid var(--color-border)',
              background: 'var(--color-surface)',
            }}
          >
            <input
              type="text"
              className="input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={selectedIds.size === 0 ? 'Select documents above first...' : 'Ask a question about the selected documents...'}
              disabled={isAsking || selectedIds.size === 0}
              style={{ flex: 1, fontSize: '0.85rem' }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!question.trim() || isAsking || selectedIds.size === 0}
              style={{ padding: 'var(--space-xs) var(--space-sm)', flexShrink: 0 }}
            >
              <Send size={16} />
            </button>
          </form>
        </div>

        {chatHistory.length > 0 && (
          <button
            className="btn btn-ghost"
            onClick={() => setChatHistory([])}
            style={{ marginTop: 'var(--space-sm)', fontSize: '0.75rem' }}
          >
            Clear conversation
          </button>
        )}
      </div>
    </div>
  );
}

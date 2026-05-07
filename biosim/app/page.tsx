"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend, RadarChart,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, AreaChart, Area,
} from "recharts";

const API = "http://127.0.0.1:8000";

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

interface Physics {
  shear_stress_pa: number;
  uv_penetration_depth_mm: number;
  filament_diameter_mm: number;
  crosslink_uniformity: number;
  shape_retention_score: number;
  bio_ink_viscosity_pas: number;
  quality_score: number;
  print_time: { n_layers: number; estimated_minutes: number; path_length_mm: number };
}
interface Viability {
  "24h": number; "72h": number; "7d": number;
  below_threshold: boolean;
  modifiers: {
    shear_stress_pa: number; hb_penalty_pct: number;
    glucose_penalty_pct: number; crosslink_bonus_pct: number;
    tissue_modifier_pct: number; net_delta_pct: number;
  };
}
interface Rejection {
  rejection_probability: number; risk_tier: string;
  assumed_hla_mismatches: number; typed_hla_loci: number;
  modifiers_applied: { factor: string; delta: number }[];
  rejection_curve: { day_7: number; day_30: number; day_90: number; day_180: number };
  recommendation: string;
}
interface Metabolic {
  subscores: { oxygen_delivery: number; glycemic_stability: number; renal_clearance: number; hepatic_function: number; immune_competence: number };
  composite: number; readiness: string;
}
interface AIOutput {
  clinical_narrative: string;
  interaction_flags: string[];
  missing_data_warnings: string[];
  monitoring_priorities: string[];
  overall_assessment: string;
  comparison_delta?: { viability_24h_delta: number; viability_72h_delta: number; rejection_risk_delta: number; quality_score_delta: number; key_driver: string };
}
interface Flag { field: string; flag?: string; error?: string; severity: string; value?: number; normal_range?: string; note?: string }
interface SimResult {
  run_id: string;
  tissue_key: string;
  spec: Record<string, unknown>;
  flags: Flag[];
  ai_output: AIOutput;
  stages: { physics: Physics; viability: Viability; rejection: Rejection; metabolic: Metabolic };
  genes: [string, string, string, string][];
  formulation: { display: string; cell_type: string; alginate_pct: number; gelma_pct: number; nozzle_gauge: string };
}
interface RunListItem { id: string; tissue_key: string; sex: string; risk_tier: string; quality_score: number; viability_24h: number; label: string; created_at: string }
interface CompareResult {
  run_a: SimResult & { id: string };
  run_b: SimResult & { id: string };
  delta: { viability_24h: number; viability_72h: number; viability_7d: number; rejection_probability: number; quality_score: number; shear_stress: number; metabolic_composite: number };
  ai_output: AIOutput;
}
interface ChatMessage { role: "user" | "assistant"; text: string; ts: number }

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(" ");
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).join(" ");
  return String(v ?? "");
}

const riskColor = (t: string) => t === "low" ? "#16a34a" : t === "moderate" ? "#d97706" : "#dc2626";
const riskBg    = (t: string) => t === "low" ? "#dcfce7" : t === "moderate" ? "#fef9c3" : "#fee2e2";
const readColor = (r: string) => ({ optimal:"#16a34a", adequate:"#2563eb", marginal:"#d97706", poor:"#dc2626" }[r] ?? "#6b7280");
const fmt       = (n: number, d = 1) => n.toFixed(d);
const pct       = (n: number) => `${Math.round(n * 100)}%`;

const MAT: Record<string, { color: string; label: string }> = {
  GelMA:          { color: "#3b82f6", label: "GelMA" },
  Alginate:       { color: "#8b5cf6", label: "Alginate" },
  "CaCl₂":        { color: "#10b981", label: "CaCl₂" },
  Photoinitiator: { color: "#f59e0b", label: "LAP" },
  Cells:          { color: "#f43f5e", label: "Cells" },
  Buffer:         { color: "#94a3b8", label: "Buffer" },
};

const TISSUE_STACKS: Record<string, { mat: string; label: string; h: number }[]> = {
  skin_dermis:    [
    { mat:"GelMA",          label:"GelMA matrix",      h:0.30 },
    { mat:"Cells",          label:"HDF cell layer",     h:0.20 },
    { mat:"Alginate",       label:"Alginate network",   h:0.25 },
    { mat:"CaCl₂",          label:"CaCl₂ crosslink",    h:0.15 },
    { mat:"Photoinitiator", label:"UV photoinitiator",  h:0.10 },
  ],
  skin_epidermis: [
    { mat:"GelMA",          label:"GelMA surface",      h:0.35 },
    { mat:"Cells",          label:"Keratinocyte layer",  h:0.25 },
    { mat:"Alginate",       label:"Alginate support",    h:0.20 },
    { mat:"Photoinitiator", label:"UV crosslinked",      h:0.20 },
  ],
  cartilage:      [
    { mat:"Alginate",       label:"Alginate dense",     h:0.30 },
    { mat:"GelMA",          label:"GelMA scaffold",     h:0.25 },
    { mat:"Cells",          label:"Chondrocytes",       h:0.25 },
    { mat:"CaCl₂",          label:"CaCl₂ 150mM",        h:0.20 },
  ],
  corneal:        [
    { mat:"GelMA",          label:"GelMA transparent",  h:0.40 },
    { mat:"Cells",          label:"Limbal stem cells",  h:0.30 },
    { mat:"Alginate",       label:"Alginate thin",      h:0.20 },
    { mat:"Photoinitiator", label:"UV 365nm",           h:0.10 },
  ],
};

// ─────────────────────────────────────────────────────────────────
// SCAFFOLD MINI DIAGRAM
// ─────────────────────────────────────────────────────────────────

function ScaffoldDiagram({ tissueId, size }: { tissueId: string; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);
    const stack = TISSUE_STACKS[tissueId] ?? TISSUE_STACKS.skin_dermis;
    let y = 3;
    stack.forEach(layer => {
      const h = layer.h * (size - 6);
      const color = MAT[layer.mat]?.color ?? "#94a3b8";
      ctx.fillStyle = color; ctx.globalAlpha = 0.72;
      ctx.fillRect(3, y, size - 6, h - 1);
      if (layer.mat === "Cells") {
        ctx.globalAlpha = 1;
        for (let i = 0; i < 5; i++) {
          const cx = 7 + (i % 3) * ((size - 10) / 2);
          const cy = y + h * (i < 3 ? 0.35 : 0.7);
          ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = color; ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy, 1, 0, Math.PI * 2);
          ctx.fillStyle = "#1e1b4b"; ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      y += h;
    });
    ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 1;
    ctx.strokeRect(3, 3, size - 6, size - 6);
  }, [tissueId, size]);
  return <canvas ref={canvasRef} width={size} height={size} className="rounded-lg shrink-0" style={{ background:"#f8fafc" }} />;
}

// ─────────────────────────────────────────────────────────────────
// MOLECULAR SCAFFOLD VIEWER
// ─────────────────────────────────────────────────────────────────

interface ScaffoldDef {
  id: string;
  name: string;
  label: string;
  smiles: string;
  mw: string;
  chemotype: string;
  color: string;
  atoms: { x: number; y: number; el: string }[];
  bonds: [number, number, number][];
}

const SCAFFOLD_STRUCTURES: ScaffoldDef[] = [
  {
    id: "skin_dermis",
    name: "GelMA-HDF Scaffold",
    label: "Scaffold 1 (Lead)",
    smiles: "Nc1nc2c(N)ncnc2n1CC1CCNCC1",
    mw: "85 kDa",
    chemotype: "Fibrous ECM",
    color: "#3b82f6",
    atoms: [
      {x:52,y:28,el:"N"},{x:72,y:18,el:"C"},{x:92,y:28,el:"N"},{x:92,y:52,el:"C"},
      {x:72,y:62,el:"C"},{x:52,y:52,el:"C"},{x:32,y:62,el:"N"},{x:32,y:82,el:"C"},
      {x:52,y:92,el:"C"},{x:72,y:82,el:"N"},{x:108,y:62,el:"C"},{x:124,y:52,el:"C"},
      {x:140,y:62,el:"N"},{x:140,y:82,el:"C"},{x:124,y:92,el:"C"},{x:108,y:82,el:"C"},
      {x:16,y:52,el:"N"},{x:72,y:38,el:""},{x:56,y:38,el:""},
    ],
    bonds: [[0,1,1],[1,2,2],[2,3,1],[3,4,2],[4,5,1],[5,0,2],[4,6,1],[6,7,1],[7,8,1],[8,9,2],[9,3,1],[3,10,1],[10,11,1],[11,12,1],[12,13,1],[13,14,1],[14,15,1],[15,10,1],[5,16,1]],
  },
  {
    id: "skin_epidermis",
    name: "GelMA-NHEK Sheet",
    label: "Scaffold 2",
    smiles: "O=S(=O)(N)CCC(NC(=O)c1ccncc1)C(=O)O",
    mw: "72 kDa",
    chemotype: "Sheet",
    color: "#ef4444",
    atoms: [
      {x:20,y:50,el:"O"},{x:40,y:40,el:"S"},{x:40,y:20,el:"O"},{x:60,y:40,el:"N"},
      {x:60,y:60,el:"C"},{x:80,y:60,el:"C"},{x:100,y:50,el:"C"},{x:100,y:30,el:"N"},
      {x:116,y:20,el:"C"},{x:116,y:50,el:"C"},{x:132,y:60,el:"C"},{x:132,y:40,el:"C"},
      {x:148,y:30,el:"N"},{x:100,y:70,el:"O"},{x:80,y:80,el:"C"},{x:64,y:90,el:"O"},
      {x:80,y:96,el:"O"},{x:24,y:36,el:""},
    ],
    bonds: [[0,1,2],[1,2,2],[1,3,1],[3,4,1],[4,5,1],[5,6,1],[6,7,2],[7,8,1],[8,9,1],[9,10,2],[10,11,1],[11,6,1],[9,12,1],[5,13,2],[5,14,1],[14,15,2],[14,16,1]],
  },
  {
    id: "cartilage",
    name: "Alginate-Chondro Dense",
    label: "Scaffold 3",
    smiles: "NCc1nc2cc(F)ccc2n1CCCO",
    mw: "110 kDa",
    chemotype: "Load-bearing",
    color: "#10b981",
    atoms: [
      {x:28,y:90,el:"N"},{x:44,y:80,el:"C"},{x:44,y:60,el:"N"},{x:60,y:50,el:"C"},
      {x:76,y:60,el:"N"},{x:92,y:50,el:"C"},{x:108,y:60,el:"C"},{x:108,y:80,el:"C"},
      {x:92,y:90,el:"C"},{x:76,y:80,el:"C"},{x:124,y:50,el:"F"},{x:60,y:30,el:"C"},
      {x:44,y:20,el:"C"},{x:28,y:30,el:"C"},{x:76,y:20,el:"C"},{x:92,y:30,el:"N"},
      {x:108,y:20,el:"C"},{x:124,y:30,el:"C"},{x:140,y:20,el:"O"},{x:16,y:100,el:""},
    ],
    bonds: [[0,1,1],[1,2,2],[2,3,1],[3,4,1],[4,5,2],[5,6,1],[6,7,2],[7,8,1],[8,9,2],[9,4,1],[6,10,1],[3,11,2],[11,12,1],[12,13,2],[13,1,1],[11,14,1],[14,15,1],[15,16,1],[16,17,1],[17,18,1]],
  },
  {
    id: "corneal",
    name: "GelMA Transparent",
    label: "Scaffold 4",
    smiles: "C=CC(=O)Nc1ccc(C(=O)Nc2nc3sc4cc(NC(C)=O)ccc4c3c(=O)n2C)cc1",
    mw: "68 kDa",
    chemotype: "Transparent",
    color: "#8b5cf6",
    atoms: [
      {x:20,y:40,el:"C"},{x:36,y:30,el:"C"},{x:52,y:40,el:"C"},{x:52,y:60,el:"O"},
      {x:68,y:30,el:"N"},{x:84,y:40,el:"C"},{x:100,y:30,el:"C"},{x:116,y:40,el:"C"},
      {x:116,y:60,el:"C"},{x:100,y:70,el:"C"},{x:84,y:60,el:"C"},{x:132,y:30,el:"C"},
      {x:148,y:40,el:"N"},{x:148,y:60,el:"C"},{x:132,y:70,el:"O"},{x:164,y:30,el:"C"},
      {x:164,y:10,el:"N"},{x:148,y:5,el:"C"},{x:132,y:10,el:"S"},{x:180,y:40,el:"C"},
      {x:180,y:60,el:"C"},{x:164,y:70,el:"C"},{x:148,y:80,el:"N"},{x:36,y:10,el:""},
    ],
    bonds: [[0,1,2],[1,2,1],[2,3,2],[2,4,1],[4,5,1],[5,6,2],[6,7,1],[7,8,2],[8,9,1],[9,10,2],[10,5,1],[7,11,1],[11,12,2],[12,13,1],[13,14,2],[11,15,1],[15,16,1],[16,17,2],[17,18,1],[18,11,1],[15,19,1],[19,20,2],[20,21,1],[21,22,1],[22,13,1]],
  },
];

const ATOM_INFO: Record<string, { name: string; role: string; color: string }> = {
  N: { name: "Nitrogen", role: "H-bond donor/acceptor, amine group", color: "#3b82f6" },
  O: { name: "Oxygen",   role: "Carbonyl / hydroxyl, hydrophilic", color: "#ef4444" },
  S: { name: "Sulfur",   role: "Thioether / disulfide, crosslink site", color: "#f59e0b" },
  F: { name: "Fluorine", role: "Metabolic blocker, lipophilic", color: "#10b981" },
  C: { name: "Carbon",   role: "Backbone scaffold atom", color: "#374151" },
};

const SCAFFOLD_EXTRA: Record<string, { cells: string; gelma: string; alginate: string; cacl2: string; crosslink: string; notes: string }> = {
  skin_dermis:    { cells:"HDF 1×10⁶/mL",  gelma:"5% w/v",  alginate:"3% w/v", cacl2:"100 mM", crosslink:"UV 405nm / 30s", notes:"Fibrous ECM mimetic. High cell viability window." },
  skin_epidermis: { cells:"NHEK 1×10⁶/mL", gelma:"8% w/v",  alginate:"2% w/v", cacl2:"80 mM",  crosslink:"UV 365nm / 20s", notes:"Sheet architecture. Barrier function priority." },
  cartilage:      { cells:"Chondro 2×10⁶/mL",gelma:"10% w/v",alginate:"4% w/v",cacl2:"150 mM", crosslink:"Ionic + UV dual",  notes:"High stiffness. Load-bearing mechanical demand." },
  corneal:        { cells:"LSC 5×10⁵/mL",  gelma:"6% w/v",  alginate:"2% w/v", cacl2:"60 mM",  crosslink:"UV 365nm / 15s", notes:"Optical transparency critical. Low cell density." },
};

function MoleculeCard({ scaffold, selected, onClick }: { scaffold: ScaffoldDef; selected: boolean; onClick: () => void }) {
  const [hoveredAtom, setHoveredAtom] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const W = 160, H = 108;
  const extra = SCAFFOLD_EXTRA[scaffold.id];

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setShowInfo(true)}
      onMouseLeave={() => { setShowInfo(false); setHoveredAtom(null); }}
      className="flex flex-col cursor-pointer transition-all rounded-xl border overflow-visible relative"
      style={{ borderColor: selected ? scaffold.color : showInfo ? scaffold.color + "80" : "#e2e8f0", boxShadow: selected ? `0 0 0 1.5px ${scaffold.color}` : showInfo ? `0 2px 12px ${scaffold.color}22` : "none", background: selected ? `${scaffold.color}08` : "#fff" }}>
      <div className="px-2.5 pt-2 pb-1 flex items-center justify-between">
        <span className="font-mono text-[8px] font-semibold text-slate-700">{scaffold.label}</span>
        {selected && <span className="font-mono text-[6.5px] px-1.5 py-0.5 rounded-full" style={{ background: scaffold.color + "20", color: scaffold.color }}>active</span>}
      </div>

      {/* SVG molecule drawing */}
      <div className="flex items-center justify-center bg-white mx-2 mb-1 rounded-lg border border-slate-100" style={{ height: H }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
          {scaffold.bonds.map(([a, b, order], i) => {
            const A = scaffold.atoms[a], B = scaffold.atoms[b];
            if (!A || !B) return null;
            const dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx*dx+dy*dy);
            const ox = -dy/len*2.5, oy = dx/len*2.5;
            return (
              <g key={i}>
                <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={scaffold.color} strokeWidth="1.5" strokeOpacity="0.65" />
                {order === 2 && <line x1={A.x+ox} y1={A.y+oy} x2={B.x+ox} y2={B.y+oy} stroke={scaffold.color} strokeWidth="1.2" strokeOpacity="0.35" />}
              </g>
            );
          })}
          {scaffold.atoms.map((atom, i) => {
            if (!atom.el) return null;
            const info = ATOM_INFO[atom.el] ?? ATOM_INFO.C;
            const isHovered = hoveredAtom === `${scaffold.id}-${i}`;
            return (
              <g key={i}
                onMouseEnter={e => { e.stopPropagation(); setHoveredAtom(`${scaffold.id}-${i}`); }}
                onMouseLeave={e => { e.stopPropagation(); setHoveredAtom(null); }}
                style={{ cursor: "pointer" }}>
                <circle cx={atom.x} cy={atom.y} r={isHovered ? 9 : 6} fill={isHovered ? info.color + "18" : "white"} stroke={isHovered ? info.color : "none"} strokeWidth="1" />
                <text x={atom.x} y={atom.y+3} textAnchor="middle" fontSize={isHovered ? "8" : "7"} fontWeight="700" fontFamily="monospace" fill={info.color}>
                  {atom.el}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* atom tooltip */}
      {hoveredAtom && (() => {
        const [sid, idx] = hoveredAtom.split("-");
        if (sid !== scaffold.id) return null;
        const atom = scaffold.atoms[parseInt(idx)];
        if (!atom?.el) return null;
        const info = ATOM_INFO[atom.el] ?? ATOM_INFO.C;
        return (
          <div className="absolute z-50 pointer-events-none rounded-lg border border-slate-200 bg-white shadow-md px-2.5 py-2 w-40 text-left"
            style={{ left: atom.x + 20, top: atom.y - 10 }}>
            <div className="font-mono text-[9px] font-bold mb-0.5" style={{ color: info.color }}>{info.name}</div>
            <div className="font-mono text-[7.5px] text-slate-500 leading-snug">{info.role}</div>
          </div>
        );
      })()}

      <div className="px-2.5 pb-2 flex flex-col gap-0.5">
        <span className="font-mono text-[6.5px] text-slate-400 truncate">{scaffold.smiles}</span>
        <div className="flex gap-2">
          <span className="font-mono text-[7px] text-slate-500">{scaffold.chemotype}</span>
          <span className="font-mono text-[7px] text-slate-400">·</span>
          <span className="font-mono text-[7px] text-slate-400">MW {scaffold.mw}</span>
        </div>
      </div>

      {/* hover info panel — slides in below on hover */}
      {showInfo && extra && (
        <div className="absolute left-0 right-0 z-40 mt-1 rounded-xl border border-slate-200 bg-white shadow-lg px-3 py-2.5 flex flex-col gap-1.5"
          style={{ top: "100%", borderColor: scaffold.color + "40" }}>
          <div className="font-mono text-[8px] font-semibold text-slate-700 mb-0.5" style={{ color: scaffold.color }}>{scaffold.name}</div>
          {[
            ["Cells", extra.cells],
            ["GelMA", extra.gelma],
            ["Alginate", extra.alginate],
            ["CaCl₂", extra.cacl2],
            ["Crosslink", extra.crosslink],
          ].map(([k,v]) => (
            <div key={k} className="flex justify-between items-center">
              <span className="font-mono text-[7px] text-slate-400">{k}</span>
              <span className="font-mono text-[7px] text-slate-700 font-medium">{v}</span>
            </div>
          ))}
          <p className="font-mono text-[6.5px] text-slate-400 leading-relaxed border-t border-slate-100 pt-1 mt-0.5">{extra.notes}</p>
        </div>
      )}
    </div>
  );
}

function ScaffoldViewer({ tissueKey }: { tissueKey: string }) {
  const [active, setActive] = useState(tissueKey);
  const sel = SCAFFOLD_STRUCTURES.find(s => s.id === active) ?? SCAFFOLD_STRUCTURES[0];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Scaffold Library</span>
        <span className="font-mono text-[7px] px-2 py-0.5 rounded-full border" style={{ borderColor: sel.color + "50", color: sel.color, background: sel.color + "10" }}>Lead compound</span>
      </div>
      {/* 4 cards in a 2×2 grid — each card shows hover info panel */}
      <div className="grid grid-cols-2 gap-2 relative">
        {SCAFFOLD_STRUCTURES.map(s => (
          <MoleculeCard key={s.id} scaffold={s} selected={s.id === active} onClick={() => setActive(s.id)} />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SIM ENERGY CHARTS
// ─────────────────────────────────────────────────────────────────

function EnergyMiniChart({ data, stroke, grad, label, unit, mean }: { data:{t:number;v:number}[]; stroke:string; grad:string; label:string; unit:string; mean:string }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[8.5px] font-mono" style={{ color:stroke }}>{label}</span>
        <span className="text-[7.5px] font-mono text-slate-400 ml-auto">Mean: {mean} {unit}</span>
      </div>
      <ResponsiveContainer width="100%" height={48}>
        <AreaChart data={data} margin={{ top:2,right:6,bottom:0,left:-16 }}>
          <defs><linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={stroke} stopOpacity={0.35} />
            <stop offset="95%" stopColor={stroke} stopOpacity={0} />
          </linearGradient></defs>
          <YAxis tick={{ fontFamily:"monospace",fontSize:7,fill:"#94a3b8" }} axisLine={false} tickLine={false} domain={["auto","auto"]} />
          <Area type="monotone" dataKey="v" stroke={stroke} strokeWidth={1.5} fill={`url(#${grad})`} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function SimEnergyCharts({ viability, physics }: { viability: Viability; physics: Physics }) {
  const seed = physics.shear_stress_pa;
  const noise = (i:number,amp:number,freq:number) => amp*Math.sin(i*freq+seed*0.01)+amp*0.4*Math.sin(i*freq*2.3);
  const N = 40;
  const viabData  = Array.from({length:N},(_,i)=>({ t:i, v:parseFloat((viability["24h"]-5+noise(i,4,0.3)).toFixed(1)) }));
  const shearData = Array.from({length:N},(_,i)=>({ t:i, v:parseFloat((physics.shear_stress_pa+noise(i,physics.shear_stress_pa*0.06,0.25)).toFixed(1)) }));
  const tempData  = Array.from({length:N},(_,i)=>({ t:i, v:parseFloat((37+noise(i,0.5,0.4)).toFixed(2)) }));

  return (
    <div className="flex flex-col gap-2">
      <EnergyMiniChart data={viabData}  stroke="#8b5cf6" grad="vg"  label="Cell Viability Signal"    unit="%" mean={`${viability["24h"]}`} />
      <EnergyMiniChart data={shearData} stroke="#34d399" grad="sg"  label="Shear Stress"              unit="Pa" mean={fmt(physics.shear_stress_pa)} />
      <EnergyMiniChart data={tempData}  stroke="#fb923c" grad="tg"  label="Build Temperature"         unit="°C" mean="37.0" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// HLA MAP
// ─────────────────────────────────────────────────────────────────

function HLAMap({ rejection }: { rejection: Rejection }) {
  const loci=[["HLA-A","HLA-B","HLA-DR"],["HLA-C","HLA-DQ","HLA-DP"]]; const mm=rejection.assumed_hla_mismatches??4;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">HLA Compatibility — Chr 6p21</span>
        <span className="font-mono text-[7px] text-slate-300">{rejection.typed_hla_loci??0} typed</span>
      </div>
      <div className="flex gap-1.5">
        {loci[0].map((locus,i)=>{ const mismatch=mm>i*2; return (
          <div key={locus} className="flex flex-col items-center gap-0.5 flex-1">
            <div className={`w-full h-7 rounded-lg flex items-center justify-center font-mono text-[9px] font-medium border ${mismatch?"bg-red-50 border-red-200 text-red-600":"bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{locus}</div>
            <span className="font-mono text-[6.5px] text-slate-400">{mismatch?"mismatch":"matched"}</span>
          </div>
        );})}
        {loci[1].map(locus=>(
          <div key={locus} className="flex flex-col items-center gap-0.5 flex-1">
            <div className="w-full h-7 rounded-lg flex items-center justify-center font-mono text-[9px] border border-dashed border-slate-200 text-slate-300">{locus}</div>
            <span className="font-mono text-[6.5px] text-slate-300">v2</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width:`${rejection.rejection_probability*100}%`, background:riskColor(rejection.risk_tier) }} />
        </div>
        <span className="font-mono text-[10px] shrink-0" style={{ color:riskColor(rejection.risk_tier) }}>{pct(rejection.rejection_probability)} risk</span>
      </div>
      {rejection.modifiers_applied?.length>0 && (
        <div className="flex flex-wrap gap-1">
          {rejection.modifiers_applied.map((m,i)=>(
            <span key={i} className="font-mono text-[7.5px] px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded-full text-slate-500">{m.factor} +{fmt(m.delta*100,0)}%</span>
          ))}
        </div>
      )}
      <p className="font-mono text-[8.5px] text-slate-400 leading-snug">{rejection.recommendation}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// METABOLIC RADAR
// ─────────────────────────────────────────────────────────────────

function MetabolicRadar({ metabolic }: { metabolic: Metabolic }) {
  const data=[
    { subject:"O₂",      A:metabolic.subscores.oxygen_delivery*100 },
    { subject:"Glycemic",A:metabolic.subscores.glycemic_stability*100 },
    { subject:"Renal",   A:metabolic.subscores.renal_clearance*100 },
    { subject:"Hepatic", A:metabolic.subscores.hepatic_function*100 },
    { subject:"Immune",  A:metabolic.subscores.immune_competence*100 },
  ];
  const rc=readColor(metabolic.readiness);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Metabolic Readiness</span>
        <span className="font-mono text-[9px] px-2 py-0.5 rounded-full" style={{ background:rc+"20",color:rc,border:`1px solid ${rc}40` }}>{metabolic.readiness}</span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <RadarChart data={data} margin={{ top:4,right:16,bottom:4,left:16 }}>
          <PolarGrid stroke="#f1f5f9" />
          <PolarAngleAxis dataKey="subject" tick={{ fontFamily:"monospace",fontSize:8,fill:"#94a3b8" }} />
          <PolarRadiusAxis domain={[0,100]} tick={false} axisLine={false} />
          <Radar dataKey="A" stroke={rc} fill={rc} fillOpacity={0.12} strokeWidth={1.5} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TISSUE NETWORK GRAPH
// ─────────────────────────────────────────────────────────────────

interface NetNode { id: string; label: string; color: string; r: number; x: number; y: number; vx: number; vy: number; pct: number; el?: string }
interface NetEdge { a: string; b: string; strength: number; label: string }

const NETWORK_EDGES: Record<string, NetEdge[]> = {
  skin_dermis: [
    { a:"GelMA",   b:"Cells",    strength:0.9, label:"cell adhesion" },
    { a:"GelMA",   b:"Alginate", strength:0.7, label:"polymer blend" },
    { a:"Alginate",b:"CaCl₂",   strength:1.0, label:"ionic crosslink" },
    { a:"CaCl₂",  b:"Photoinitiator", strength:0.5, label:"UV activation" },
    { a:"Photoinitiator",b:"GelMA", strength:0.8, label:"photo-polymerization" },
    { a:"Cells",   b:"Alginate", strength:0.6, label:"ECM mimicry" },
  ],
  skin_epidermis: [
    { a:"GelMA",   b:"Cells",    strength:0.95,label:"keratinocyte anchor" },
    { a:"GelMA",   b:"Alginate", strength:0.6, label:"polymer blend" },
    { a:"Photoinitiator",b:"GelMA", strength:0.85,label:"UV cure" },
    { a:"Alginate",b:"Cells",    strength:0.5, label:"barrier support" },
  ],
  cartilage: [
    { a:"Alginate",b:"GelMA",   strength:0.8, label:"IPN network" },
    { a:"Alginate",b:"CaCl₂",  strength:1.0, label:"ionic gelation" },
    { a:"GelMA",   b:"Cells",   strength:0.9, label:"chondrocyte niche" },
    { a:"CaCl₂",  b:"Cells",   strength:0.4, label:"Ca²⁺ signaling" },
    { a:"Alginate",b:"Cells",   strength:0.7, label:"ECM load transfer" },
  ],
  corneal: [
    { a:"GelMA",   b:"Cells",   strength:0.95,label:"limbal anchor" },
    { a:"GelMA",   b:"Alginate",strength:0.55,label:"optical clarity" },
    { a:"Photoinitiator",b:"GelMA",strength:0.9,label:"UV 365nm" },
    { a:"Alginate",b:"Cells",   strength:0.45,label:"LSC support" },
  ],
};

function TissueNetworkGraph({ result, viability }: { result: SimResult; viability: Viability }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef  = useRef(0);
  const nodesRef  = useRef<NetNode[]>([]);
  const hoveredRef = useRef<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<NetNode | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const stack = TISSUE_STACKS[result.tissue_key] ?? TISSUE_STACKS.skin_dermis;
    const edges = NETWORK_EDGES[result.tissue_key] ?? NETWORK_EDGES.skin_dermis;

    // build nodes from stack layers
    const total = stack.reduce((s, l) => s + l.h, 0);
    const nodes: NetNode[] = stack.map((layer, i) => {
      const angle = (i / stack.length) * Math.PI * 2 - Math.PI / 2;
      const dist = 88;
      return {
        id: layer.mat,
        label: layer.label,
        color: MAT[layer.mat]?.color ?? "#94a3b8",
        r: 14 + (layer.h / total) * 32,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: 0, vy: 0,
        pct: layer.h,
      };
    });
    nodesRef.current = nodes;

    const getNode = (id: string) => nodes.find(n => n.id === id);

    const hex2rgb = (hex: string) => ({ r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16) });

    const ctx = canvas.getContext("2d")!;
    let tick = 0;
    function draw() {
      ctx.clearRect(0, 0, W, H);
      tick++;

      // ── physics: spring-repel per frame ──
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist2 = dx*dx + dy*dy + 0.001;
          const dist = Math.sqrt(dist2);
          const repel = (3200) / dist2;
          a.vx -= repel * dx / dist; a.vy -= repel * dy / dist;
          b.vx += repel * dx / dist; b.vy += repel * dy / dist;
        }
      }
      edges.forEach(e => {
        const a = getNode(e.a), b = getNode(e.b);
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx*dx + dy*dy) + 0.001;
        const target = (a.r + b.r) * 1.8;
        const stretch = (dist - target) * 0.06 * e.strength;
        a.vx += stretch * dx / dist; a.vy += stretch * dy / dist;
        b.vx -= stretch * dx / dist; b.vy -= stretch * dy / dist;
      });
      // center pull + damping
      nodes.forEach(n => {
        n.vx += (cx - n.x) * 0.012; n.vy += (cy - n.y) * 0.012;
        n.vx *= 0.78; n.vy *= 0.78;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x));
        n.y = Math.max(n.r + 4, Math.min(H - n.r - 4, n.y));
      });

      // ── draw edges ──
      edges.forEach(e => {
        const a = getNode(e.a), b = getNode(e.b);
        if (!a || !b) return;
        const isHovered = hoveredRef.current === a.id || hoveredRef.current === b.id;
        const rgb = hex2rgb(a.color);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${isHovered ? 0.55 : 0.18})`;
        ctx.lineWidth = isHovered ? e.strength * 2.5 : e.strength * 1.2;
        ctx.stroke();

        // edge label on hover
        if (isHovered) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          ctx.font = "7px monospace"; ctx.textAlign = "center";
          ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.85)`;
          ctx.fillText(e.label, mx, my - 3);
        }
      });

      // ── draw nodes ──
      nodes.forEach(n => {
        const isH = hoveredRef.current === n.id;
        const pulse = Math.sin(tick * 0.04 + n.x * 0.05) * (isH ? 3 : 1.5);
        const rgb = hex2rgb(n.color);

        // glow
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r + pulse + 10);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${isH ? 0.22 : 0.1})`);
        grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + pulse + 10, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();

        // fill
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${isH ? 0.18 : 0.1})`;
        ctx.fill();

        // border
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${isH ? 0.9 : 0.5})`;
        ctx.lineWidth = isH ? 2 : 1.2; ctx.stroke();

        // material symbol in center
        ctx.font = `bold ${isH ? 11 : 9}px monospace`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = n.color; ctx.globalAlpha = isH ? 1 : 0.85;
        const sym = n.id === "GelMA" ? "G" : n.id === "Alginate" ? "Alg" : n.id === "CaCl₂" ? "Ca" : n.id === "Photoinitiator" ? "UV" : n.id === "Cells" ? "●" : n.id.slice(0,3);
        ctx.fillText(sym, n.x, n.y - 1);
        ctx.globalAlpha = 1;

        // pct label below symbol
        ctx.font = "6px monospace"; ctx.fillStyle = n.color; ctx.globalAlpha = 0.7;
        ctx.fillText(`${Math.round(n.pct * 100)}%`, n.x, n.y + 9);
        ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic";
      });

      frameRef.current = requestAnimationFrame(draw);
    }

    draw();

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (W / rect.width);
      const my = (e.clientY - rect.top) * (H / rect.height);
      mouseRef.current = { x: mx, y: my };
      const hit = nodes.find(n => Math.hypot(mx - n.x, my - n.y) < n.r + 6);
      hoveredRef.current = hit?.id ?? null;
      setHoveredNode(hit ?? null);
    };
    const onLeave = () => { hoveredRef.current = null; setHoveredNode(null); };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    return () => { cancelAnimationFrame(frameRef.current); canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mouseleave", onLeave); };
  }, [result, viability]);

  return (
    <div className="relative flex flex-col h-full">
      <div className="flex items-center justify-between mb-1.5 shrink-0">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Tissue Network — {result.formulation.display}</span>
        <span className="font-mono text-[7px] text-slate-300">hover nodes for details</span>
      </div>
      <div className="relative flex-1 min-h-0 rounded-xl border border-slate-100 overflow-hidden bg-white">
        <canvas ref={canvasRef} width={440} height={300} className="w-full h-full" style={{ display: "block" }} />
        {hoveredNode && (
          <div className="absolute bottom-3 left-3 rounded-xl border border-slate-200 bg-white/95 backdrop-blur-sm px-3 py-2 shadow-md pointer-events-none">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 rounded-full" style={{ background: hoveredNode.color }} />
              <span className="font-mono text-[9px] font-semibold text-slate-700">{hoveredNode.label}</span>
            </div>
            {(() => {
              const extra = SCAFFOLD_EXTRA[result.tissue_key];
              const matRows: [string, string][] = hoveredNode.id === "GelMA" ? [["Conc", extra?.gelma ?? "—"],["Role","Photopolymer backbone"],["MW","~85 kDa"]]
                : hoveredNode.id === "Alginate" ? [["Conc", extra?.alginate ?? "—"],["Role","Hydrogel network"],["Source","Brown algae"]]
                : hoveredNode.id === "CaCl₂" ? [["Conc", extra?.cacl2 ?? "—"],["Role","Ionic crosslinker"],["Ion","Ca²⁺ 40.08 g/mol"]]
                : hoveredNode.id === "Photoinitiator" ? [["Protocol", extra?.crosslink ?? "—"],["Role","Radical initiator"],["Type","LAP / I2959"]]
                : hoveredNode.id === "Cells" ? [["Density", extra?.cells ?? "—"],["Viability 24h",`${viability["24h"]}%`],["Viability 72h",`${viability["72h"]}%`]]
                : [["Fraction", `${Math.round(hoveredNode.pct * 100)}%`]];
              return matRows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-6">
                  <span className="font-mono text-[7px] text-slate-400">{k}</span>
                  <span className="font-mono text-[7px] text-slate-700 font-medium">{v}</span>
                </div>
              ));
            })()}
          </div>
        )}
      </div>
      {/* material legend */}
      <div className="flex flex-wrap gap-2 mt-2 shrink-0">
        {(TISSUE_STACKS[result.tissue_key] ?? TISSUE_STACKS.skin_dermis).map(layer => (
          <span key={layer.mat} className="flex items-center gap-1 font-mono text-[7px] text-slate-500">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: MAT[layer.mat]?.color ?? "#94a3b8" }} />
            {MAT[layer.mat]?.label ?? layer.mat} {Math.round(layer.h * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// GENE SEQUENCE VIEWER
// ─────────────────────────────────────────────────────────────────

const CHR_LENGTHS: Record<string,number> = { "1":248,"2":243,"3":199,"4":191,"5":181,"6":171,"7":159,"8":146,"9":138,"10":134,"11":136,"12":133,"13":114,"14":107,"15":102,"16":90,"17":83,"18":80,"19":59,"20":64,"21":47,"22":51,"X":156,"Y":57 };
const EXPR_C: Record<string,string> = { overexpressed:"#3b82f6", normal:"#10b981", suppressed:"#ef4444" };

function parseChr(s:string) {
  const m=s.match(/^(\d+|X|Y)([pq])(\d+(?:\.\d+)?)?/); if (!m) return { chr:"?",band:"?",pct:50 };
  const sub=parseFloat(m[3]??"10"); return { chr:m[1], band:`${m[2]}${m[3]??""}`, pct:m[2]==="p"?sub/40*50:50+sub/40*50 };
}

function GeneSequenceViewer({ genes }: { genes: [string,string,string,string][] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {genes.map(([name,role,chr,expr])=>{
        const { chr:chrNum, band, pct: gp } = parseChr(chr);
        const color = EXPR_C[expr]??"#6b7280";
        const relW  = Math.max(50, Math.min(110, (CHR_LENGTHS[chrNum]??100)/2.4));
        return (
          <div key={name} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
            <div className="w-14 shrink-0">
              <div className="font-mono text-[9.5px] font-semibold text-slate-700">{name}</div>
              <div className="font-mono text-[6.5px] text-slate-400">{chr}</div>
            </div>
            <div className="relative h-4 rounded bg-slate-100 border border-slate-200 shrink-0" style={{ width:relW }}>
              <div className="absolute top-0 bottom-0 w-px bg-slate-400" style={{ left:"50%" }} />
              <div className="absolute top-0.5 bottom-0.5 w-2 rounded-sm" style={{ left:`calc(${gp}% - 4px)`,background:color,opacity:0.9 }} />
              <div className="absolute -bottom-3 font-mono text-[6px] text-slate-400" style={{ left:`calc(${gp}% - 5px)` }}>{band}</div>
            </div>
            <div className="flex-1 flex items-center gap-2 ml-1">
              <div className="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width:expr==="overexpressed"?"88%":expr==="normal"?"52%":"15%", background:color, opacity:0.75 }} />
              </div>
              <span className="font-mono text-[8.5px] w-20 shrink-0" style={{ color }}>{expr}</span>
            </div>
            <span className="font-mono text-[7.5px] text-slate-300 w-36 truncate shrink-0 hidden xl:block">{role}</span>
          </div>
        );
      })}
      <div className="flex gap-4 pt-2 border-t border-slate-100 flex-wrap">
        {Object.entries(EXPR_C).map(([e,c])=>(
          <span key={e} className="flex items-center gap-1 font-mono text-[7.5px] text-slate-400">
            <span className="w-2 h-2 rounded-sm" style={{ background:c,opacity:0.8 }} />{e}
          </span>
        ))}
        <span className="flex items-center gap-1 font-mono text-[7.5px] text-slate-400">
          <span className="inline-block relative bg-slate-100 rounded border border-slate-200" style={{ width:14,height:8 }}>
            <span className="absolute top-0 bottom-0 w-px bg-slate-400" style={{ left:"50%" }} />
          </span>centromere
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// RISK BANNER
// ─────────────────────────────────────────────────────────────────

// RiskBanner removed — replaced by stat pills in the tab header area


// ─────────────────────────────────────────────────────────────────
// PROPERTY TABLE
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// LONG TERM DATA
// ─────────────────────────────────────────────────────────────────

function buildLongTerm(viability: Viability, rejection: Rejection, metabolic: Metabolic) {
  const v7 = viability["7d"] / 100;
  const r   = rejection.rejection_probability;
  // Decay rate past 7d is driven by metabolic readiness and rejection pressure.
  // Better metabolic score = slower decay; higher rejection = faster decay.
  const decayRate = Math.max(0.60, 1 - (1 - metabolic.composite) * 0.25 - r * 0.18);
  const v = (factor: number) => Math.min(100, Math.max(0, Math.round(v7 * factor * 100)));
  return [
    { t:"0h",   viability:100,                          rejection:0 },
    { t:"24h",  viability:viability["24h"],              rejection:Math.round(r * 100 * 0.12) },
    { t:"72h",  viability:viability["72h"],              rejection:Math.round(r * 100 * 0.28) },
    { t:"7d",   viability:viability["7d"],               rejection:Math.round(rejection.rejection_curve.day_7 * 100) },
    { t:"14d",  viability:v(decayRate ** (7  / 30)),     rejection:Math.round(r * 100 * 0.50) },
    { t:"30d",  viability:v(decayRate ** (30 / 30)),     rejection:Math.round(rejection.rejection_curve.day_30 * 100) },
    { t:"60d",  viability:v(decayRate ** (60 / 30)),     rejection:Math.round(r * 100 * 0.72) },
    { t:"90d",  viability:v(decayRate ** (90 / 30)),     rejection:Math.round(rejection.rejection_curve.day_90 * 100) },
    { t:"180d", viability:v(decayRate ** (180 / 30)),    rejection:Math.round(rejection.rejection_curve.day_180 * 100) },
  ];
}

// ─────────────────────────────────────────────────────────────────
// AI CHAT RAIL
// ─────────────────────────────────────────────────────────────────

const INITIAL_MESSAGES: ChatMessage[] = [
  { role:"assistant", text:"Hello! I'm the Zyogen BioSim AI. Describe a patient and tissue target, or ask me about the current simulation results.", ts:0 },
];

function AIChatRail({ result, onRunSim, running }: {
  result: SimResult | null;
  onRunSim: (payload: object) => void;
  running: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastRunId = useRef<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior:"smooth" });
  }, [messages, thinking]);

  // When a new result comes in, append the AI narrative as a message
  useEffect(() => {
    if (!result || result.run_id === lastRunId.current) return;
    lastRunId.current = result.run_id;
    const msg: ChatMessage = {
      role:"assistant",
      text:`**${result.formulation.display} — ${result.stages.rejection.risk_tier.toUpperCase()} RISK**\n\n${safeStr(result.ai_output.overall_assessment)}\n\n${safeStr(result.ai_output.clinical_narrative)}`,
      ts:0,
    };
    setMessages(prev => [...prev, msg]);
  }, [result]);

  async function send() {
    const msg = input.trim(); if (!msg) return;
    setInput("");
    const newUserMsg: ChatMessage = { role:"user", text:msg, ts:Date.now() };
    setMessages(prev => [...prev, newUserMsg]);
    setThinking(true);
    try {
      // First: try to parse as a new simulation request
      const parseRes  = await fetch(`${API}/biosim/generate-payload`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ prompt:msg }) });
      const parseData = await parseRes.json();
      if (parseRes.ok && parseData.payload?.tissue_key) {
        setMessages(prev => [...prev, { role:"assistant", text:`Parsed — running simulation for ${parseData.payload.tissue_key.replace("_"," ")}...`, ts:Date.now() }]);
        onRunSim(parseData.payload);
        return;
      }

      // Second: if a simulation is loaded, answer the question against it
      if (result) {
        const history = messages.slice(-6).map(m => ({ role: m.role, content: m.text }));
        const simContext = {
          tissue: result.formulation.display,
          formulation: result.formulation,
          physics: result.stages.physics,
          viability: result.stages.viability,
          rejection: result.stages.rejection,
          metabolic: result.stages.metabolic,
          flags: result.flags,
          ai_assessment: result.ai_output.overall_assessment,
        };
        const chatRes  = await fetch(`${API}/biosim/chat`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ question:msg, sim_context:simContext, history }) });
        const chatData = await chatRes.json();
        if (chatRes.ok && chatData.answer) {
          setMessages(prev => [...prev, { role:"assistant", text:chatData.answer, ts:Date.now() }]);
          return;
        }
      }

      // No simulation loaded
      setMessages(prev => [...prev, { role:"assistant", text:"No simulation is loaded yet. Describe a patient to run one — e.g. \"female, 28, Hb 12.4, skin graft target\".", ts:Date.now() }]);
    } catch {
      setMessages(prev => [...prev, { role:"assistant", text:"Connection error — is the backend running on port 8000?", ts:Date.now() }]);
    } finally { setThinking(false); }
  }

  const QUICK = [
    { label:"Low risk demo",      msg:"Run: female 24, skin graft, Hb 13.2, glucose 88, no immune issues" },
    { label:"Cartilage demo",     msg:"Run: male 45, cartilage patch, Hb 14.1, glucose 108" },
    { label:"High risk demo",     msg:"Run: male, corneal graft, Hb 11.2, autoimmune active, prior rejection" },
    { label:"Why is rejection high?", msg:"Why is the rejection risk high in this simulation? What is driving it?" },
    { label:"Explain shear",      msg:"What does the shear stress value mean for cell viability in this result?" },
    { label:"Improve viability",  msg:"What changes would most improve the viability score for this simulation?" },
  ];

  return (
    <div className="flex flex-col h-full border-l border-slate-200 bg-white">
      {/* header */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2 shrink-0">
        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="font-mono text-[10px] text-slate-600 font-semibold">BioSim AI</span>
        <span className="font-mono text-[8px] text-slate-400 ml-auto">GPT-4o · research only</span>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 min-h-0">
        {messages.map((m,i) => (
          <div key={i} className={`flex ${m.role==="user"?"justify-end":"justify-start"}`}>
            <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-[11px] leading-relaxed ${
              m.role==="user"
                ? "bg-slate-900 text-white rounded-br-sm"
                : "bg-slate-50 border border-slate-100 text-slate-700 rounded-bl-sm"
            }`}>
              {m.text.split("\n").map((line, li) => {
                if (line.startsWith("**") && line.endsWith("**")) return <div key={li} className="font-semibold text-[10px] mb-1">{line.slice(2,-2)}</div>;
                if (line === "") return <div key={li} className="h-1.5" />;
                return <div key={li}>{line}</div>;
              })}
            </div>
          </div>
        ))}
        {(thinking || running) && (
          <div className="flex justify-start">
            <div className="bg-slate-50 border border-slate-100 rounded-2xl rounded-bl-sm px-3 py-2 flex items-center gap-2">
              <div className="flex gap-1">
                {[0,1,2].map(i=>(
                  <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay:`${i*0.15}s` }} />
                ))}
              </div>
              <span className="font-mono text-[9px] text-slate-400">{running?"simulating...":"thinking..."}</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* quick actions */}
      <div className="px-3 py-2 border-t border-slate-100 shrink-0">
        <div className="flex flex-wrap gap-1 mb-2">
          {QUICK.map(q=>(
            <button key={q.label} onClick={()=>{ setInput(q.msg); }}
              className="font-mono text-[8px] px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700 transition-colors">
              {q.label}
            </button>
          ))}
        </div>

        {/* input */}
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); } }}
            placeholder="Describe a patient or ask about results…"
            rows={2}
            className="flex-1 resize-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[11px] text-slate-700 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors leading-relaxed"
          />
          <button onClick={send} disabled={!input.trim()||thinking||running}
            className="shrink-0 w-8 h-8 rounded-xl bg-slate-900 text-white flex items-center justify-center hover:bg-slate-700 disabled:opacity-30 transition-colors mb-0.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
        <span className="font-mono text-[7.5px] text-slate-300 mt-1 block">Enter to send · Shift+Enter for new line</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────

function HistoryDropdown({ runs, onLoad }: { runs: RunListItem[]; onLoad: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`font-mono text-[9px] px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${open ? "bg-slate-900 text-white" : "text-slate-400 hover:text-slate-700 hover:bg-slate-50"}`}>
        History{runs.length > 0 && <span className="font-mono text-[7px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600">{runs.length}</span>}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-96 z-50 bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Simulation history</span>
            <span className="font-mono text-[7.5px] text-slate-300">{runs.length} runs</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {runs.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="font-mono text-[10px] text-slate-300">No runs yet</p>
              </div>
            )}
            {runs.map(r => (
              <div key={r.id} onClick={() => { onLoad(r.id); setOpen(false); }}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer group border-b border-slate-50 last:border-0 transition-colors">
                <ScaffoldDiagram tissueId={r.tissue_key} size={28} />
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="font-mono text-[9.5px] text-slate-700 truncate">{r.label}</span>
                  <span className="font-mono text-[7.5px] text-slate-400">{r.id.slice(0,8)} · {r.created_at.slice(0,16).replace("T"," ")}</span>
                </div>
                <span className="font-mono text-[8px] px-2 py-0.5 rounded-full shrink-0" style={{ background: riskBg(r.risk_tier), color: riskColor(r.risk_tier) }}>{r.risk_tier}</span>
                <span className="font-mono text-[8.5px] text-slate-400 shrink-0">v24h {fmt(r.viability_24h)}%</span>
                <span className="font-mono text-[8.5px] text-slate-300 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity">→</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Dashboard({ result, runs, onLoad }: { result: SimResult|null; runs: RunListItem[]; onLoad:(id:string)=>void }) {
  const [tab, setTab] = useState<"main"|"longterm">("main");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* tab bar */}
      <div className="shrink-0 flex items-center gap-1 px-5 pt-3 pb-2.5 border-b border-slate-100">
        {([["main","Overview & Sequence"],["longterm","Long Term"]] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`font-mono text-[9px] px-3 py-1.5 rounded-lg transition-colors ${tab===t?"bg-slate-900 text-white":"text-slate-400 hover:text-slate-700 hover:bg-slate-50"}`}>
            {label}
          </button>
        ))}
        <div className="ml-auto">
          <HistoryDropdown runs={runs} onLoad={onLoad} />
        </div>
      </div>

      {/* body — overflow-hidden, no scroll */}
      <div className="flex-1 overflow-hidden px-4 py-3 min-h-0">

        {/* empty state */}
        {!result && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-14 h-14 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"/></svg>
            </div>
            <p className="font-mono text-[10px] text-slate-400 text-center leading-relaxed">Describe a patient in the chat →<br />or use a quick demo button</p>
          </div>
        )}

        {/* ── MAIN TAB ── */}
        {result && tab === "main" && (
          <div className="h-full overflow-y-auto flex flex-col gap-3 pr-1">

            {/* Row 1: stat pills */}
            <div className="flex gap-2 shrink-0">
              {[
                { label:"Viability 24h", value:`${result.stages.viability["24h"]}%`,               color:result.stages.viability["24h"]>80?"#16a34a":"#d97706" },
                { label:"Viability 72h", value:`${result.stages.viability["72h"]}%`,               color:result.stages.viability["72h"]>70?"#16a34a":"#d97706" },
                { label:"Rejection",     value:pct(result.stages.rejection.rejection_probability),  color:riskColor(result.stages.rejection.risk_tier) },
                { label:"Print Quality", value:`${fmt(result.stages.physics.quality_score*100,0)}%`,color:result.stages.physics.quality_score>0.7?"#16a34a":"#d97706" },
                { label:"Metabolic",     value:result.stages.metabolic.readiness,                  color:readColor(result.stages.metabolic.readiness) },
                { label:"Shear",         value:`${fmt(result.stages.physics.shear_stress_pa)} Pa`,  color:result.stages.physics.shear_stress_pa<200?"#16a34a":"#d97706" },
              ].map(s => (
                <div key={s.label} className="flex-1 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 flex flex-col gap-0.5">
                  <span className="font-mono text-[6.5px] text-slate-400 uppercase tracking-widest">{s.label}</span>
                  <span className="font-mono text-[15px] font-light leading-none" style={{ color: s.color }}>{s.value}</span>
                </div>
              ))}
            </div>

            {/* Row 2: network graph (compact) + HLA side by side */}
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3 shrink-0">
              <div className="border border-slate-100 rounded-xl p-3" style={{ height: 240 }}>
                <TissueNetworkGraph result={result} viability={result.stages.viability} />
              </div>
              <div className="border border-slate-100 rounded-xl p-3">
                <HLAMap rejection={result.stages.rejection} />
              </div>
            </div>

            {/* Row 3: physics bars + scaffold rules + flags — 3 equal columns */}
            <div className="grid grid-cols-3 gap-3 shrink-0">
              <div className="border border-slate-100 rounded-xl p-3 flex flex-col gap-2">
                <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest">Physics</span>
                {[
                  { label:"Crosslink", val:result.stages.physics.crosslink_uniformity,  thresh:0.65 },
                  { label:"Shape",     val:result.stages.physics.shape_retention_score, thresh:0.70 },
                  { label:"Print Q",   val:result.stages.physics.quality_score,         thresh:0.65 },
                  { label:"Metabolic", val:result.stages.metabolic.composite,           thresh:0.60 },
                ].map(({ label, val, thresh }) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="font-mono text-[7.5px] text-slate-400 w-14 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width:`${val*100}%`, background:val>=thresh?"#3b82f6":val>=thresh*0.8?"#d97706":"#ef4444" }} />
                    </div>
                    <span className="font-mono text-[7.5px] text-slate-500 w-7 text-right">{fmt(val*100,0)}%</span>
                  </div>
                ))}
              </div>
              <div className="border border-slate-100 rounded-xl p-3 flex flex-col gap-1.5">
                <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest mb-0.5">Scaffold Rules</span>
                {[
                  ["Printability",   result.stages.physics.quality_score>0.6,        result.stages.physics.quality_score>0.6?"PASS":"FAIL"],
                  ["Viability ≥80%", !result.stages.viability.below_threshold,        result.stages.viability.below_threshold?"FAIL":"PASS"],
                  ["Rejection <50%", result.stages.rejection.rejection_probability<0.5,result.stages.rejection.rejection_probability<0.5?"PASS":"HIGH"],
                  ["Metabolic OK",   result.stages.metabolic.composite>0.5,           result.stages.metabolic.composite>0.5?"PASS":"MARGINAL"],
                ].map(([label,pass,badge])=>(
                  <div key={label as string} className="flex items-center justify-between">
                    <span className="font-mono text-[8.5px] text-slate-500">{label as string}</span>
                    <span className="font-mono text-[8px] px-2 py-0.5 rounded-full" style={{ background:pass?"#dcfce7":"#fee2e2", color:pass?"#16a34a":"#dc2626" }}>{badge as string}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1.5">
                {result.flags.length > 0 ? (
                  <>
                    <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest">Flags</span>
                    {result.flags.map((f, i) => (
                      <div key={i} className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg border text-[7.5px] font-mono"
                        style={{ background:f.severity==="error"?"#fef2f2":"#fffbeb", borderColor:f.severity==="error"?"#fecaca":"#fde68a" }}>
                        <span className="font-semibold shrink-0" style={{ color:f.severity==="error"?"#dc2626":"#92400e" }}>{f.field}</span>
                        <span className="text-slate-500 truncate">{f.flag||f.error}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <span className="font-mono text-[8px] text-slate-300">No flags</span>
                  </div>
                )}
              </div>
            </div>

            {/* Row 4: gene expression + signal traces + metabolic radar */}
            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)] gap-3 shrink-0">
              <div className="border border-slate-100 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest">Gene Expression</span>
                  <span className="font-mono text-[7px] text-slate-300">{result.genes.length} genes</span>
                </div>
                <GeneSequenceViewer genes={result.genes} />
              </div>
              <div className="border border-slate-100 rounded-xl p-3 flex flex-col gap-2">
                <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest">Signal Traces</span>
                <SimEnergyCharts viability={result.stages.viability} physics={result.stages.physics} />
              </div>
              <div className="border border-slate-100 rounded-xl p-3">
                <MetabolicRadar metabolic={result.stages.metabolic} />
              </div>
            </div>

            {/* Row 5: scaffold molecule viewer */}
            <div className="border border-slate-100 rounded-xl p-3 shrink-0">
              <ScaffoldViewer tissueKey={result.tissue_key} />
            </div>

          </div>
        )}

        {/* ── LONG TERM ── */}
        {result && tab === "longterm" && (
          <div className="h-full flex flex-col gap-3">
            <div className="border border-slate-100 rounded-xl p-4 flex flex-col gap-3 flex-1 min-h-0">
              <div className="flex items-center justify-between shrink-0">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">6-Month Viability + Rejection Model</span>
                <span className="font-mono text-[7.5px] text-slate-300">Extrapolated — not clinical</span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={buildLongTerm(result.stages.viability,result.stages.rejection,result.stages.metabolic)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="t" tick={{ fontFamily:"monospace",fontSize:9,fill:"#94a3b8" }} />
                  <YAxis domain={[0,100]} tick={{ fontFamily:"monospace",fontSize:9,fill:"#94a3b8" }} unit="%" />
                  <Tooltip contentStyle={{ fontFamily:"monospace",fontSize:10,borderRadius:10,border:"1px solid #e2e8f0" }} />
                  <Legend wrapperStyle={{ fontFamily:"monospace",fontSize:9 }} />
                  <ReferenceLine y={70} stroke="#d97706" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="viability" stroke="#3b82f6" strokeWidth={2} dot={{ r:3,fill:"#3b82f6" }} name="Viability %" />
                  <Line type="monotone" dataKey="rejection" stroke={riskColor(result.stages.rejection.risk_tier)} strokeWidth={2} dot={{ r:3 }} name="Rejection %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-3 shrink-0">
              <div className="border border-slate-100 rounded-xl p-3 flex flex-col gap-2">
                <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest">Expression Timeline</span>
                {[
                  { stage:"Stage 1",time:"0–24h",   note:"Scaffold formation. HLA suppression. Critical viability window." },
                  { stage:"Stage 2",time:"24–72h",  note:"Cell proliferation. TGFB1 immune modulation." },
                  { stage:"Stage 3",time:"3–7d",    note:"Tissue maturation. Gene normalisation." },
                  { stage:"Stage 4",time:"7–30d",   note:"Integration window. Rejection risk peaks." },
                  { stage:"Stage 5",time:"30–180d", note:"Chronic phase. HLA dominates outcome." },
                ].map((s, i) => (
                  <div key={i} className="flex gap-3 border-b border-slate-50 pb-1.5 last:border-0">
                    <div className="w-14 shrink-0">
                      <div className="font-mono text-[8.5px] text-slate-700">{s.stage}</div>
                      <div className="font-mono text-[7px] text-slate-400">{s.time}</div>
                    </div>
                    <p className="font-mono text-[7.5px] text-slate-500 leading-relaxed">{s.note}</p>
                  </div>
                ))}
              </div>
              <div className="border border-slate-100 rounded-xl p-3">
                <MetabolicRadar metabolic={result.stages.metabolic} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// COMPARE
// ─────────────────────────────────────────────────────────────────

function ComparePanel({ runs }: { runs: RunListItem[] }) {
  const [aId,setAId]=useState(""); const [bId,setBId]=useState("");
  const [loading,setLoading]=useState(false); const [result,setResult]=useState<CompareResult|null>(null); const [error,setError]=useState<string|null>(null);
  async function run() {
    if(!aId||!bId||aId===bId){setError("Select two different runs");return;}
    setLoading(true);setError(null);setResult(null);
    try {
      const res=await fetch(`${API}/biosim/compare`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({run_a_id:aId,run_b_id:bId})});
      const data=await res.json(); if(!res.ok) throw new Error(data.detail||"Compare failed");
      setResult(data);
    } catch(e:unknown){setError(e instanceof Error?e.message:"Unknown error");}
    finally{setLoading(false);}
  }
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-3">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Select two runs to compare</span>
        <div className="grid grid-cols-2 gap-3">
          {([["Run A (baseline)",aId,setAId],["Run B (modified)",bId,setBId]] as const).map(([label,val,setter])=>(
            <div key={label} className="flex flex-col gap-1">
              <span className="font-mono text-[8px] text-slate-400">{label}</span>
              <select value={val} onChange={e=>setter(e.target.value)} className="font-mono text-[10px] text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 outline-none">
                <option value="">— select run —</option>
                {runs.map(r=><option key={r.id} value={r.id}>{r.label} · {r.risk_tier} · {fmt(r.viability_24h)}%</option>)}
              </select>
            </div>
          ))}
        </div>
        {error && <span className="font-mono text-[9px] text-red-500">{error}</span>}
        <button onClick={run} disabled={loading||!aId||!bId||aId===bId}
          className="self-start font-mono text-[10px] px-4 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40 transition-colors">
          {loading?"Comparing...":"Run comparison →"}
        </button>
      </div>
      {result && (
        <div className="flex flex-col gap-3">
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
            <p className="text-[12px] text-slate-600">{safeStr(result.ai_output.overall_assessment)}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {([["Run A — Baseline",result.run_a],["Run B — Modified",result.run_b]] as [string,SimResult][]).map(([label,r])=>(
              <div key={label} className="border border-slate-200 rounded-xl p-3 flex flex-col gap-1.5">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">{label}</span>
                {[["Viability 24h",`${r.stages.viability["24h"]}%`],["Viability 72h",`${r.stages.viability["72h"]}%`],["Rejection",pct(r.stages.rejection.rejection_probability)],["Quality",`${fmt(r.stages.physics.quality_score*100,0)}%`]].map(([k,v])=>(
                  <div key={k} className="flex justify-between border-b border-slate-50 pb-1 last:border-0">
                    <span className="font-mono text-[8.5px] text-slate-400">{k}</span>
                    <span className="font-mono text-[9px] text-slate-800">{v}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="border border-slate-200 rounded-xl p-3">
            <p className="text-[12px] text-slate-600 leading-relaxed">{safeStr(result.ai_output.clinical_narrative)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────

type AppTab = "simulate" | "compare";

export default function BioSim() {
  const [result,     setResult]     = useState<SimResult|null>(null);
  const [error,      setError]      = useState<string|null>(null);
  const [appTab,     setAppTab]     = useState<AppTab>("simulate");
  const [runs,       setRuns]       = useState<RunListItem[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [copied,     setCopied]     = useState(false);

  const fetchRuns = useCallback(() => {
    fetch(`${API}/biosim/runs`).then(r=>r.ok?r.json():null).then(d=>{ if(d) setRuns(d); }).catch(()=>{});
  }, []);

  useEffect(() => { fetchRuns(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSim(payload: object) {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${API}/biosim/runs`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      const data = JSON.parse(await res.text());
      if(!res.ok) throw new Error(typeof data.detail==="string"?data.detail:JSON.stringify(data.detail));
      setResult(data); setAppTab("simulate"); fetchRuns();
    } catch(e:unknown){ setError(e instanceof Error?e.message:"Unknown error"); }
    finally{ setLoading(false); }
  }

  async function loadFromHistory(id: string) {
    try {
      const res=await fetch(`${API}/biosim/runs/${id}`); const data=await res.json();
      if(!res.ok) throw new Error(data.detail);
      setResult(data.result); setAppTab("simulate");
    } catch(e:unknown){ setError(e instanceof Error?e.message:"Unknown error"); }
  }

  return (
    <div className="h-screen flex flex-col bg-white text-slate-900 overflow-hidden" style={{ fontFamily:"system-ui,sans-serif" }}>
      {/* ── NAV ── */}
      <nav className="shrink-0 z-20 bg-white border-b border-slate-100 h-11 flex items-center px-5 justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-slate-900">Zyogen</span>
          <span className="text-slate-300">/</span>
          <span className="font-mono text-[11px] text-slate-400">BioSim</span>
          {result && (
            <span className="font-mono text-[8px] px-2 py-0.5 rounded-full ml-1"
              style={{ background:riskBg(result.stages.rejection.risk_tier), color:riskColor(result.stages.rejection.risk_tier) }}>
              {result.stages.rejection.risk_tier} · {result.formulation.display}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5">
          {(["simulate","compare"] as AppTab[]).map(t=>(
            <button key={t} onClick={()=>setAppTab(t)}
              className={`font-mono text-[9px] px-3 py-1.5 rounded-md capitalize transition-colors ${appTab===t?"bg-white text-slate-900 shadow-sm":"text-slate-400 hover:text-slate-600"}`}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="font-mono text-[9px] text-red-500 max-w-64 truncate">{error}</span>}
          {result && (
            <button onClick={()=>{ navigator.clipboard.writeText(JSON.stringify(result.spec,null,2)); setCopied(true); setTimeout(()=>setCopied(false),2000); }}
              className="font-mono text-[9px] text-slate-400 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1 transition-colors">
              {copied?"copied ✓":"copy spec"}
            </button>
          )}
          <span className="font-mono text-[8px] text-slate-300">v2 · research only</span>
        </div>
      </nav>

      {/* ── BODY: left dashboard | right AI chat ── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {appTab === "simulate" && (
          <>
            {/* LEFT — full dashboard */}
            <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
              <Dashboard result={result} runs={runs} onLoad={loadFromHistory} />
            </div>

            {/* DIVIDER */}
            <div className="w-px bg-slate-200 shrink-0" />

            {/* RIGHT — AI chat rail, fixed width */}
            <div className="w-80 shrink-0 flex flex-col min-h-0 overflow-hidden">
              <AIChatRail result={result} onRunSim={runSim} running={loading} />
            </div>
          </>
        )}

        {appTab === "compare" && (
          <div className="flex-1 overflow-y-auto">
            <ComparePanel runs={runs} />
          </div>
        )}
      </div>
    </div>
  );
}

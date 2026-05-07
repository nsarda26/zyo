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
  shear_stress_pa: number; shear_recalculated?: boolean;
  uv_penetration_depth_mm: number; filament_diameter_mm: number;
  crosslink_uniformity: number; shape_retention_score: number;
  bio_ink_viscosity_pas: number; quality_score: number;
  print_time: { n_layers: number; estimated_minutes: number; path_length_mm: number };
}
interface Viability {
  "24h": number; "72h": number; "7d": number; below_threshold: boolean;
  modifiers: { shear_stress_pa: number; hb_penalty_pct: number; glucose_penalty_pct: number; crosslink_bonus_pct: number; tissue_modifier_pct: number; net_delta_pct: number };
}
interface Rejection {
  rejection_probability: number; risk_tier: string; assumed_hla_mismatches: number; typed_hla_loci: number;
  modifiers_applied: { factor: string; delta: number }[];
  rejection_curve: { day_7: number; day_30: number; day_90: number; day_180: number };
  recommendation: string;
}
interface Metabolic {
  subscores: { oxygen_delivery: number; glycemic_stability: number; renal_clearance: number; hepatic_function: number; immune_competence: number };
  composite: number; readiness: string;
}
interface AIOutput {
  clinical_narrative: string; interaction_flags: string[];
  missing_data_warnings: string[]; monitoring_priorities: string[]; overall_assessment: string;
}
interface Flag { field: string; flag?: string; error?: string; severity: string; value?: number; normal_range?: string }
interface SimResult {
  run_id: string; tissue_key: string; spec: Record<string, unknown>; flags: Flag[];
  ai_output: AIOutput;
  stages: { physics: Physics; viability: Viability; rejection: Rejection; metabolic: Metabolic };
  genes: [string, string, string, string][];
  formulation: { display: string; cell_type: string; alginate_pct: number; gelma_pct: number; nozzle_gauge: string };
  regression_diff?: { regressions: { parameter: string; baseline: number; current: number; delta: number }[]; improvements: { parameter: string; baseline: number; current: number; delta: number }[]; has_regressions: boolean };
}
interface RunListItem { id: string; tissue_key: string; sex: string; risk_tier: string; quality_score: number; viability_24h: number; label: string; created_at: string }

type CardType = "stats" | "viability" | "rejection" | "physics" | "metabolic" | "hla" | "flags" | "longterm" | "gene";

interface InlineCard { type: CardType; title: string; result: SimResult }

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  card?: InlineCard;
  ts: number;
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

const safeStr = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(" ");
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).join(" ");
  return String(v ?? "");
};

const riskColor = (t: string) => t === "low" ? "#16a34a" : t === "moderate" ? "#d97706" : "#dc2626";
const riskBg    = (t: string) => t === "low" ? "#dcfce7" : t === "moderate" ? "#fef9c3" : "#fee2e2";
const readColor = (r: string) => ({ optimal:"#16a34a", adequate:"#2563eb", marginal:"#d97706", poor:"#dc2626" }[r] ?? "#6b7280");
const fmt       = (n: number, d = 1) => n.toFixed(d);
const pct       = (n: number) => `${Math.round(n * 100)}%`;
const uid       = () => Math.random().toString(36).slice(2);

// ─────────────────────────────────────────────────────────────────
// INLINE CARD COMPONENTS
// ─────────────────────────────────────────────────────────────────

function StatPillsCard({ result }: { result: SimResult }) {
  const pills = [
    { label:"Viability 24h", value:`${result.stages.viability["24h"]}%`,               color:result.stages.viability["24h"]>80?"#16a34a":"#d97706" },
    { label:"Viability 72h", value:`${result.stages.viability["72h"]}%`,               color:result.stages.viability["72h"]>70?"#16a34a":"#d97706" },
    { label:"Rejection",     value:pct(result.stages.rejection.rejection_probability),  color:riskColor(result.stages.rejection.risk_tier) },
    { label:"Print Quality", value:`${fmt(result.stages.physics.quality_score*100,0)}%`,color:result.stages.physics.quality_score>0.7?"#16a34a":"#d97706" },
    { label:"Metabolic",     value:result.stages.metabolic.readiness,                  color:readColor(result.stages.metabolic.readiness) },
    { label:"Shear",         value:`${fmt(result.stages.physics.shear_stress_pa)} Pa`,  color:result.stages.physics.shear_stress_pa<200?"#16a34a":"#d97706" },
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {pills.map(p => (
        <div key={p.label} className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 flex flex-col gap-0.5">
          <span className="font-mono text-[6.5px] text-slate-400 uppercase tracking-widest">{p.label}</span>
          <span className="font-mono text-[16px] font-light leading-none" style={{ color: p.color }}>{p.value}</span>
        </div>
      ))}
      {result.regression_diff?.has_regressions && (
        <div className="col-span-3 border border-amber-200 bg-amber-50 rounded-xl px-3 py-2 flex flex-col gap-1">
          <span className="font-mono text-[7px] text-amber-700 uppercase tracking-widest">Regressions vs baseline</span>
          {result.regression_diff.regressions.map(r => (
            <div key={r.parameter} className="flex justify-between font-mono text-[8.5px]">
              <span className="text-slate-600">{r.parameter}</span>
              <span className="text-red-600">{r.baseline} → {r.current} ({r.delta > 0 ? "+" : ""}{r.delta})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ViabilityCard({ result }: { result: SimResult }) {
  const v = result.stages.viability;
  const data = [
    { t:"0h",   val:100 },
    { t:"24h",  val:v["24h"] },
    { t:"72h",  val:v["72h"] },
    { t:"7d",   val:v["7d"] },
  ];
  return (
    <div className="flex flex-col gap-2">
      <ResponsiveContainer width="100%" height={110}>
        <AreaChart data={data} margin={{ top:4,right:4,bottom:0,left:-20 }}>
          <defs>
            <linearGradient id="vgrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
          <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} />
          <YAxis domain={[40,100]} tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} />
          <ReferenceLine y={80} stroke="#d97706" strokeDasharray="3 3" label={{ value:"80% target", fontSize:7, fill:"#d97706", fontFamily:"monospace" }} />
          <Area type="monotone" dataKey="val" stroke="#8b5cf6" strokeWidth={2} fill="url(#vgrad)" dot={{ r:3, fill:"#8b5cf6" }} />
          <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:9, borderRadius:8 }} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex gap-2">
        {[["24h", v["24h"], 80], ["72h", v["72h"], 70], ["7d", v["7d"], 60]].map(([t, val, thresh]) => (
          <div key={t as string} className="flex-1 text-center">
            <div className="font-mono text-[16px] font-light" style={{ color: (val as number) >= (thresh as number) ? "#16a34a" : "#d97706" }}>{val as number}%</div>
            <div className="font-mono text-[7px] text-slate-400">{t as string}</div>
          </div>
        ))}
      </div>
      {v.below_threshold && <p className="font-mono text-[8px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">Below threshold — review print parameters and patient candidacy.</p>}
    </div>
  );
}

function RejectionCard({ result }: { result: SimResult }) {
  const rej = result.stages.rejection;
  const rc = riskColor(rej.risk_tier);
  const curve = [
    { t:"7d",   val: Math.round(rej.rejection_curve.day_7*100) },
    { t:"30d",  val: Math.round(rej.rejection_curve.day_30*100) },
    { t:"90d",  val: Math.round(rej.rejection_curve.day_90*100) },
    { t:"180d", val: Math.round(rej.rejection_curve.day_180*100) },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[20px] font-light" style={{ color: rc }}>{pct(rej.rejection_probability)}</span>
        <span className="font-mono text-[9px] px-2 py-0.5 rounded-full" style={{ background: riskBg(rej.risk_tier), color: rc }}>{rej.risk_tier}</span>
        <span className="font-mono text-[8px] text-slate-400 ml-auto">{rej.assumed_hla_mismatches} HLA mismatches</span>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={curve} margin={{ top:4,right:4,bottom:0,left:-20 }}>
          <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} />
          <YAxis domain={[0,100]} tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} />
          <Line type="monotone" dataKey="val" stroke={rc} strokeWidth={2} dot={{ r:3, fill:rc }} />
          <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:9, borderRadius:8 }} />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-1">
        {(rej.modifiers_applied ?? []).map((m, i) => (
          <span key={i} className="font-mono text-[7.5px] px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded-full text-slate-500">{m.factor} +{fmt(m.delta*100,0)}%</span>
        ))}
      </div>
      <p className="font-mono text-[8.5px] text-slate-500 leading-snug">{rej.recommendation}</p>
    </div>
  );
}

function PhysicsCard({ result }: { result: SimResult }) {
  const ph = result.stages.physics;
  const rows = [
    { label:"Shear Stress",      value:`${fmt(ph.shear_stress_pa)} Pa`,       ok: ph.shear_stress_pa < 200 },
    { label:"UV Depth",          value:`${fmt(ph.uv_penetration_depth_mm,3)} mm`, ok: true },
    { label:"Filament Dia.",     value:`${fmt(ph.filament_diameter_mm,3)} mm`,ok: true },
    { label:"Crosslink Unif.",   value:pct(ph.crosslink_uniformity),          ok: ph.crosslink_uniformity > 0.65 },
    { label:"Shape Retention",   value:pct(ph.shape_retention_score),         ok: ph.shape_retention_score > 0.70 },
    { label:"Viscosity",         value:`${ph.bio_ink_viscosity_pas} Pa·s`,    ok: true },
    { label:"Print Time",        value:`${ph.print_time.estimated_minutes} min`, ok: true },
    { label:"Quality Score",     value:`${fmt(ph.quality_score*100,1)}%`,     ok: ph.quality_score > 0.65 },
  ];
  return (
    <div className="flex flex-col gap-1">
      {rows.map(r => (
        <div key={r.label} className="flex items-center justify-between border-b border-slate-50 py-1 last:border-0">
          <span className="font-mono text-[8.5px] text-slate-500">{r.label}</span>
          <span className="font-mono text-[9px] font-semibold" style={{ color: r.ok ? "#16a34a" : "#d97706" }}>{r.value}</span>
        </div>
      ))}
      {ph.shear_recalculated === false && (
        <p className="font-mono text-[7.5px] text-blue-500 bg-blue-50 border border-blue-100 rounded-lg px-2 py-1 mt-1">Shear carried from previous run — nozzle/pressure unchanged.</p>
      )}
    </div>
  );
}

function MetabolicCard({ result }: { result: SimResult }) {
  const m = result.stages.metabolic;
  const rc = readColor(m.readiness);
  const data = [
    { subject:"O2",      A: m.subscores.oxygen_delivery*100 },
    { subject:"Glycemic",A: m.subscores.glycemic_stability*100 },
    { subject:"Renal",   A: m.subscores.renal_clearance*100 },
    { subject:"Hepatic", A: m.subscores.hepatic_function*100 },
    { subject:"Immune",  A: m.subscores.immune_competence*100 },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[18px] font-light" style={{ color: rc }}>{fmt(m.composite*100,1)}%</span>
        <span className="font-mono text-[9px] px-2 py-0.5 rounded-full" style={{ background: rc+"20", color: rc, border:`1px solid ${rc}40` }}>{m.readiness}</span>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <RadarChart data={data} margin={{ top:4,right:16,bottom:4,left:16 }}>
          <PolarGrid stroke="#f1f5f9" />
          <PolarAngleAxis dataKey="subject" tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} />
          <PolarRadiusAxis domain={[0,100]} tick={false} axisLine={false} />
          <Radar dataKey="A" stroke={rc} fill={rc} fillOpacity={0.12} strokeWidth={1.5} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function HLACard({ result }: { result: SimResult }) {
  const rej = result.stages.rejection;
  const mm = rej.assumed_hla_mismatches ?? 4;
  const loci = ["HLA-A","HLA-B","HLA-DR","HLA-C","HLA-DQ","HLA-DP"];
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1.5">
        {loci.map((locus, i) => {
          const mismatch = i < 3 && mm > i;
          const future = i >= 3;
          return (
            <div key={locus} className="flex flex-col items-center gap-0.5">
              <div className={`w-full h-7 rounded-lg flex items-center justify-center font-mono text-[9px] font-medium border ${
                future ? "border-dashed border-slate-200 text-slate-300"
                : mismatch ? "bg-red-50 border-red-200 text-red-600"
                : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{locus}</div>
              <span className="font-mono text-[6.5px] text-slate-400">{future?"v2":mismatch?"mismatch":"matched"}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width:`${rej.rejection_probability*100}%`, background:riskColor(rej.risk_tier) }} />
        </div>
        <span className="font-mono text-[10px]" style={{ color:riskColor(rej.risk_tier) }}>{pct(rej.rejection_probability)} risk</span>
      </div>
    </div>
  );
}

function FlagsCard({ result }: { result: SimResult }) {
  if (result.flags.length === 0) return <p className="font-mono text-[9px] text-slate-400">No flags raised.</p>;
  return (
    <div className="flex flex-col gap-1">
      {result.flags.map((f, i) => (
        <div key={i} className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg border text-[8px] font-mono"
          style={{ background:f.severity==="error"?"#fef2f2":"#fffbeb", borderColor:f.severity==="error"?"#fecaca":"#fde68a" }}>
          <span className="font-semibold shrink-0" style={{ color:f.severity==="error"?"#dc2626":"#92400e" }}>{f.field}</span>
          <span className="text-slate-600">{f.flag||f.error}</span>
        </div>
      ))}
    </div>
  );
}

function buildLongTerm(viability: Viability, rejection: Rejection, metabolic: Metabolic) {
  const v7 = viability["7d"] / 100;
  const r   = rejection.rejection_probability;
  const decayRate = Math.max(0.60, 1 - (1 - metabolic.composite) * 0.25 - r * 0.18);
  const v = (factor: number) => Math.min(100, Math.max(0, Math.round(v7 * factor * 100)));
  return [
    { t:"0h",   viability:100,                         rejection:0 },
    { t:"24h",  viability:viability["24h"],             rejection:Math.round(r*100*0.12) },
    { t:"72h",  viability:viability["72h"],             rejection:Math.round(r*100*0.28) },
    { t:"7d",   viability:viability["7d"],              rejection:Math.round(rejection.rejection_curve.day_7*100) },
    { t:"14d",  viability:v(decayRate**(7/30)),         rejection:Math.round(r*100*0.50) },
    { t:"30d",  viability:v(decayRate**(30/30)),        rejection:Math.round(rejection.rejection_curve.day_30*100) },
    { t:"60d",  viability:v(decayRate**(60/30)),        rejection:Math.round(r*100*0.72) },
    { t:"90d",  viability:v(decayRate**(90/30)),        rejection:Math.round(rejection.rejection_curve.day_90*100) },
    { t:"180d", viability:v(decayRate**(180/30)),       rejection:Math.round(rejection.rejection_curve.day_180*100) },
  ];
}

function LongTermCard({ result }: { result: SimResult }) {
  const data = buildLongTerm(result.stages.viability, result.stages.rejection, result.stages.metabolic);
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top:4,right:4,bottom:0,left:-20 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
        <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} />
        <YAxis domain={[0,100]} tick={{ fontFamily:"monospace", fontSize:8, fill:"#94a3b8" }} unit="%" />
        <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:9, borderRadius:8 }} />
        <Legend wrapperStyle={{ fontFamily:"monospace", fontSize:8 }} />
        <ReferenceLine y={70} stroke="#d97706" strokeDasharray="3 3" />
        <Line type="monotone" dataKey="viability" stroke="#3b82f6" strokeWidth={2} dot={{ r:2,fill:"#3b82f6" }} name="Viability %" />
        <Line type="monotone" dataKey="rejection" stroke={riskColor(result.stages.rejection.risk_tier)} strokeWidth={2} dot={{ r:2 }} name="Rejection %" />
      </LineChart>
    </ResponsiveContainer>
  );
}

const CHR_LENGTHS: Record<string,number> = { "1":248,"2":243,"3":199,"4":191,"5":181,"6":171,"7":159,"8":146,"9":138,"10":134,"11":136,"12":133,"13":114,"14":107,"15":102,"16":90,"17":83,"18":80,"19":59,"20":64,"21":47,"22":51,"X":156,"Y":57 };
const EXPR_C: Record<string,string> = { overexpressed:"#3b82f6", normal:"#10b981", suppressed:"#ef4444" };

function parseChr(s: string) {
  const m = s.match(/^(\d+|X|Y)([pq])(\d+(?:\.\d+)?)?/); if (!m) return { chr:"?", band:"?", pct:50 };
  const sub = parseFloat(m[3] ?? "10"); return { chr:m[1], band:`${m[2]}${m[3]??""}`, pct:m[2]==="p"?sub/40*50:50+sub/40*50 };
}

function GeneCard({ result, onSelectGene }: { result: SimResult; onSelectGene: (gene: string) => void }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      {result.genes.map(([name, role, chr, expr]) => {
        const { band, pct: gp } = parseChr(chr);
        const color = EXPR_C[expr] ?? "#6b7280";
        const relW  = Math.max(50, Math.min(110, (CHR_LENGTHS[chr.replace(/[pq].*/,"")] ?? 100) / 2.4));
        return (
          <div key={name}
            className={`flex items-center gap-3 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${active===name?"bg-slate-100":"hover:bg-slate-50"}`}
            onClick={() => { setActive(name); onSelectGene(name); }}>
            <div className="w-14 shrink-0">
              <div className="font-mono text-[9.5px] font-semibold text-slate-700">{name}</div>
              <div className="font-mono text-[6.5px] text-slate-400">{chr}</div>
            </div>
            <div className="relative h-4 rounded bg-slate-100 border border-slate-200 shrink-0" style={{ width:relW }}>
              <div className="absolute top-0 bottom-0 w-px bg-slate-400" style={{ left:"50%" }} />
              <div className="absolute top-0.5 bottom-0.5 w-2 rounded-sm" style={{ left:`calc(${gp}% - 4px)`, background:color, opacity:0.9 }} />
              <div className="absolute -bottom-3 font-mono text-[6px] text-slate-400" style={{ left:`calc(${gp}% - 5px)` }}>{band}</div>
            </div>
            <div className="flex-1 flex items-center gap-2 ml-1">
              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width:expr==="overexpressed"?"88%":expr==="normal"?"52%":"15%", background:color, opacity:0.75 }} />
              </div>
              <span className="font-mono text-[8px] w-20 shrink-0" style={{ color }}>{expr}</span>
            </div>
            <span className="font-mono text-[7px] text-slate-400 truncate hidden xl:block">{role}</span>
          </div>
        );
      })}
      <div className="flex gap-3 pt-1.5 border-t border-slate-100 flex-wrap">
        {Object.entries(EXPR_C).map(([e,c]) => (
          <span key={e} className="flex items-center gap-1 font-mono text-[7px] text-slate-400">
            <span className="w-2 h-2 rounded-sm" style={{ background:c, opacity:0.8 }} />{e}
          </span>
        ))}
        <span className="font-mono text-[7px] text-slate-400 ml-auto">Click gene to view 3D structure</span>
      </div>
    </div>
  );
}

function InlineCardWrapper({ card, result, onSelectGene }: { card: InlineCard; result: SimResult; onSelectGene: (gene: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="border border-slate-100 rounded-2xl overflow-hidden mt-1">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 transition-colors">
        <span className="font-mono text-[8.5px] text-slate-500 uppercase tracking-widest">{card.title}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition:"transform 0.15s" }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {!collapsed && (
        <div className="p-3">
          {card.type === "stats"    && <StatPillsCard result={result} />}
          {card.type === "viability"&& <ViabilityCard result={result} />}
          {card.type === "rejection"&& <RejectionCard result={result} />}
          {card.type === "physics"  && <PhysicsCard result={result} />}
          {card.type === "metabolic"&& <MetabolicCard result={result} />}
          {card.type === "hla"      && <HLACard result={result} />}
          {card.type === "flags"    && <FlagsCard result={result} />}
          {card.type === "longterm" && <LongTermCard result={result} />}
          {card.type === "gene"     && <GeneCard result={result} onSelectGene={onSelectGene} />}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// NGL PROTEIN VIEWER (right sidebar)
// ─────────────────────────────────────────────────────────────────

// PDB IDs for each gene — from RCSB
const GENE_PDB: Record<string, { pdb: string; name: string; desc: string }> = {
  "COL1A1": { pdb:"1CGD", name:"Collagen I alpha-1", desc:"Triple helix ECM scaffold protein" },
  "COL1A2": { pdb:"1BKV", name:"Collagen I alpha-2", desc:"ECM fibrillar collagen chain" },
  "MMP1":   { pdb:"966C", name:"Matrix metallopeptidase-1", desc:"Collagenase, ECM remodeling enzyme" },
  "TGFB1":  { pdb:"1KLA", name:"TGF-beta 1", desc:"Immune modulation and tissue repair" },
  "HLA-A":  { pdb:"1HHH", name:"HLA class I antigen A", desc:"MHC I — suppressed in scaffold" },
  "HLA-B":  { pdb:"1A1M", name:"HLA class I antigen B", desc:"MHC I — antigen presentation" },
  "KRT14":  { pdb:"3TNU", name:"Keratin-14", desc:"Basal layer intermediate filament" },
  "KRT1":   { pdb:"6E2V", name:"Keratin-1", desc:"Suprabasal differentiation filament" },
  "FLG":    { pdb:"6XRZ", name:"Filaggrin", desc:"Skin barrier formation protein" },
  "DSG1":   { pdb:"3BFN", name:"Desmoglein-1", desc:"Desmosomal cell-cell adhesion" },
  "ACAN":   { pdb:"1O9Q", name:"Aggrecan core", desc:"Load-bearing cartilage proteoglycan" },
  "COL2A1": { pdb:"1QSU", name:"Collagen II alpha-1", desc:"Cartilage-specific fibrillar collagen" },
  "SOX9":   { pdb:"4EWS", name:"SOX-9 HMG domain", desc:"Chondrogenesis transcription factor" },
  "COMP":   { pdb:"1FBM", name:"COMP pentamer", desc:"Cartilage matrix oligomeric protein" },
  "KRT3":   { pdb:"3TNU", name:"Keratin-3", desc:"Corneal epithelial marker" },
  "PAX6":   { pdb:"6PAX", name:"PAX6 paired domain", desc:"Corneal development regulator" },
  "TP63":   { pdb:"3US1", name:"p63 DNA-binding", desc:"Limbal stem cell maintenance" },
  "MUC16":  { pdb:"3O9Y", name:"MUC16 SEA domain", desc:"Ocular surface barrier mucin" },
};

type NglReprMode = "cartoon" | "ball+stick" | "surface";

function NGLViewer({ geneName, tissueKey }: { geneName: string | null; tissueKey: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef     = useRef<unknown>(null);
  const compRef      = useRef<unknown>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [info, setInfo]         = useState<{ name: string; desc: string; pdb: string } | null>(null);
  const [reprMode, setReprMode] = useState<NglReprMode>("cartoon");
  const [tooltip, setTooltip]   = useState<{ text: string; x: number; y: number } | null>(null);

  const applyRepresentation = useCallback((comp: unknown, mode: NglReprMode) => {
    const c = comp as { removeAllRepresentations: () => void; addRepresentation: (t: string, o: Record<string,unknown>) => void; autoView: (n: number) => void };
    c.removeAllRepresentations();
    if (mode === "cartoon") {
      c.addRepresentation("cartoon", { colorScheme:"sstruc", smoothSheet:true, opacity:0.95, aspectRatio:5, subdiv:12 });
      c.addRepresentation("ball+stick", { sele:"hetero and not water", colorScheme:"element", radius:0.25, opacity:0.85 });
      c.addRepresentation("surface", { colorScheme:"electrostatic", opacity:0.05, useWorker:false });
    } else if (mode === "ball+stick") {
      c.addRepresentation("ball+stick", { colorScheme:"element", radius:0.3, bondScale:0.25, opacity:0.95 });
      c.addRepresentation("cartoon", { colorScheme:"chainindex", smoothSheet:true, opacity:0.25 });
    } else {
      c.addRepresentation("surface", { colorScheme:"electrostatic", opacity:0.82, useWorker:false });
      c.addRepresentation("cartoon", { colorScheme:"sstruc", smoothSheet:true, opacity:0.12 });
    }
    c.autoView(300);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function init() {
      if (!containerRef.current) return;
      const NGL = (await import("ngl")).default ?? (await import("ngl"));
      if (cancelled) return;

      if (stageRef.current) { (stageRef.current as { dispose: () => void }).dispose(); stageRef.current = null; }
      compRef.current = null;

      const geneKey = geneName ?? (() => {
        if (!tissueKey) return null;
        const defaults: Record<string, string> = { skin_dermis:"COL1A1", skin_epidermis:"KRT14", cartilage:"COL2A1", corneal:"PAX6" };
        return defaults[tissueKey] ?? null;
      })();
      if (!geneKey) return;

      const entry = GENE_PDB[geneKey];
      if (!entry) { setError(`No PDB entry for ${geneKey}`); return; }

      setInfo(entry);
      setLoading(true);
      setError(null);

      try {
        const stage = new NGL.Stage(containerRef.current, {
          backgroundColor: "#090c12",
          fogNear: 85, fogFar: 100,
          cameraType: "perspective",
          lightColor: 0xffffff, lightIntensity: 0.9,
          ambientColor: 0x404060, ambientIntensity: 0.6,
        });
        stageRef.current = stage;

        const url = `https://files.rcsb.org/download/${entry.pdb}.pdb`;
        const comp = await stage.loadFile(url, { defaultRepresentation: false });
        if (cancelled) return;
        compRef.current = comp;

        applyRepresentation(comp, reprMode);

        // Rich hover tooltip
        stage.signals.hovered.add((pp: unknown) => {
          if (!pp) { setTooltip(null); return; }
          const p = pp as {
            atom?: { resname: string; resno: number; chainname: string; element: string };
            bond?: { atom1: { resname: string; resno: number }; atom2: { resname: string; resno: number } };
            mouse?: { position: { x: number; y: number } };
          };
          const pos = p.mouse?.position;
          if (p.atom && pos) {
            const SS_NAMES: Record<string, string> = { "HIS":"Histidine","ALA":"Alanine","GLY":"Glycine","VAL":"Valine","LEU":"Leucine","ILE":"Isoleucine","PRO":"Proline","PHE":"Phenylalanine","TRP":"Tryptophan","MET":"Methionine","SER":"Serine","THR":"Threonine","CYS":"Cysteine","TYR":"Tyrosine","ASN":"Asparagine","GLN":"Glutamine","ASP":"Aspartate","GLU":"Glutamate","LYS":"Lysine","ARG":"Arginine" };
            const name = SS_NAMES[p.atom.resname] ?? p.atom.resname;
            setTooltip({ text:`${name} ${p.atom.resno}  ·  Chain ${p.atom.chainname}  ·  ${p.atom.element}`, x: pos.x, y: pos.y });
          } else {
            setTooltip(null);
          }
        });
      } catch {
        if (!cancelled) setError(`Failed to load ${entry.pdb} from RCSB`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
      if (stageRef.current) { (stageRef.current as { dispose: () => void }).dispose(); stageRef.current = null; }
    };
  }, [geneName, tissueKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply representation when mode changes without reloading PDB
  useEffect(() => {
    if (compRef.current) applyRepresentation(compRef.current, reprMode);
  }, [reprMode, applyRepresentation]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (stageRef.current) (stageRef.current as { handleResize: () => void }).handleResize();
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const REPR_BUTTONS: { id: NglReprMode; label: string }[] = [
    { id:"cartoon",    label:"Ribbon" },
    { id:"ball+stick", label:"Ball+Stick" },
    { id:"surface",    label:"Surface" },
  ];

  // Derived secondary-structure legend (always shown when loaded)
  const SS_LEGEND = [
    { color:"#4ade80", label:"Helix (α)" },
    { color:"#facc15", label:"Sheet (β)" },
    { color:"#94a3b8", label:"Loop / coil" },
    { color:"#f97316", label:"Heteroatom" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div className="px-3 py-2.5 border-b border-slate-100 shrink-0">
        <div className="font-mono text-[8px] text-slate-400 uppercase tracking-widest mb-0.5">3D Structure</div>
        {info ? (
          <div className="flex flex-col gap-0.5">
            <div className="font-mono text-[10.5px] font-semibold text-slate-800 leading-tight">{geneName ?? "—"} <span className="text-slate-300 font-normal">PDB:{info.pdb}</span></div>
            <div className="font-mono text-[8px] text-slate-400 leading-snug">{info.desc}</div>
          </div>
        ) : (
          <div className="font-mono text-[9px] text-slate-400">Select a gene from the chat</div>
        )}
      </div>

      {/* repr toggle */}
      {info && (
        <div className="flex gap-0.5 px-3 py-1.5 border-b border-slate-100 shrink-0">
          {REPR_BUTTONS.map(b => (
            <button key={b.id} onClick={() => setReprMode(b.id)}
              className={`font-mono text-[7.5px] px-2 py-1 rounded-lg transition-colors flex-1 ${reprMode===b.id?"bg-slate-900 text-white":"text-slate-400 hover:text-slate-700 hover:bg-slate-50"}`}>
              {b.label}
            </button>
          ))}
        </div>
      )}

      {/* viewer */}
      <div className="flex-1 relative min-h-0 bg-[#090c12]" onMouseLeave={() => setTooltip(null)}>
        <div ref={containerRef} className="w-full h-full" />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-slate-600 border-t-indigo-400 rounded-full animate-spin" />
              <span className="font-mono text-[8px] text-slate-500">Loading {info?.pdb} from RCSB...</span>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="font-mono text-[8px] text-red-400 px-3 text-center">{error}</span>
          </div>
        )}
        {/* SS legend overlay — top-right corner */}
        {info && !loading && !error && reprMode === "cartoon" && (
          <div className="absolute top-2 right-2 flex flex-col gap-0.5 bg-black/50 rounded-lg px-2 py-1.5 pointer-events-none">
            {SS_LEGEND.map(l => (
              <div key={l.label} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: l.color, opacity: 0.85 }} />
                <span className="font-mono text-[6.5px] text-white/70">{l.label}</span>
              </div>
            ))}
          </div>
        )}
        {/* hover tooltip */}
        {tooltip && (
          <div className="absolute font-mono text-[8px] bg-black/85 text-white px-2.5 py-1.5 rounded-lg pointer-events-none border border-white/10 shadow-lg whitespace-nowrap"
            style={{ left: tooltip.x + 14, top: tooltip.y - 8 }}>
            {tooltip.text}
          </div>
        )}
      </div>

      {/* footer legend */}
      {info && !loading && !error && (
        <div className="px-3 py-2 border-t border-slate-100 shrink-0">
          <div className="font-mono text-[7px] text-slate-400 leading-relaxed">{info.name}</div>
          <div className="font-mono text-[6.5px] text-slate-300 mt-0.5">
            {reprMode === "cartoon" && "Color = secondary structure · Orange = ligands/heteroatoms"}
            {reprMode === "ball+stick" && "Color = element · CPK coloring — C grey, O red, N blue, S yellow"}
            {reprMode === "surface" && "Color = electrostatic potential · Blue = +charge, Red = −charge"}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// LIVE GRAPHS PANEL (right sidebar bottom half)
// ─────────────────────────────────────────────────────────────────

function LiveGraphsPanel({ result }: { result: SimResult | null }) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-slate-100 shrink-0 flex items-center justify-between">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Live Metrics</span>
        {result && <span className="font-mono text-[7px] text-slate-300 truncate max-w-[90px]">{result.formulation.display}</span>}
      </div>
      {!result ? (
        <div className="flex items-center justify-center flex-1">
          <span className="font-mono text-[9px] text-slate-300">Run a simulation</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-4">
          <GraphSection label="Viability"><ViabilityLive result={result} /></GraphSection>
          <GraphSection label="Rejection"><RejectionLive result={result} /></GraphSection>
          <GraphSection label="Metabolic"><MetabolicLive result={result} /></GraphSection>
          <GraphSection label="Physics"><PhysicsLive result={result} /></GraphSection>
        </div>
      )}
    </div>
  );
}

function GraphSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[7px] text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-1">{label}</span>
      {children}
    </div>
  );
}

function ViabilityLive({ result }: { result: SimResult }) {
  const v = result.stages.viability;
  const data = [
    { t:"0h",  val:100 },
    { t:"24h", val:v["24h"] },
    { t:"72h", val:v["72h"] },
    { t:"7d",  val:v["7d"] },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-3">
        {(["24h","72h","7d"] as const).map(k => (
          <div key={k} className="flex flex-col">
            <span className="font-mono text-[15px] font-light leading-none" style={{ color: v[k]>=(k==="24h"?80:k==="72h"?70:60)?"#16a34a":"#d97706" }}>{v[k]}%</span>
            <span className="font-mono text-[7px] text-slate-400">{k}</span>
          </div>
        ))}
        {v.below_threshold && <span className="ml-auto font-mono text-[7px] text-amber-500 self-center">below target</span>}
      </div>
      <ResponsiveContainer width="100%" height={90}>
        <AreaChart data={data} margin={{ top:4, right:4, bottom:0, left:-22 }}>
          <defs>
            <linearGradient id="lvg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
          <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:7, fill:"#94a3b8" }} />
          <YAxis domain={[40,100]} tick={{ fontFamily:"monospace", fontSize:7, fill:"#94a3b8" }} unit="%" />
          <ReferenceLine y={80} stroke="#d97706" strokeDasharray="3 3" />
          <Area type="monotone" dataKey="val" stroke="#8b5cf6" strokeWidth={2} fill="url(#lvg)" dot={{ r:2.5, fill:"#8b5cf6" }} name="Viability" />
          <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:9, borderRadius:8 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RejectionLive({ result }: { result: SimResult }) {
  const rej = result.stages.rejection;
  const rc = riskColor(rej.risk_tier);
  const curve = [
    { t:"7d",   val: Math.round(rej.rejection_curve.day_7*100) },
    { t:"30d",  val: Math.round(rej.rejection_curve.day_30*100) },
    { t:"90d",  val: Math.round(rej.rejection_curve.day_90*100) },
    { t:"180d", val: Math.round(rej.rejection_curve.day_180*100) },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[18px] font-light" style={{ color:rc }}>{pct(rej.rejection_probability)}</span>
        <span className="font-mono text-[8px] px-2 py-0.5 rounded-full" style={{ background:riskBg(rej.risk_tier), color:rc }}>{rej.risk_tier}</span>
        <span className="font-mono text-[7px] text-slate-400 ml-auto">{rej.assumed_hla_mismatches} HLA mm</span>
      </div>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={curve} margin={{ top:4, right:4, bottom:0, left:-22 }}>
          <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
          <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:7, fill:"#94a3b8" }} />
          <YAxis domain={[0,100]} tick={{ fontFamily:"monospace", fontSize:7, fill:"#94a3b8" }} unit="%" />
          <Line type="monotone" dataKey="val" stroke={rc} strokeWidth={2} dot={{ r:2.5, fill:rc }} name="Rejection %" />
          <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:9, borderRadius:8 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function MetabolicLive({ result }: { result: SimResult }) {
  const m = result.stages.metabolic;
  const rc = readColor(m.readiness);
  const data = [
    { subject:"O2",      A: m.subscores.oxygen_delivery*100 },
    { subject:"Glycemic",A: m.subscores.glycemic_stability*100 },
    { subject:"Renal",   A: m.subscores.renal_clearance*100 },
    { subject:"Hepatic", A: m.subscores.hepatic_function*100 },
    { subject:"Immune",  A: m.subscores.immune_competence*100 },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[18px] font-light" style={{ color:rc }}>{fmt(m.composite*100,1)}%</span>
        <span className="font-mono text-[8px] px-2 py-0.5 rounded-full" style={{ background:rc+"20", color:rc, border:`1px solid ${rc}40` }}>{m.readiness}</span>
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <RadarChart data={data} margin={{ top:4, right:14, bottom:4, left:14 }}>
          <PolarGrid stroke="#f1f5f9" />
          <PolarAngleAxis dataKey="subject" tick={{ fontFamily:"monospace", fontSize:7, fill:"#94a3b8" }} />
          <PolarRadiusAxis domain={[0,100]} tick={false} axisLine={false} />
          <Radar dataKey="A" stroke={rc} fill={rc} fillOpacity={0.15} strokeWidth={1.5} />
          <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:9, borderRadius:8 }} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function PhysicsLive({ result }: { result: SimResult }) {
  const ph = result.stages.physics;
  const bars = [
    { label:"Crosslink",  val:ph.crosslink_uniformity,   thresh:0.65, color:"#3b82f6" },
    { label:"Shape",      val:ph.shape_retention_score,  thresh:0.70, color:"#8b5cf6" },
    { label:"Print Q",    val:ph.quality_score,          thresh:0.65, color:"#10b981" },
    { label:"Metabolic",  val:result.stages.metabolic.composite, thresh:0.60, color:"#f59e0b" },
  ];
  return (
    <div className="flex flex-col gap-2">
      {bars.map(b => (
        <div key={b.label} className="flex flex-col gap-0.5">
          <div className="flex justify-between items-center">
            <span className="font-mono text-[7.5px] text-slate-500">{b.label}</span>
            <span className="font-mono text-[8px] font-semibold" style={{ color: b.val>=b.thresh?b.color:"#d97706" }}>{fmt(b.val*100,1)}%</span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width:`${b.val*100}%`, background: b.val>=b.thresh?b.color:"#d97706" }} />
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-0.5 border-t border-slate-100 pt-2 mt-1">
        {[
          ["Shear",    `${fmt(ph.shear_stress_pa)} Pa`,            ph.shear_stress_pa < 200],
          ["UV depth", `${fmt(ph.uv_penetration_depth_mm,3)} mm`,  true],
          ["Filament", `${fmt(ph.filament_diameter_mm,3)} mm`,     true],
          ["Viscosity",`${ph.bio_ink_viscosity_pas} Pa·s`,         true],
          ["Layers",   `${ph.print_time.n_layers}`,                true],
          ["Est. time",`${ph.print_time.estimated_minutes} min`,   true],
        ].map(([label,val,ok]) => (
          <div key={label as string} className="flex justify-between">
            <span className="font-mono text-[7px] text-slate-400">{label as string}</span>
            <span className="font-mono text-[7.5px]" style={{ color: ok?"#16a34a":"#d97706" }}>{val as string}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// CHAT — MAIN AREA
// ─────────────────────────────────────────────────────────────────

const INIT_MSG: ChatMsg = {
  id: "init",
  role: "assistant",
  text: "BioSim AI — describe a patient and tissue target to run a simulation, or ask about a loaded result. You can also say \"show viability\", \"show rejection\", or ask me to change a parameter.",
  ts: 0,
};

function ChatMain({
  onSelectGene, activeResult, onResultChange,
}: {
  onSelectGene: (gene: string) => void;
  activeResult: SimResult | null;
  onResultChange: (r: SimResult) => void;
}) {
  const [messages, setMessages]   = useState<ChatMsg[]>([INIT_MSG]);
  const [input, setInput]         = useState("");
  const [thinking, setThinking]   = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastRunId = useRef<string | null>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages, thinking]);

  // Auto-post narrative when new result arrives
  useEffect(() => {
    if (!activeResult || activeResult.run_id === lastRunId.current) return;
    lastRunId.current = activeResult.run_id;
    const narrative = safeStr(activeResult.ai_output.overall_assessment);
    const statsCard: InlineCard = { type:"stats", title:`${activeResult.formulation.display} — Summary`, result: activeResult };
    setMessages(prev => [
      ...prev,
      { id:uid(), role:"assistant", text:narrative, card:statsCard, ts:Date.now() },
    ]);
  }, [activeResult]);

  async function send() {
    const msg = input.trim(); if (!msg) return;
    setInput("");
    setMessages(prev => [...prev, { id:uid(), role:"user", text:msg, ts:Date.now() }]);
    setThinking(true);

    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.text }));
      const res  = await fetch(`${API}/biosim/agent`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ message:msg, current_run_id: activeResult?.run_id ?? null, history }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.detail;
        const msg = typeof detail === "string" ? detail
          : Array.isArray(detail) ? detail.map((e: {loc?: unknown[]; msg?: string}) => `${(e.loc??[]).slice(-1)[0]}: ${e.msg}`).join(", ")
          : JSON.stringify(detail);
        throw new Error(`Agent error — ${msg}`);
      }

      const action: string = data.action;
      const text: string   = data.text ?? "";

      if (action === "simulate" && data.sim_payload) {
        setMessages(prev => [...prev, { id:uid(), role:"assistant", text, ts:Date.now() }]);
        const simRes = await fetch(`${API}/biosim/runs`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify(data.sim_payload),
        });
        const simData = await simRes.json();
        if (!simRes.ok) {
          const detail = simData.detail;
          const msg = typeof detail === "string" ? detail
            : Array.isArray(detail) ? detail.map((e: {loc?: unknown[]; msg?: string}) => `${(e.loc??[]).slice(-1)[0]}: ${e.msg}`).join(", ")
            : JSON.stringify(detail);
          throw new Error(`Simulation failed — ${msg}`);
        }
        onResultChange(simData);
        // fetchRuns is triggered via parent
      } else if (action === "modify_params") {
        // The agent already ran the modified sim in the /agent endpoint
        if (data.sim_result && data.new_run_id) {
          const newResult = { ...data.sim_result, run_id: data.new_run_id };
          onResultChange(newResult);
          const card: InlineCard = { type:"stats", title:"Modified Parameters — Updated Result", result:newResult };
          setMessages(prev => [...prev, { id:uid(), role:"assistant", text, card, ts:Date.now() }]);
        } else {
          setMessages(prev => [...prev, { id:uid(), role:"assistant", text, ts:Date.now() }]);
        }
      } else if (action === "show_card" && data.card && activeResult) {
        const card: InlineCard = { type: data.card.type as CardType, title: data.card.title, result: activeResult };
        setMessages(prev => [...prev, { id:uid(), role:"assistant", text, card, ts:Date.now() }]);
      } else {
        // answer or clarify — plain text
        setMessages(prev => [...prev, { id:uid(), role:"assistant", text, ts:Date.now() }]);
      }
    } catch (e: unknown) {
      setMessages(prev => [...prev, { id:uid(), role:"assistant", text: e instanceof Error ? e.message : "Error — is the backend running?", ts:Date.now() }]);
    } finally { setThinking(false); }
  }

  const QUICK = [
    { label:"Low risk demo",     msg:"Run: female 24, skin graft, Hb 13.2, glucose 88" },
    { label:"Cartilage demo",    msg:"Run: male 45, cartilage patch, Hb 14.1, glucose 108" },
    { label:"High risk demo",    msg:"Run: male, corneal graft, Hb 11.2, autoimmune active, prior rejection" },
    { label:"Show viability",    msg:"Show me the viability chart" },
    { label:"Show rejection",    msg:"Show the rejection risk breakdown" },
    { label:"Show gene map",     msg:"Show gene expression" },
    { label:"Why rejection?",    msg:"Why is the rejection risk high?" },
    { label:"Improve viability", msg:"What changes would most improve viability?" },
    { label:"Change nozzle",     msg:"Change the nozzle to 27G and show me what changes" },
  ];

  return (
    <div className="flex flex-col h-full bg-white">
      {/* messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3 min-h-0">
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col ${m.role==="user"?"items-end":"items-start"}`}>
            <div className={`max-w-[86%] rounded-2xl px-3.5 py-2.5 text-[11.5px] leading-relaxed ${
              m.role==="user"
                ? "bg-slate-900 text-white rounded-br-sm"
                : "bg-slate-50 border border-slate-100 text-slate-700 rounded-bl-sm"
            }`}>
              {m.text}
            </div>
            {m.card && activeResult && (
              <div className="max-w-[86%] w-full">
                <InlineCardWrapper card={m.card} result={activeResult} onSelectGene={onSelectGene} />
              </div>
            )}
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <div className="bg-slate-50 border border-slate-100 rounded-2xl rounded-bl-sm px-3 py-2 flex items-center gap-2">
              <div className="flex gap-1">
                {[0,1,2].map(i => <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay:`${i*0.15}s` }} />)}
              </div>
              <span className="font-mono text-[9px] text-slate-400">thinking...</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* quick chips */}
      <div className="px-4 pt-2 border-t border-slate-100 shrink-0">
        <div className="flex flex-wrap gap-1 mb-2">
          {QUICK.map(q => (
            <button key={q.label} onClick={() => setInput(q.msg)}
              className="font-mono text-[8px] px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700 transition-colors">
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-end pb-3">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key==="Enter"&&!e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Describe a patient, ask about results, or request a change..."
            rows={2}
            className="flex-1 resize-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[11.5px] text-slate-700 placeholder:text-slate-300 outline-none focus:border-slate-400 transition-colors leading-relaxed"
          />
          <button onClick={send} disabled={!input.trim() || thinking}
            className="shrink-0 w-8 h-8 rounded-xl bg-slate-900 text-white flex items-center justify-center hover:bg-slate-700 disabled:opacity-30 transition-colors mb-0.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
        <span className="font-mono text-[7px] text-slate-300 -mt-2 mb-1 block">Enter to send · Shift+Enter for new line</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// FORMULATION + SCAFFOLD SIDEBAR (left panel)
// ─────────────────────────────────────────────────────────────────

const TISSUE_COLORS: Record<string, string> = {
  skin_dermis:    "#3b82f6",
  skin_epidermis: "#ef4444",
  cartilage:      "#10b981",
  corneal:        "#8b5cf6",
};

const TISSUE_STACKS: Record<string, { mat: string; label: string; color: string; h: number }[]> = {
  skin_dermis:    [
    { mat:"GelMA",          label:"GelMA matrix",     color:"#3b82f6", h:0.30 },
    { mat:"Cells",          label:"HDF cell layer",    color:"#f43f5e", h:0.20 },
    { mat:"Alginate",       label:"Alginate network",  color:"#8b5cf6", h:0.25 },
    { mat:"CaCl2",          label:"CaCl2 crosslink",   color:"#10b981", h:0.15 },
    { mat:"Photoinitiator", label:"UV photoinitiator", color:"#f59e0b", h:0.10 },
  ],
  skin_epidermis: [
    { mat:"GelMA",          label:"GelMA surface",     color:"#3b82f6", h:0.35 },
    { mat:"Cells",          label:"Keratinocyte layer", color:"#f43f5e", h:0.25 },
    { mat:"Alginate",       label:"Alginate support",  color:"#8b5cf6", h:0.20 },
    { mat:"Photoinitiator", label:"UV crosslinked",    color:"#f59e0b", h:0.20 },
  ],
  cartilage:      [
    { mat:"Alginate",       label:"Alginate dense",    color:"#8b5cf6", h:0.30 },
    { mat:"GelMA",          label:"GelMA scaffold",    color:"#3b82f6", h:0.25 },
    { mat:"Cells",          label:"Chondrocytes",      color:"#f43f5e", h:0.25 },
    { mat:"CaCl2",          label:"CaCl2 150mM",       color:"#10b981", h:0.20 },
  ],
  corneal:        [
    { mat:"GelMA",          label:"GelMA transparent", color:"#3b82f6", h:0.40 },
    { mat:"Cells",          label:"Limbal stem cells", color:"#f43f5e", h:0.30 },
    { mat:"Alginate",       label:"Alginate thin",     color:"#8b5cf6", h:0.20 },
    { mat:"Photoinitiator", label:"UV 365nm",          color:"#f59e0b", h:0.10 },
  ],
};

const FORMULATION_META: Record<string, {
  gelma: string; alginate: string; cacl2: string; crosslink: string;
  cells: string; nozzle: string; pressure: string; speed: string; uv: string; notes: string;
}> = {
  skin_dermis:    { gelma:"5% w/v",  alginate:"3% w/v", cacl2:"100 mM", crosslink:"UV 405nm / 30s", cells:"HDF 1×10⁶/mL",     nozzle:"25G", pressure:"0.15–0.20 MPa", speed:"5–12 mm/s", uv:"405nm / 15s", notes:"Fibrous ECM mimetic. High cell viability window." },
  skin_epidermis: { gelma:"8% w/v",  alginate:"2% w/v", cacl2:"80 mM",  crosslink:"UV 365nm / 20s", cells:"NHEK 1×10⁶/mL",    nozzle:"27G", pressure:"0.12–0.18 MPa", speed:"5–10 mm/s", uv:"405nm / 20s", notes:"Sheet architecture. Barrier function priority." },
  cartilage:      { gelma:"10% w/v", alginate:"4% w/v", cacl2:"150 mM", crosslink:"Ionic + UV dual", cells:"Chondro 2×10⁶/mL", nozzle:"22G", pressure:"0.20–0.30 MPa", speed:"8–15 mm/s", uv:"405nm / 30s", notes:"High stiffness. Load-bearing mechanical demand." },
  corneal:        { gelma:"6% w/v",  alginate:"2% w/v", cacl2:"60 mM",  crosslink:"UV 365nm / 15s", cells:"LSC 5×10⁵/mL",     nozzle:"27G", pressure:"0.10–0.15 MPa", speed:"5–8 mm/s",  uv:"365nm / 10s", notes:"Optical transparency critical. Low cell density." },
};

// Simple SVG scaffold molecule sketch per tissue (schematic bonds, not real SMILES rendering)
// Proper skeletal structural formula data
// bonds: [from, to, order] — order 1=single, 2=double, 3=triple
// labels: heteroatoms only (C nodes are implicit junctions)
type BondOrder = 1 | 2 | 3;
interface SkeletalNode { x: number; y: number; el?: string; color?: string }
interface SkeletalData {
  nodes: SkeletalNode[];
  bonds: [number, number, BondOrder][];
  // extra annotation lines (aromatic ring circles, etc.)
  rings?: { cx: number; cy: number; r: number }[];
}

const SKELETAL: Record<string, SkeletalData> = {
  // GelMA backbone — gelatin methacrylate fragment:
  // methacrylate ester off a lysine-like chain with peptide bonds
  skin_dermis: {
    nodes: [
      {x:18, y:65},             // 0 C chain start
      {x:35, y:52},             // 1 C
      {x:55, y:52},             // 2 C
      {x:68, y:38, el:"O", color:"#ef4444"},  // 3 O= (carbonyl)
      {x:68, y:65, el:"N", color:"#3b82f6"},  // 4 NH (amide)
      {x:88, y:65},             // 5 C
      {x:101,y:51},             // 6 C
      {x:118,y:51, el:"O", color:"#ef4444"}, // 7 O (ester)
      {x:101,y:80},             // 8 C  (=CH2 methacrylate)
      {x:118,y:93},             // 9 C  (terminal =CH2)
      {x:35, y:78},             // 10 C chain down
      {x:18, y:90, el:"O", color:"#ef4444"}, // 11 OH
    ],
    bonds: [
      [0,1,1],[1,2,1],[2,3,2],[2,4,1],
      [4,5,1],[5,6,1],[6,7,1],[6,8,1],[8,9,2],
      [1,10,1],[10,11,1],
    ],
  },
  // Keratin-targeting GelMA/Alginate — alginic acid fragment:
  // uronic acid ring with carboxylate and hydroxyl groups
  skin_epidermis: {
    nodes: [
      {x:35, y:45},             // 0 C1 ring top-left
      {x:62, y:32},             // 1 C2
      {x:88, y:45},             // 2 C3
      {x:88, y:72},             // 3 C4
      {x:62, y:85},             // 4 C5
      {x:35, y:72},             // 5 O ring (O in pyranose)  el:O
      {x:62, y:58, el:"O", color:"#ef4444"}, // 6 ring O bridge — not shown, implicit
      {x:110,y:38, el:"O", color:"#ef4444"}, // 7 =O (carboxylate)
      {x:110,y:22, el:"O", color:"#ef4444"}, // 8 O- (carboxylate)
      {x:20, y:35, el:"O", color:"#ef4444"}, // 9 OH (C1 hydroxyl)
      {x:62, y:15, el:"O", color:"#ef4444"}, // 10 OH (C2)
      {x:88, y:30, el:"O", color:"#ef4444"}, // 11 OH (C3)
    ],
    bonds: [
      [0,1,1],[1,2,1],[2,3,1],[3,4,1],[4,5,1],[5,0,1],  // ring
      [2,7,2],[2,8,1],                                    // carboxylate
      [0,9,1],[1,10,1],[3,11,1],                          // OH groups
    ],
    rings: [{ cx:62, cy:58, r:28 }],
  },
  // Alginate + chondroitin sulfate — glucuronic acid with sulfate ester
  cartilage: {
    nodes: [
      {x:30, y:45},             // 0 C1
      {x:55, y:30},             // 1 C2
      {x:82, y:30},             // 2 C3
      {x:97, y:55},             // 3 C4
      {x:82, y:78},             // 4 C5
      {x:55, y:78},             // 5 C6
      {x:15, y:65, el:"O", color:"#ef4444"}, // 6 ring O
      // substituents
      {x:55, y:13, el:"N", color:"#3b82f6"},  // 7 NH (acetamido)
      {x:55, y:0},              // 8 C=O acetyl
      {x:40, y:-10, el:"O", color:"#ef4444"}, // 9 =O acetyl
      {x:115,y:45, el:"O", color:"#ef4444"},  // 10 =O carboxylate
      {x:115,y:65, el:"O", color:"#ef4444"},  // 11 OH carboxylate
      {x:82, y:15, el:"O", color:"#ef4444"},  // 12 OH C3
      {x:82, y:93, el:"S", color:"#f59e0b"},  // 13 S sulfate
      {x:82,y:108, el:"O", color:"#ef4444"},  // 14 =O sulfate
    ],
    bonds: [
      [0,1,1],[1,2,1],[2,3,1],[3,4,1],[4,5,1],[5,6,1],[6,0,1],  // ring
      [1,7,1],[7,8,1],[8,9,2],                                    // acetamido
      [3,10,2],[3,11,1],                                          // carboxylate
      [2,12,1],                                                   // OH
      [4,13,1],[13,14,2],                                        // sulfate
    ],
    rings: [{ cx:60, cy:53, r:29 }],
  },
  // GelMA for cornea — hyaluronic acid fragment, transparent scaffold
  // disaccharide: glucuronate + GlcNAc
  corneal: {
    nodes: [
      // ring 1 — glucuronate
      {x:20, y:48},             // 0
      {x:38, y:34},             // 1
      {x:58, y:34},             // 2
      {x:68, y:52},             // 3
      {x:58, y:70},             // 4
      {x:38, y:70},             // 5
      // ring 2 — GlcNAc (bridged via O)
      {x:90, y:48},             // 6
      {x:103,y:34},             // 7
      {x:118,y:48},             // 8
      {x:118,y:70},             // 9
      {x:103,y:82},             // 10
      // heteroatoms
      {x:10, y:65, el:"O", color:"#ef4444"},  // 11 ring O1
      {x:75, y:70, el:"O", color:"#ef4444"},  // 12 glycosidic O
      {x:80, y:65, el:"O", color:"#ef4444"},  // 13 ring O2
      {x:38, y:18, el:"O", color:"#ef4444"},  // 14 OH C2
      {x:20, y:30, el:"O", color:"#ef4444"},  // 15 COOH
      {x:6,  y:18, el:"O", color:"#ef4444"},  // 16 =O COOH
      {x:103,y:18, el:"N", color:"#3b82f6"},  // 17 NHAc
      {x:103,y:5},              // 18 C=O acetyl
      {x:90, y:-5, el:"O", color:"#ef4444"},  // 19 =O acetyl
    ],
    bonds: [
      [0,1,1],[1,2,1],[2,3,1],[3,4,1],[4,5,1],[5,11,1],[11,0,1], // ring1
      [6,7,1],[7,8,1],[8,9,1],[9,10,1],[10,13,1],[13,6,1],       // ring2
      [4,12,1],[12,6,1],                                          // glycosidic
      [1,14,1],                                                   // OH
      [0,15,1],[15,16,2],                                        // COOH
      [7,17,1],[17,18,1],[18,19,2],                              // NHAc
    ],
    rings: [{ cx:40, cy:52, r:22 }, { cx:103, cy:58, r:22 }],
  },
};

function offsetParallelLine(
  x1: number, y1: number, x2: number, y2: number, d: number
): [number, number, number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len * d, ny = dx / len * d;
  return [x1 + nx, y1 + ny, x2 + nx, y2 + ny];
}

function ScaffoldSketch({ tissueKey, size }: { tissueKey: string; size: number }) {
  const sk = SKELETAL[tissueKey] ?? SKELETAL.skin_dermis;
  const col = TISSUE_COLORS[tissueKey] ?? "#3b82f6";

  return (
    <svg width={size} height={size} viewBox="-8 -14 150 135" style={{ overflow:"visible" }}>
      {/* ring indicators */}
      {(sk.rings ?? []).map((r, i) => (
        <circle key={i} cx={r.cx} cy={r.cy} r={r.r * 0.55}
          fill="none" stroke={col} strokeWidth="1.2" strokeOpacity="0.25" strokeDasharray="3 2" />
      ))}

      {/* bonds */}
      {sk.bonds.map(([a, b, order], i) => {
        const A = sk.nodes[a], B = sk.nodes[b];
        if (order === 2) {
          const [x1a,y1a,x2a,y2a] = offsetParallelLine(A.x,A.y,B.x,B.y,  1.7);
          const [x1b,y1b,x2b,y2b] = offsetParallelLine(A.x,A.y,B.x,B.y, -1.7);
          return (
            <g key={i}>
              <line x1={x1a} y1={y1a} x2={x2a} y2={y2a} stroke="#374151" strokeWidth="1.4" strokeLinecap="round" />
              <line x1={x1b} y1={y1b} x2={x2b} y2={y2b} stroke="#374151" strokeWidth="1.4" strokeLinecap="round" />
            </g>
          );
        }
        if (order === 3) {
          const [x1a,y1a,x2a,y2a] = offsetParallelLine(A.x,A.y,B.x,B.y,  3);
          const [x1b,y1b,x2b,y2b] = offsetParallelLine(A.x,A.y,B.x,B.y, -3);
          return (
            <g key={i}>
              <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#374151" strokeWidth="1.4" strokeLinecap="round" />
              <line x1={x1a} y1={y1a} x2={x2a} y2={y2a} stroke="#374151" strokeWidth="1.4" strokeLinecap="round" />
              <line x1={x1b} y1={y1b} x2={x2b} y2={y2b} stroke="#374151" strokeWidth="1.4" strokeLinecap="round" />
            </g>
          );
        }
        // single bond — color heteroatom bonds by target atom color
        const bondCol = A.el ? (A.color ?? "#374151") : B.el ? (B.color ?? "#374151") : "#374151";
        return (
          <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y}
            stroke={bondCol} strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.85" />
        );
      })}

      {/* heteroatom labels only — C is implicit (bare junction) */}
      {sk.nodes.map((n, i) => {
        if (!n.el) return null;
        const bg = n.el === "O" ? "#fff1f2" : n.el === "N" ? "#eff6ff" : n.el === "S" ? "#fffbeb" : "#f8fafc";
        const stroke = n.color ?? "#374151";
        return (
          <g key={i}>
            <rect x={n.x - 8} y={n.y - 7} width={16} height={13} rx={3}
              fill={bg} stroke={stroke} strokeWidth="1" strokeOpacity="0.6" />
            <text x={n.x} y={n.y + 3.5} textAnchor="middle"
              fontSize="7.5" fontWeight="700" fontFamily="monospace" fill={stroke}>{n.el}</text>
          </g>
        );
      })}
    </svg>
  );
}

function LayerStack({ tissueKey }: { tissueKey: string }) {
  const stack = TISSUE_STACKS[tissueKey] ?? TISSUE_STACKS.skin_dermis;
  return (
    <div className="flex flex-col gap-0.5">
      {stack.map((layer, i) => (
        <div key={i} className="flex items-center gap-2 group">
          <div className="w-full rounded" style={{ height: Math.round(layer.h * 44), background: layer.color, opacity: 0.75 }} />
          <span className="font-mono text-[6.5px] text-slate-400 whitespace-nowrap w-24 shrink-0">{layer.label}</span>
        </div>
      ))}
    </div>
  );
}

function FormulationPanel({ result }: { result: SimResult | null }) {
  const tissueKey = result?.tissue_key ?? null;
  const meta = tissueKey ? FORMULATION_META[tissueKey] : null;
  const col  = tissueKey ? (TISSUE_COLORS[tissueKey] ?? "#6b7280") : "#6b7280";

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* header */}
      <div className="px-3 py-2.5 border-b border-slate-100 shrink-0">
        <div className="font-mono text-[8px] text-slate-400 uppercase tracking-widest mb-0.5">Formulation</div>
        {result ? (
          <div className="font-mono text-[11px] font-semibold text-slate-800 leading-tight">{result.formulation.display}</div>
        ) : (
          <div className="font-mono text-[9px] text-slate-300">No simulation loaded</div>
        )}
      </div>

      {!result ? (
        <div className="flex items-center justify-center flex-1">
          <span className="font-mono text-[8px] text-slate-200">Run a simulation</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-3 py-3">

          {/* molecule sketch */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[7px] text-slate-400 uppercase tracking-widest">Scaffold Structure</span>
            <div className="flex justify-center bg-slate-50 rounded-xl border border-slate-100 py-2">
              <ScaffoldSketch tissueKey={tissueKey!} size={110} />
            </div>
            <div className="flex justify-center gap-3 mt-0.5 flex-wrap">
              {(SKELETAL[tissueKey!]?.nodes ?? [])
                .filter(n => !!n.el)
                .filter((n, i, arr) => arr.findIndex(x => x.el === n.el) === i)
                .map(n => (
                  <span key={n.el} className="flex items-center gap-1 font-mono text-[7px]" style={{ color: n.color }}>
                    <span className="w-2 h-2 rounded-sm border" style={{ borderColor: n.color, background: n.el === "O" ? "#fff1f2" : n.el === "N" ? "#eff6ff" : n.el === "S" ? "#fffbeb" : "#f8fafc" }} />
                    {n.el === "N" ? "N" : n.el === "O" ? "O" : n.el === "S" ? "S" : n.el}
                  </span>
                ))}
              <span className="flex items-center gap-1 font-mono text-[7px] text-slate-400">
                <span className="w-2 h-2 rounded-sm border border-slate-300 bg-white" />C
              </span>
            </div>
          </div>

          {/* layer stack */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[7px] text-slate-400 uppercase tracking-widest">Layer Stack</span>
            <LayerStack tissueKey={tissueKey!} />
          </div>

          {/* bioink composition */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[7px] text-slate-400 uppercase tracking-widest">Bio-ink Composition</span>
            <div className="flex flex-col divide-y divide-slate-50">
              {meta && [
                ["GelMA",     meta.gelma,    col],
                ["Alginate",  meta.alginate, "#8b5cf6"],
                ["CaCl2",     meta.cacl2,    "#10b981"],
                ["Crosslink", meta.crosslink,"#f59e0b"],
                ["Cells",     meta.cells,    "#f43f5e"],
              ].map(([k,v,c]) => (
                <div key={k as string} className="flex justify-between items-center py-1">
                  <span className="font-mono text-[7.5px] text-slate-400">{k as string}</span>
                  <span className="font-mono text-[8px] font-medium" style={{ color: c as string }}>{v as string}</span>
                </div>
              ))}
            </div>
          </div>

          {/* print parameters */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[7px] text-slate-400 uppercase tracking-widest">Print Parameters</span>
            <div className="flex flex-col divide-y divide-slate-50">
              {meta && [
                ["Nozzle",    meta.nozzle],
                ["Pressure",  meta.pressure],
                ["Speed",     meta.speed],
                ["UV",        meta.uv],
              ].map(([k,v]) => (
                <div key={k as string} className="flex justify-between items-center py-1">
                  <span className="font-mono text-[7.5px] text-slate-400">{k as string}</span>
                  <span className="font-mono text-[8px] text-slate-600">{v as string}</span>
                </div>
              ))}
            </div>
          </div>

          {/* scaffold rules */}
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[7px] text-slate-400 uppercase tracking-widest">Scaffold Rules</span>
            <div className="flex flex-col gap-1">
              {[
                ["Printability",  result.stages.physics.quality_score > 0.6,              result.stages.physics.quality_score > 0.6 ? "PASS" : "FAIL"],
                ["Viability",     !result.stages.viability.below_threshold,                !result.stages.viability.below_threshold ? "PASS" : "FAIL"],
                ["Rejection",     result.stages.rejection.rejection_probability < 0.5,    result.stages.rejection.rejection_probability < 0.5 ? "PASS" : "HIGH"],
                ["Metabolic",     result.stages.metabolic.composite > 0.5,               result.stages.metabolic.composite > 0.5 ? "PASS" : "MARGINAL"],
              ].map(([label, pass, badge]) => (
                <div key={label as string} className="flex items-center justify-between">
                  <span className="font-mono text-[7.5px] text-slate-500">{label as string}</span>
                  <span className="font-mono text-[7px] px-1.5 py-0.5 rounded-full"
                    style={{ background: pass ? "#dcfce7" : "#fee2e2", color: pass ? "#16a34a" : "#dc2626" }}>
                    {badge as string}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* notes */}
          {meta && (
            <p className="font-mono text-[7.5px] text-slate-400 leading-relaxed border-t border-slate-100 pt-3">{meta.notes}</p>
          )}

        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// HISTORY DROPDOWN
// ─────────────────────────────────────────────────────────────────

function HistoryDropdown({ runs, onLoad }: { runs: RunListItem[]; onLoad: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)}
        className={`font-mono text-[9px] px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${open?"bg-slate-900 text-white":"text-slate-400 hover:text-slate-700 hover:bg-slate-50"}`}>
        History{runs.length>0&&<span className="font-mono text-[7px] px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600">{runs.length}</span>}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform:open?"rotate(180deg)":"none", transition:"transform 0.15s" }}><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-96 z-50 bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Simulation history</span>
            <span className="font-mono text-[7.5px] text-slate-300">{runs.length} runs</span>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {runs.length === 0 && <div className="px-4 py-8 text-center"><p className="font-mono text-[10px] text-slate-300">No runs yet</p></div>}
            {runs.map(r => (
              <div key={r.id} onClick={() => { onLoad(r.id); setOpen(false); }}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer group border-b border-slate-50 last:border-0 transition-colors">
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="font-mono text-[9.5px] text-slate-700 truncate">{r.label}</span>
                  <span className="font-mono text-[7.5px] text-slate-400">{r.id.slice(0,8)} · {r.created_at.slice(0,16).replace("T"," ")}</span>
                </div>
                <span className="font-mono text-[8px] px-2 py-0.5 rounded-full shrink-0" style={{ background:riskBg(r.risk_tier), color:riskColor(r.risk_tier) }}>{r.risk_tier}</span>
                <span className="font-mono text-[8.5px] text-slate-400 shrink-0">{fmt(r.viability_24h)}% 24h</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────

export default function BioSim() {
  const [result,   setResult]   = useState<SimResult | null>(null);
  const [runs,     setRuns]     = useState<RunListItem[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [selGene,  setSelGene]  = useState<string | null>(null);
  const [copied,   setCopied]   = useState(false);

  const fetchRuns = useCallback(() => {
    fetch(`${API}/biosim/runs`).then(r => r.ok ? r.json() : null).then(d => { if (d) setRuns(d); }).catch(() => {});
  }, []);

  useEffect(() => { fetchRuns(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleResultChange(r: SimResult) {
    setResult(r);
    setSelGene(null);
    fetchRuns();
  }

  async function loadFromHistory(id: string) {
    try {
      const res  = await fetch(`${API}/biosim/runs/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      handleResultChange(data.result);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Load error"); }
  }

  return (
    <div className="h-screen flex flex-col bg-white text-slate-900 overflow-hidden" style={{ fontFamily:"system-ui,sans-serif" }}>
      {/* NAV */}
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
        <div className="flex items-center gap-3">
          {error && <span className="font-mono text-[9px] text-red-500 max-w-64 truncate">{error}</span>}
          {result && (
            <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(result.spec,null,2)); setCopied(true); setTimeout(()=>setCopied(false),2000); }}
              className="font-mono text-[9px] text-slate-400 hover:text-slate-700 border border-slate-200 rounded-lg px-3 py-1 transition-colors">
              {copied?"copied":"copy spec"}
            </button>
          )}
          <HistoryDropdown runs={runs} onLoad={loadFromHistory} />
          <span className="font-mono text-[8px] text-slate-300">v2 · research only</span>
        </div>
      </nav>

      {/* BODY: formulation | chat | metrics | NGL */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* LEFT — Formulation + Scaffold */}
        <div className="w-72 shrink-0 flex flex-col min-h-0 overflow-hidden border-r border-slate-100">
          <FormulationPanel result={result} />
        </div>

        {/* MAIN — Chat */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <ChatMain
            onSelectGene={setSelGene}
            activeResult={result}
            onResultChange={handleResultChange}
          />
        </div>

        {/* MIDDLE-RIGHT — Metrics graphs */}
        <div className="w-64 shrink-0 flex flex-col min-h-0 overflow-hidden border-l border-slate-100">
          <LiveGraphsPanel result={result} />
        </div>

        {/* FAR RIGHT — NGL 3D viewer */}
        <div className="w-80 shrink-0 flex flex-col min-h-0 overflow-hidden border-l border-slate-100">
          <NGLViewer geneName={selGene} tissueKey={result?.tissue_key ?? null} />
        </div>

      </div>
    </div>
  );
}

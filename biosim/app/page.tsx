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

function NGLViewer({ geneName, tissueKey }: { geneName: string | null; tissueKey: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [info, setInfo]       = useState<{ name: string; desc: string; pdb: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let stage: unknown = null;
    let cancelled = false;

    async function init() {
      if (!containerRef.current) return;
      // Lazy-load NGL only on client
      const NGL = (await import("ngl")).default ?? (await import("ngl"));

      if (cancelled) return;

      // Destroy previous stage
      if (stageRef.current) {
        (stageRef.current as { dispose: () => void }).dispose();
        stageRef.current = null;
      }

      // Resolve gene name
      const geneKey = geneName ?? (() => {
        if (!tissueKey) return null;
        const defaults: Record<string, string> = {
          skin_dermis:"COL1A1", skin_epidermis:"KRT14", cartilage:"COL2A1", corneal:"PAX6"
        };
        return defaults[tissueKey] ?? null;
      })();

      if (!geneKey) return;
      const entry = GENE_PDB[geneKey];
      if (!entry) { setError(`No PDB entry for ${geneKey}`); return; }

      setInfo(entry);
      setLoading(true);
      setError(null);

      try {
        // @ts-expect-error NGL types not bundled
        stage = new NGL.Stage(containerRef.current, {
          backgroundColor: "#0f1117",
          fogNear: 90,
          fogFar: 100,
        });
        stageRef.current = stage;

        const url = `https://files.rcsb.org/download/${entry.pdb}.pdb`;
        // @ts-expect-error NGL types not bundled
        const comp = await stage.loadFile(url, { defaultRepresentation: false });
        if (cancelled) return;

        comp.addRepresentation("cartoon", {
          colorScheme: "residueindex",
          smoothSheet: true,
          opacity: 0.92,
        });
        comp.addRepresentation("surface", {
          colorScheme: "electrostatic",
          opacity: 0.06,
        });
        comp.autoView(400);

        // Hover tooltip via picking
        // @ts-expect-error NGL types not bundled
        stage.signals.hovered.add((pickingProxy: unknown) => {
          const el = document.getElementById("ngl-tooltip");
          if (!el) return;
          if (!pickingProxy) { el.style.display = "none"; return; }
          const pp = pickingProxy as { atom?: { resname: string; resno: number; chainname: string }; mouse?: { position: { x: number; y: number } } };
          if (pp.atom) {
            el.textContent = `${pp.atom.resname} ${pp.atom.resno} · Chain ${pp.atom.chainname}`;
            el.style.display = "block";
            if (pp.mouse) {
              el.style.left = `${pp.mouse.position.x + 12}px`;
              el.style.top  = `${pp.mouse.position.y - 6}px`;
            }
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
      if (stageRef.current) {
        (stageRef.current as { dispose: () => void }).dispose();
        stageRef.current = null;
      }
    };
  }, [geneName, tissueKey]);

  // Handle resize
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (stageRef.current) {
        (stageRef.current as { handleResize: () => void }).handleResize();
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div className="px-4 py-3 border-b border-slate-100 shrink-0">
        <div className="font-mono text-[9px] text-slate-500 uppercase tracking-widest mb-0.5">3D Protein Structure</div>
        {info ? (
          <>
            <div className="font-mono text-[11px] font-semibold text-slate-800">{geneName ?? "—"} · {info.pdb}</div>
            <div className="font-mono text-[8.5px] text-slate-400 leading-snug">{info.desc}</div>
          </>
        ) : (
          <div className="font-mono text-[9px] text-slate-400">Select a gene to load its structure</div>
        )}
      </div>

      {/* viewer */}
      <div className="flex-1 relative min-h-0 bg-[#0f1117]">
        <div ref={containerRef} className="w-full h-full" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" />
              <span className="font-mono text-[8px] text-slate-500">Loading from RCSB...</span>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-mono text-[8px] text-red-400 px-3 text-center">{error}</span>
          </div>
        )}
        {/* hover tooltip */}
        <div id="ngl-tooltip" className="absolute font-mono text-[8px] bg-black/80 text-white px-2 py-1 rounded pointer-events-none" style={{ display:"none" }} />
      </div>

      {/* legend */}
      {info && !loading && !error && (
        <div className="px-4 py-2 border-t border-slate-100 shrink-0">
          <p className="font-mono text-[7.5px] text-slate-400 leading-relaxed">{info.name} — {entry_desc(geneName)}</p>
          <p className="font-mono text-[7px] text-slate-300 mt-0.5">Cartoon = secondary structure  ·  Surface = electrostatic  ·  Hover for residue</p>
        </div>
      )}
    </div>
  );
}

function entry_desc(gene: string | null): string {
  if (!gene) return "";
  return GENE_PDB[gene]?.desc ?? "";
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
      if (!res.ok) throw new Error(data.detail ?? "Agent error");

      const action: string = data.action;
      const text: string   = data.text ?? "";

      if (action === "simulate" && data.sim_payload) {
        setMessages(prev => [...prev, { id:uid(), role:"assistant", text, ts:Date.now() }]);
        // run simulation
        const simRes = await fetch(`${API}/biosim/runs`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify(data.sim_payload),
        });
        const simData = await simRes.json();
        if (!simRes.ok) throw new Error(simData.detail ?? "Simulation failed");
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

      {/* BODY: chat (main) | NGL viewer (right sidebar) */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* MAIN — Chat */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden border-r border-slate-100">
          <ChatMain
            onSelectGene={setSelGene}
            activeResult={result}
            onResultChange={handleResultChange}
          />
        </div>

        {/* RIGHT — NGL 3D viewer */}
        <div className="w-72 shrink-0 flex flex-col min-h-0 overflow-hidden border-l border-slate-100">
          <NGLViewer geneName={selGene} tissueKey={result?.tissue_key ?? null} />
        </div>
      </div>
    </div>
  );
}

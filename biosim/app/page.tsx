"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend, RadarChart,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
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
const riskBg    = (t: string) => t === "low" ? "#f0fdf4" : t === "moderate" ? "#fffbeb" : "#fef2f2";
const readinessColor = (r: string) => ({ optimal:"#16a34a", adequate:"#3b82f6", marginal:"#d97706", poor:"#dc2626" }[r] ?? "#78716c");
const deltaColor = (n: number, invert = false) => {
  if (n === 0) return "#78716c";
  const positive = invert ? n < 0 : n > 0;
  return positive ? "#16a34a" : "#dc2626";
};
const fmt = (n: number, decimals = 1) => n.toFixed(decimals);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const sign = (n: number) => n > 0 ? `+${fmt(n)}` : fmt(n);

// ─────────────────────────────────────────────────────────────────
// MICRO COMPONENTS
// ─────────────────────────────────────────────────────────────────

function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span className="font-mono text-[9px] px-2 py-0.5 rounded-full uppercase tracking-wider font-medium"
      style={{ background: bg, color, border: `1px solid ${color}33` }}>
      {label}
    </span>
  );
}

function StatCard({ label, value, unit, delta, invertDelta, sub }: {
  label: string; value: string | number; unit?: string; delta?: number; invertDelta?: boolean; sub?: string
}) {
  return (
    <div className="flex flex-col gap-1.5 bg-stone-50 border border-stone-100 rounded-2xl p-4">
      <span className="font-mono text-[9px] text-stone-400 uppercase tracking-widest">{label}</span>
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className="font-mono text-[15px] text-stone-900 font-medium">{value}</span>
        {unit && <span className="font-mono text-[10px] text-stone-400">{unit}</span>}
        {delta !== undefined && delta !== 0 && (
          <span className="font-mono text-[10px]" style={{ color: deltaColor(delta, invertDelta) }}>
            {sign(delta)}
          </span>
        )}
      </div>
      {sub && <span className="font-mono text-[9px] text-stone-300 leading-snug">{sub}</span>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[9px] text-stone-400 uppercase tracking-widest">{children}</span>;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`border border-stone-100 rounded-2xl p-5 ${className}`}>{children}</div>;
}

// ─────────────────────────────────────────────────────────────────
// 3D TISSUE CANVAS
// ─────────────────────────────────────────────────────────────────

function TissueCanvas({ viability, risk, quality }: { viability: Viability; risk: string; quality: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef  = useRef<number>(0);
  const angle     = useRef({ x: 0.42, y: 0 });
  const drag      = useRef({ on: false, lx: 0, ly: 0 });

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    const riskC = riskColor(risk);

    function project(x: number, y: number, z: number) {
      const ax = angle.current.x, ay = angle.current.y;
      const rx = x * Math.cos(ay) + z * Math.sin(ay);
      const ry2 = y * Math.cos(ax) - (-x * Math.sin(ay) + z * Math.cos(ay)) * Math.sin(ax);
      const rz2 = y * Math.sin(ax) + (-x * Math.sin(ay) + z * Math.cos(ay)) * Math.cos(ax);
      const s = 300 / (300 + rz2 + 80);
      return { sx: W / 2 + rx * s * 88, sy: H / 2 + ry2 * s * 88, depth: rz2 };
    }

    function viabColor(v: number) {
      if (v > 80) return "#3b82f6";
      if (v > 70) return "#10b981";
      if (v > 55) return "#d97706";
      return "#ef4444";
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      const layers = [
        { y0: -1.2, y1: -0.4, v: viability["24h"], label: `24h · ${viability["24h"]}%` },
        { y0: -0.4, y1:  0.4, v: viability["72h"], label: `72h · ${viability["72h"]}%` },
        { y0:  0.4, y1:  1.2, v: viability["7d"],  label: `7d  · ${viability["7d"]}%`  },
      ];

      type Face = { pts: [number,number][]; color: string; alpha: number; depth: number };
      const faces: Face[] = [];

      layers.forEach(layer => {
        const col = viabColor(layer.v);
        const corners = [
          [-1,layer.y0,-1],[1,layer.y0,-1],[1,layer.y0,1],[-1,layer.y0,1],
          [-1,layer.y1,-1],[1,layer.y1,-1],[1,layer.y1,1],[-1,layer.y1,1],
        ].map(([x,y,z]) => project(x,y,z));

        const faceDefs = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,3,7,4],[1,2,6,5]];
        const alphas   = [0.72, 0.55, 0.88, 0.66, 0.62, 0.92];
        faceDefs.forEach((fi, idx) => {
          const pts = fi.map(i => [corners[i].sx, corners[i].sy] as [number,number]);
          const depth = fi.reduce((s, i) => s + corners[i].depth, 0) / 4;
          faces.push({ pts, color: col, alpha: alphas[idx] * 0.85, depth });
        });
      });

      // quality haze on top face
      const topCorners = [
        project(-1,-1.2,-1), project(1,-1.2,-1), project(1,-1.2,1), project(-1,-1.2,1)
      ];
      faces.push({
        pts: topCorners.map(p => [p.sx, p.sy] as [number,number]),
        color: riskC, alpha: 0.28,
        depth: topCorners.reduce((s,p) => s + p.depth, 0) / 4,
      });

      faces.sort((a, b) => a.depth - b.depth);
      faces.forEach(({ pts, color, alpha }) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1]));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 0.6;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      // quality ring
      const cx = W / 2, cy = H - 28, r = 18;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * quality, false);
      ctx.strokeStyle = quality > 0.7 ? "#3b82f6" : quality > 0.5 ? "#d97706" : "#ef4444";
      ctx.lineWidth = 3; ctx.globalAlpha = 0.7; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#78716c"; ctx.font = "9px monospace"; ctx.textAlign = "center";
      ctx.fillText(`Q ${(quality * 100).toFixed(0)}%`, cx, cy + 4);

      // layer labels
      [{ y: -0.8, label: `24h · ${viability["24h"]}%` },
       { y:  0.0, label: `72h · ${viability["72h"]}%` },
       { y:  0.8, label: `7d  · ${viability["7d"]}%`  }].forEach(lp => {
        const p = project(1.08, lp.y, 0);
        ctx.fillStyle = "#78716c"; ctx.font = "9px monospace"; ctx.textAlign = "left";
        ctx.globalAlpha = 0.85;
        ctx.fillText(lp.label, p.sx + 3, p.sy + 3);
        ctx.globalAlpha = 1;
      });
    }

    const loop = () => { if (!drag.current.on) angle.current.y += 0.004; draw(); frameRef.current = requestAnimationFrame(loop); };
    loop();

    const onDown = (e: MouseEvent) => { drag.current = { on: true, lx: e.clientX, ly: e.clientY }; };
    const onUp   = () => { drag.current.on = false; };
    const onMove = (e: MouseEvent) => {
      if (!drag.current.on) return;
      angle.current.y += (e.clientX - drag.current.lx) * 0.010;
      angle.current.x += (e.clientY - drag.current.ly) * 0.010;
      drag.current.lx = e.clientX; drag.current.ly = e.clientY;
    };
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);
    return () => {
      cancelAnimationFrame(frameRef.current);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
    };
  }, [viability, risk, quality]);

  return (
    <canvas ref={canvasRef} width={540} height={310}
      className="w-full rounded-xl border border-stone-100 cursor-grab active:cursor-grabbing"
      style={{ background: "#fafaf9" }} />
  );
}

// ─────────────────────────────────────────────────────────────────
// GENE EXPRESSION BAR
// ─────────────────────────────────────────────────────────────────

const EXPR_COLOR = { overexpressed: "#3b82f6", normal: "#10b981", suppressed: "#ef4444" } as const;
const EXPR_WIDTH = { overexpressed: 90, normal: 55, suppressed: 18 } as const;
type ExprKey = keyof typeof EXPR_COLOR;

function GenePanel({ genes }: { genes: [string, string, string, string][] }) {
  return (
    <Card className="flex flex-col gap-3">
      <SectionLabel>Gene Expression Protocol</SectionLabel>
      {genes.map(([name, role, chr, expr]) => (
        <div key={name} className="flex items-center gap-3">
          <div className="w-16 shrink-0">
            <div className="font-mono text-[10px] text-stone-700">{name}</div>
            <div className="font-mono text-[8px] text-stone-300">{chr}</div>
          </div>
          <div className="flex-1 h-4 bg-stone-50 rounded overflow-hidden border border-stone-100">
            <div className="h-full rounded transition-all duration-700"
              style={{ width: `${EXPR_WIDTH[expr as ExprKey] ?? 50}%`, background: EXPR_COLOR[expr as ExprKey] ?? "#78716c", opacity: 0.78 }} />
          </div>
          <span className="font-mono text-[9px] w-20 shrink-0" style={{ color: EXPR_COLOR[expr as ExprKey] ?? "#78716c" }}>{expr}</span>
          <span className="font-mono text-[9px] text-stone-300 hidden lg:block flex-1 truncate">{role}</span>
        </div>
      ))}
      <div className="flex gap-4 pt-1 border-t border-stone-50">
        {(Object.entries(EXPR_COLOR) as [ExprKey, string][]).map(([e, c]) => (
          <span key={e} className="font-mono text-[9px] flex items-center gap-1.5 text-stone-400">
            <span className="w-2 h-2 rounded-sm inline-block" style={{ background: c, opacity: 0.75 }} />{e}
          </span>
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// METABOLIC RADAR
// ─────────────────────────────────────────────────────────────────

function MetabolicRadar({ metabolic }: { metabolic: Metabolic }) {
  const data = [
    { subject: "O₂ Delivery",    A: metabolic.subscores.oxygen_delivery * 100 },
    { subject: "Glycemic",       A: metabolic.subscores.glycemic_stability * 100 },
    { subject: "Renal",          A: metabolic.subscores.renal_clearance * 100 },
    { subject: "Hepatic",        A: metabolic.subscores.hepatic_function * 100 },
    { subject: "Immune",         A: metabolic.subscores.immune_competence * 100 },
  ];
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionLabel>Metabolic Readiness</SectionLabel>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-stone-700">{fmt(metabolic.composite * 100, 0)}%</span>
          <Pill label={metabolic.readiness} color={readinessColor(metabolic.readiness)} bg={readinessColor(metabolic.readiness) + "15"} />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <RadarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 20 }}>
          <PolarGrid stroke="#f5f5f4" />
          <PolarAngleAxis dataKey="subject" tick={{ fontFamily: "monospace", fontSize: 9, fill: "#a8a29e" }} />
          <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
          <Radar dataKey="A" stroke={readinessColor(metabolic.readiness)} fill={readinessColor(metabolic.readiness)} fillOpacity={0.15} strokeWidth={1.5} />
        </RadarChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// REJECTION HLA MAP
// ─────────────────────────────────────────────────────────────────

function HLAMap({ rejection }: { rejection: Rejection }) {
  const loci = ["HLA-A", "HLA-B", "HLA-DR", "HLA-C", "HLA-DQ", "HLA-DP"];
  const tracked = loci.slice(0, 3);
  const untracked = loci.slice(3);
  const mismatches = rejection.assumed_hla_mismatches ?? 4;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <SectionLabel>HLA Compatibility — Chr 6p21</SectionLabel>
        <span className="font-mono text-[9px] text-stone-300">{rejection.typed_hla_loci ?? 0} loci typed</span>
      </div>
      <div className="flex gap-2">
        {tracked.map((locus, i) => {
          const mismatch = mismatches > i * 2;
          return (
            <div key={locus} className="flex flex-col items-center gap-1 flex-1">
              <div className={`w-full h-9 rounded-lg flex items-center justify-center font-mono text-[10px] font-medium border
                ${mismatch ? "bg-red-50 border-red-200 text-red-600" : "bg-emerald-50 border-emerald-200 text-emerald-600"}`}>
                {locus}
              </div>
              <span className="font-mono text-[8px] text-stone-300">{mismatch ? "mismatch" : "matched"}</span>
            </div>
          );
        })}
        {untracked.map(locus => (
          <div key={locus} className="flex flex-col items-center gap-1 flex-1">
            <div className="w-full h-9 rounded-lg flex items-center justify-center font-mono text-[10px] border border-dashed border-stone-200 text-stone-300">{locus}</div>
            <span className="font-mono text-[8px] text-stone-200">v2</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-1.5 bg-stone-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700"
            style={{ width: `${rejection.rejection_probability * 100}%`, background: riskColor(rejection.risk_tier) }} />
        </div>
        <span className="font-mono text-[11px] shrink-0" style={{ color: riskColor(rejection.risk_tier) }}>
          {pct(rejection.rejection_probability)} risk
        </span>
      </div>
      {rejection.modifiers_applied?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rejection.modifiers_applied.map((m, i) => (
            <span key={i} className="font-mono text-[9px] px-2 py-0.5 bg-stone-50 border border-stone-100 rounded-full text-stone-400">
              {m.factor} +{fmt(m.delta * 100, 0)}%
            </span>
          ))}
        </div>
      )}
      <p className="font-mono text-[10px] text-stone-400 leading-snug">{rejection.recommendation}</p>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// LONG TERM MODEL
// ─────────────────────────────────────────────────────────────────

function buildLongTerm(viability: Viability, rejection: Rejection) {
  const v7 = viability["7d"] / 100;
  const r   = rejection.rejection_probability;
  return [
    { t: "0h",   viability: 100,                                rejection: 0 },
    { t: "24h",  viability: viability["24h"],                   rejection: Math.round(r * 100 * 0.12) },
    { t: "72h",  viability: viability["72h"],                   rejection: Math.round(r * 100 * 0.28) },
    { t: "7d",   viability: viability["7d"],                    rejection: Math.round(rejection.rejection_curve.day_7 * 100) },
    { t: "14d",  viability: Math.round(v7 * 96 * 100),          rejection: Math.round(r * 100 * 0.50) },
    { t: "30d",  viability: Math.round(v7 * 88 * 100),          rejection: Math.round(rejection.rejection_curve.day_30 * 100) },
    { t: "60d",  viability: Math.round(v7 * 80 * 100),          rejection: Math.round(r * 100 * 0.72) },
    { t: "90d",  viability: Math.round(v7 * 72 * 100),          rejection: Math.round(rejection.rejection_curve.day_90 * 100) },
    { t: "180d", viability: Math.round(v7 * 60 * 100),          rejection: Math.round(rejection.rejection_curve.day_180 * 100) },
  ];
}

// ─────────────────────────────────────────────────────────────────
// RESULTS PANEL — full single-run view
// ─────────────────────────────────────────────────────────────────

function ResultsPanel({ result, prev }: { result: SimResult; prev: SimResult | null }) {
  const { stages, flags, ai_output, genes } = result;
  const longTermData = buildLongTerm(stages.viability, stages.rejection);
  const [activeTab, setActiveTab] = useState<"overview"|"physics"|"longterm"|"narrative"|"data">("overview");

  const tabs = [
    { key: "overview",  label: "Overview"  },
    { key: "physics",   label: "Physics"   },
    { key: "longterm",  label: "Long term" },
    { key: "narrative", label: "Narrative" },
    { key: "data",      label: "Raw data"  },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      {/* header bar */}
      <div className="flex items-start gap-4 justify-between flex-wrap">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[9px] text-stone-300">RUN {result.run_id?.slice(0, 8)}</span>
            <Pill label={result.formulation.display} color="#78716c" bg="#f5f5f4" />
            <Pill label={`${stages.rejection.risk_tier} rejection`} color={riskColor(stages.rejection.risk_tier)} bg={riskBg(stages.rejection.risk_tier)} />
            {stages.viability.below_threshold && <Pill label="viability ↓ threshold" color="#dc2626" bg="#fef2f2" />}
            {stages.metabolic.readiness !== "optimal" && (
              <Pill label={`metabolic: ${stages.metabolic.readiness}`} color={readinessColor(stages.metabolic.readiness)} bg={readinessColor(stages.metabolic.readiness) + "15"} />
            )}
          </div>
          <p className="text-[14px] text-stone-600 leading-relaxed max-w-2xl">{safeStr(ai_output.overall_assessment)}</p>
        </div>
        <div className="flex gap-1 bg-stone-100 rounded-xl p-1 self-start shrink-0 flex-wrap">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`font-mono text-[9px] px-3 py-1.5 rounded-lg transition-colors
                ${activeTab === t.key ? "bg-white text-stone-900 shadow-sm" : "text-stone-400 hover:text-stone-600"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── OVERVIEW ── */}
      {activeTab === "overview" && (
        <div className="flex flex-col gap-6">
          {/* stat row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Viability 24h" value={`${stages.viability["24h"]}%`}
              delta={prev ? stages.viability["24h"] - prev.stages.viability["24h"] : undefined} />
            <StatCard label="Viability 72h" value={`${stages.viability["72h"]}%`}
              delta={prev ? stages.viability["72h"] - prev.stages.viability["72h"] : undefined} />
            <StatCard label="Rejection risk" value={pct(stages.rejection.rejection_probability)}
              delta={prev ? Math.round((stages.rejection.rejection_probability - prev.stages.rejection.rejection_probability) * 100) : undefined}
              invertDelta sub={stages.rejection.risk_tier} />
            <StatCard label="Print quality" value={`${fmt(stages.physics.quality_score * 100, 0)}%`}
              delta={prev ? Math.round((stages.physics.quality_score - prev.stages.physics.quality_score) * 100) : undefined} />
          </div>

          {/* 3D + viability chart */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Card className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <SectionLabel>3D Construct — drag to rotate</SectionLabel>
                <span className="font-mono text-[9px] text-stone-300">{stages.physics.print_time.n_layers} layers · {stages.physics.print_time.estimated_minutes}min</span>
              </div>
              <TissueCanvas viability={stages.viability} risk={stages.rejection.risk_tier} quality={stages.physics.quality_score} />
            </Card>

            <Card className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <SectionLabel>Cell Viability Over Time</SectionLabel>
                {stages.viability.below_threshold && <Pill label="below threshold" color="#dc2626" bg="#fef2f2" />}
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={[
                  { t: "0h",  v: 100, p: prev ? 100 : undefined },
                  { t: "24h", v: stages.viability["24h"], p: prev?.stages.viability["24h"] },
                  { t: "72h", v: stages.viability["72h"], p: prev?.stages.viability["72h"] },
                  { t: "7d",  v: stages.viability["7d"],  p: prev?.stages.viability["7d"]  },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f4" />
                  <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:9, fill:"#a8a29e" }} />
                  <YAxis domain={[0,100]} tick={{ fontFamily:"monospace", fontSize:9, fill:"#a8a29e" }} unit="%" />
                  <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:10, borderRadius:10, border:"1px solid #e7e5e4" }} />
                  <ReferenceLine y={80} stroke="#d97706" strokeDasharray="3 3" />
                  <ReferenceLine y={70} stroke="#dc2626" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="v" stroke="#1c1917" strokeWidth={2} dot={{ fill:"#1c1917",r:3 }} name="Viability %" />
                  {prev && <Line type="monotone" dataKey="p" stroke="#d4d4d4" strokeWidth={1.5} strokeDasharray="5 5" dot={false} name="Previous %" />}
                </LineChart>
              </ResponsiveContainer>
              {/* viability modifiers breakdown */}
              <div className="grid grid-cols-2 gap-2 pt-1 border-t border-stone-50">
                {[
                  ["Hb penalty",     `-${stages.viability.modifiers.hb_penalty_pct}%`, stages.viability.modifiers.hb_penalty_pct > 0],
                  ["Glucose penalty",`-${stages.viability.modifiers.glucose_penalty_pct}%`, stages.viability.modifiers.glucose_penalty_pct > 0],
                  ["Crosslink bonus",`+${stages.viability.modifiers.crosslink_bonus_pct}%`, false],
                  ["Tissue modifier", `${stages.viability.modifiers.tissue_modifier_pct}%`, false],
                ].map(([label, val, warn]) => (
                  <div key={label as string} className="flex justify-between">
                    <span className="font-mono text-[9px] text-stone-300">{label as string}</span>
                    <span className="font-mono text-[9px]" style={{ color: warn ? "#d97706" : "#78716c" }}>{val as string}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* metabolic + HLA */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <MetabolicRadar metabolic={stages.metabolic} />
            <HLAMap rejection={stages.rejection} />
          </div>

          {/* gene expression */}
          <GenePanel genes={genes} />

          {/* flags */}
          {flags.length > 0 && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Anomaly Flags</SectionLabel>
              <div className="flex flex-col gap-1.5">
                {flags.map((f, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5 rounded-xl border"
                    style={{ background: f.severity === "error" ? "#fef2f2" : "#fffbeb", borderColor: f.severity === "error" ? "#fecaca" : "#fde68a" }}>
                    <span className="font-mono text-[9px] font-semibold shrink-0"
                      style={{ color: f.severity === "error" ? "#dc2626" : "#d97706" }}>{f.field}</span>
                    <span className="font-mono text-[10px] text-stone-500">{f.flag || f.error}{f.note ? ` — ${f.note}` : ""}</span>
                    {f.value !== undefined && (
                      <span className="font-mono text-[9px] text-stone-400 ml-auto shrink-0">{f.value} · ref {f.normal_range}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── PHYSICS ── */}
      {activeTab === "physics" && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard label="Shear Stress"         value={fmt(stages.physics.shear_stress_pa)} unit="Pa" sub="Wall shear — Hagen-Poiseuille" />
            <StatCard label="Filament Diameter"    value={fmt(stages.physics.filament_diameter_mm, 3)} unit="mm" sub="Post die-swell" />
            <StatCard label="UV Penetration Depth" value={fmt(stages.physics.uv_penetration_depth_mm, 3)} unit="mm" sub="Beer-Lambert" />
            <StatCard label="Crosslink Uniformity" value={`${fmt(stages.physics.crosslink_uniformity * 100, 0)}%`} sub="Depth vs layer height ratio" />
            <StatCard label="Shape Retention"      value={`${fmt(stages.physics.shape_retention_score * 100, 0)}%`} sub="Ouyang 2016 regression" />
            <StatCard label="Bio-Ink Viscosity"    value={fmt(stages.physics.bio_ink_viscosity_pas, 3)} unit="Pa·s" sub="Herschel-Bulkley approx" />
          </div>

          {/* print params */}
          <Card className="flex flex-col gap-3">
            <SectionLabel>Formulation & Print Parameters</SectionLabel>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
              {[
                ["Cell type",       result.formulation.cell_type],
                ["Alginate",        `${result.formulation.alginate_pct}%`],
                ["GelMA",           `${result.formulation.gelma_pct}%`],
                ["Nozzle",          result.formulation.nozzle_gauge],
                ["Print quality",   `${fmt(stages.physics.quality_score * 100, 0)}%`],
                ["Print time",      `${stages.physics.print_time.estimated_minutes} min`],
                ["Layers",          stages.physics.print_time.n_layers.toString()],
                ["Path length",     `${stages.physics.print_time.path_length_mm} mm`],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <span className="font-mono text-[9px] text-stone-300">{k}</span>
                  <span className="font-mono text-[11px] text-stone-800">{v}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* physics bar charts */}
          <Card className="flex flex-col gap-3">
            <SectionLabel>Physics Quality Breakdown</SectionLabel>
            {[
              { label: "Crosslink uniformity", val: stages.physics.crosslink_uniformity, thresh: 0.65 },
              { label: "Shape retention",      val: stages.physics.shape_retention_score, thresh: 0.70 },
              { label: "Print quality score",  val: stages.physics.quality_score,         thresh: 0.65 },
              { label: "Metabolic composite",  val: stages.metabolic.composite,           thresh: 0.60 },
            ].map(({ label, val, thresh }) => (
              <div key={label} className="flex items-center gap-3">
                <span className="font-mono text-[9px] text-stone-400 w-44 shrink-0">{label}</span>
                <div className="flex-1 h-3 bg-stone-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${val * 100}%`, background: val >= thresh ? "#3b82f6" : val >= thresh * 0.8 ? "#d97706" : "#ef4444" }} />
                </div>
                <span className="font-mono text-[10px] text-stone-600 w-10 text-right">{fmt(val * 100, 0)}%</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── LONG TERM ── */}
      {activeTab === "longterm" && (
        <div className="flex flex-col gap-5">
          <Card>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <SectionLabel>6-Month Viability + Rejection Model</SectionLabel>
                <span className="font-mono text-[9px] text-stone-300">Extrapolated — not a clinical prediction</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={longTermData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f4" />
                  <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:9, fill:"#a8a29e" }} />
                  <YAxis domain={[0,100]} tick={{ fontFamily:"monospace", fontSize:9, fill:"#a8a29e" }} unit="%" />
                  <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:10, borderRadius:10, border:"1px solid #e7e5e4" }} />
                  <Legend wrapperStyle={{ fontFamily:"monospace", fontSize:10 }} />
                  <ReferenceLine y={70} stroke="#d97706" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="viability" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3, fill: "#3b82f6" }} name="Viability %" />
                  <Line type="monotone" dataKey="rejection" stroke={riskColor(stages.rejection.risk_tier)} strokeWidth={2} dot={{ r: 3 }} name="Rejection risk %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid grid-cols-3 gap-3">
            {[
              ["30d viability",  `${longTermData.find(d=>d.t==="30d")?.viability ?? "—"}%`],
              ["90d viability",  `${longTermData.find(d=>d.t==="90d")?.viability ?? "—"}%`],
              ["180d rejection", `${longTermData.find(d=>d.t==="180d")?.rejection ?? "—"}%`],
            ].map(([l, v]) => <StatCard key={l} label={l} value={v} />)}
          </div>

          <Card className="flex flex-col gap-3">
            <SectionLabel>Expression Protocol Timeline</SectionLabel>
            {[
              { stage:"Stage 1", time:"0–24h",    note:"Scaffold formation. HLA suppression initiated. Critical viability window." },
              { stage:"Stage 2", time:"24–72h",   note:"Cell proliferation. Immune modulation via TGFB1. Monitor viability threshold." },
              { stage:"Stage 3", time:"3–7d",     note:"Tissue maturation. Gene expression normalising. Mechanical integrity check." },
              { stage:"Stage 4", time:"7–30d",    note:"Integration window. Rejection risk peaks. Immunosuppression protocol active." },
              { stage:"Stage 5", time:"30–180d",  note:"Chronic phase. HLA matching dominates long-term outcome." },
            ].map((s, i) => (
              <div key={i} className="flex gap-4 border-b border-stone-50 pb-3 last:border-0 last:pb-0">
                <div className="w-20 shrink-0">
                  <div className="font-mono text-[10px] text-stone-700">{s.stage}</div>
                  <div className="font-mono text-[8px] text-stone-300">{s.time}</div>
                </div>
                <p className="font-mono text-[10px] text-stone-500 leading-relaxed">{s.note}</p>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── NARRATIVE ── */}
      {activeTab === "narrative" && (
        <div className="flex flex-col gap-5">
          <Card className="flex flex-col gap-5">
            <SectionLabel>Clinical Narrative</SectionLabel>
            <p className="text-[13px] text-stone-600 leading-relaxed whitespace-pre-line">{safeStr(ai_output.clinical_narrative)}</p>

            {ai_output.interaction_flags?.length > 0 && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Interaction Flags</SectionLabel>
                {ai_output.interaction_flags.map((f, i) => (
                  <div key={i} className="flex gap-2 font-mono text-[11px] text-amber-600">
                    <span className="shrink-0">·</span><span>{f}</span>
                  </div>
                ))}
              </div>
            )}

            {ai_output.missing_data_warnings?.length > 0 && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Data Gaps</SectionLabel>
                {ai_output.missing_data_warnings.map((w, i) => (
                  <div key={i} className="flex gap-2 font-mono text-[11px] text-stone-400">
                    <span className="shrink-0">·</span><span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {ai_output.monitoring_priorities?.length > 0 && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Monitoring Priorities</SectionLabel>
                {ai_output.monitoring_priorities.map((m, i) => (
                  <div key={i} className="flex gap-2 font-mono text-[11px] text-stone-600">
                    <span className="shrink-0">·</span><span>{m}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── RAW DATA ── */}
      {activeTab === "data" && (
        <Card>
          <div className="flex flex-col gap-3">
            <SectionLabel>Raw Simulation Output</SectionLabel>
            <div className="overflow-auto max-h-[65vh] rounded-xl bg-stone-50 border border-stone-100">
              <pre className="font-mono text-[10px] text-stone-600 p-5 leading-relaxed whitespace-pre-wrap">
                {JSON.stringify({ stages: result.stages, flags: result.flags, formulation: result.formulation, spec: result.spec }, null, 2)}
              </pre>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// COMPARE PANEL
// ─────────────────────────────────────────────────────────────────

function ComparePanel({ runs }: { runs: RunListItem[] }) {
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runCompare() {
    if (!aId || !bId || aId === bId) { setError("Select two different runs"); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const res  = await fetch(`${API}/biosim/compare`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_a_id: aId, run_b_id: bId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Compare failed");
      setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setLoading(false); }
  }

  const DeltaBadge = ({ val, invert = false, unit = "" }: { val: number; invert?: boolean; unit?: string }) => {
    const pos = invert ? val < 0 : val > 0;
    const color = val === 0 ? "#78716c" : pos ? "#16a34a" : "#dc2626";
    return (
      <span className="font-mono text-[11px] font-medium" style={{ color }}>
        {val > 0 ? "+" : ""}{fmt(val, 2)}{unit}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {/* run picker */}
      <Card className="flex flex-col gap-4">
        <SectionLabel>Select two runs to compare</SectionLabel>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {([["Run A (baseline)", aId, setAId], ["Run B (modified)", bId, setBId]] as const).map(([label, val, setter]) => (
            <div key={label} className="flex flex-col gap-2">
              <span className="font-mono text-[9px] text-stone-400">{label}</span>
              <select value={val} onChange={e => setter(e.target.value)}
                className="font-mono text-[11px] text-stone-700 bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 outline-none">
                <option value="">— select run —</option>
                {runs.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.risk_tier} risk · v24h {fmt(r.viability_24h)}%
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {error && <span className="font-mono text-[10px] text-red-500">{error}</span>}
        <button onClick={runCompare} disabled={loading || !aId || !bId || aId === bId}
          className="self-start font-mono text-[11px] font-medium px-5 py-2 rounded-xl bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Comparing...
            </span>
          ) : "Run comparison →"}
        </button>
      </Card>

      {result && (
        <div className="flex flex-col gap-6">
          {/* overall assessment */}
          <div className="bg-stone-50 border border-stone-100 rounded-2xl px-5 py-4">
            <p className="text-[13px] text-stone-600 leading-relaxed">{safeStr(result.ai_output.overall_assessment)}</p>
          </div>

          {/* side by side stat cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {([["Run A — Baseline", result.run_a], ["Run B — Modified", result.run_b]] as [string, SimResult][]).map(([label, r]) => (
              <Card key={label} className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <SectionLabel>{label}</SectionLabel>
                  <Pill label={r.stages.rejection.risk_tier} color={riskColor(r.stages.rejection.risk_tier)} bg={riskBg(r.stages.rejection.risk_tier)} />
                </div>
                {[
                  ["Viability 24h",     `${r.stages.viability["24h"]}%`],
                  ["Viability 72h",     `${r.stages.viability["72h"]}%`],
                  ["Viability 7d",      `${r.stages.viability["7d"]}%`],
                  ["Rejection risk",    pct(r.stages.rejection.rejection_probability)],
                  ["Print quality",     `${fmt(r.stages.physics.quality_score * 100, 0)}%`],
                  ["Metabolic",         `${fmt(r.stages.metabolic.composite * 100, 0)}% · ${r.stages.metabolic.readiness}`],
                  ["Shear stress",      `${fmt(r.stages.physics.shear_stress_pa)} Pa`],
                  ["Crosslink unif.",   `${fmt(r.stages.physics.crosslink_uniformity * 100, 0)}%`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between items-center border-b border-stone-50 pb-1.5 last:border-0">
                    <span className="font-mono text-[9px] text-stone-400">{k}</span>
                    <span className="font-mono text-[11px] text-stone-800">{v}</span>
                  </div>
                ))}
              </Card>
            ))}
          </div>

          {/* delta table */}
          <Card className="flex flex-col gap-4">
            <SectionLabel>Delta — B vs A</SectionLabel>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { label: "Viability 24h",  val: result.delta.viability_24h,            unit: "%",   inv: false },
                { label: "Viability 72h",  val: result.delta.viability_72h,            unit: "%",   inv: false },
                { label: "Viability 7d",   val: result.delta.viability_7d,             unit: "%",   inv: false },
                { label: "Rejection risk", val: Math.round(result.delta.rejection_probability * 100), unit: "pp", inv: true },
                { label: "Print quality",  val: Math.round(result.delta.quality_score * 100),        unit: "pp", inv: false },
                { label: "Metabolic",      val: Math.round(result.delta.metabolic_composite * 100),  unit: "pp", inv: false },
              ].map(({ label, val, unit, inv }) => (
                <div key={label} className="flex flex-col gap-1 bg-stone-50 rounded-xl p-3 border border-stone-100">
                  <span className="font-mono text-[9px] text-stone-400">{label}</span>
                  <DeltaBadge val={val} invert={inv} unit={unit} />
                </div>
              ))}
            </div>

            {result.ai_output.comparison_delta?.key_driver && (
              <div className="bg-stone-50 rounded-xl px-4 py-3 border border-stone-100">
                <p className="font-mono text-[10px] text-stone-500">
                  <span className="text-stone-700 font-medium">Key driver — </span>
                  {result.ai_output.comparison_delta.key_driver}
                </p>
              </div>
            )}
          </Card>

          {/* viability comparison chart */}
          <Card className="flex flex-col gap-3">
            <SectionLabel>Viability Comparison</SectionLabel>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={[
                { t:"0h",  a:100,                              b:100 },
                { t:"24h", a:result.run_a.stages.viability["24h"], b:result.run_b.stages.viability["24h"] },
                { t:"72h", a:result.run_a.stages.viability["72h"], b:result.run_b.stages.viability["72h"] },
                { t:"7d",  a:result.run_a.stages.viability["7d"],  b:result.run_b.stages.viability["7d"]  },
              ]}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f4" />
                <XAxis dataKey="t" tick={{ fontFamily:"monospace", fontSize:9, fill:"#a8a29e" }} />
                <YAxis domain={[0,100]} tick={{ fontFamily:"monospace", fontSize:9, fill:"#a8a29e" }} unit="%" />
                <Tooltip contentStyle={{ fontFamily:"monospace", fontSize:10, borderRadius:10, border:"1px solid #e7e5e4" }} />
                <Legend wrapperStyle={{ fontFamily:"monospace", fontSize:10 }} />
                <ReferenceLine y={80} stroke="#d97706" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="a" stroke="#d4d4d4" strokeWidth={2} strokeDasharray="5 5" dot={{ r:3, fill:"#d4d4d4" }} name="Run A" />
                <Line type="monotone" dataKey="b" stroke="#1c1917" strokeWidth={2} dot={{ r:3, fill:"#1c1917" }} name="Run B" />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          {/* narrative */}
          <Card className="flex flex-col gap-4">
            <SectionLabel>Comparison Narrative</SectionLabel>
            <p className="text-[13px] text-stone-600 leading-relaxed whitespace-pre-line">{safeStr(result.ai_output.clinical_narrative)}</p>
            {result.ai_output.interaction_flags?.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Interaction Flags</SectionLabel>
                {result.ai_output.interaction_flags.map((f, i) => (
                  <div key={i} className="flex gap-2 font-mono text-[11px] text-amber-600"><span>·</span><span>{f}</span></div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// RUN HISTORY PANEL
// ─────────────────────────────────────────────────────────────────

function HistoryPanel({ runs, onLoad }: { runs: RunListItem[]; onLoad: (id: string) => void }) {
  if (runs.length === 0) return (
    <div className="border border-dashed border-stone-200 rounded-2xl p-10 text-center">
      <p className="font-mono text-[11px] text-stone-300">No runs yet — run a simulation to see history here.</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{runs.length} run{runs.length !== 1 ? "s" : ""} this session</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {runs.map(r => (
          <div key={r.id} className="flex items-center gap-3 border border-stone-100 rounded-xl px-4 py-3 hover:bg-stone-50 transition-colors group cursor-pointer"
            onClick={() => onLoad(r.id)}>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="font-mono text-[11px] text-stone-700 truncate">{r.label}</span>
              <span className="font-mono text-[9px] text-stone-300">{r.id.slice(0,8)} · {r.created_at.slice(0,16).replace("T"," ")}</span>
            </div>
            <Pill label={r.risk_tier} color={riskColor(r.risk_tier)} bg={riskBg(r.risk_tier)} />
            <span className="font-mono text-[10px] text-stone-400">v24h {fmt(r.viability_24h)}%</span>
            <span className="font-mono text-[10px] text-stone-400">Q {fmt(r.quality_score * 100, 0)}%</span>
            <span className="font-mono text-[9px] text-stone-300 opacity-0 group-hover:opacity-100 transition-opacity">load →</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// DEMO CASES
// ─────────────────────────────────────────────────────────────────

const DEMO_CASES = [
  {
    label: "Low risk — skin graft, female 24",
    key: "low_skin",
    payload: { tissue_key:"skin_dermis", sex:"women", bio:{rbc:4.5,hemoglobin:13.2,hematocrit:39,wbc:6.2,platelets:220,glucose:88,creatinine:0.8,bun:14,alt:22,ast:18,alp:75,sodium:140,potassium:4.1,iga:180,igg:1100,igm:95,ige:45}, hla:{}, immune_flags:{autoimmune_active:false,prior_rejection:false}, patient_meta:{sex:"women",mechanical_load:"low",dimensions:{length_mm:30,width_mm:20,depth_mm:2}} },
  },
  {
    label: "Moderate — cartilage patch, male 45",
    key: "mod_cartilage",
    payload: { tissue_key:"cartilage", sex:"men", bio:{rbc:4.8,hemoglobin:14.1,hematocrit:42,wbc:8.5,platelets:310,glucose:108,creatinine:1.1,bun:18,alt:38,ast:30,alp:110,sodium:138,potassium:4.3,iga:220,igg:1350,igm:140,ige:80}, hla:{}, immune_flags:{autoimmune_active:false,prior_rejection:false}, patient_meta:{sex:"men",mechanical_load:"medium",dimensions:{length_mm:20,width_mm:20,depth_mm:5}} },
  },
  {
    label: "High risk — corneal graft, autoimmune",
    key: "high_corneal",
    payload: { tissue_key:"corneal", sex:"men", bio:{rbc:3.8,hemoglobin:11.2,hematocrit:34,wbc:13.5,platelets:140,glucose:142,creatinine:1.6,bun:28,alt:65,ast:52,alp:160,sodium:134,potassium:5.3,iga:95,igg:1750,igm:38,ige:220}, hla:{}, immune_flags:{autoimmune_active:true,prior_rejection:true}, patient_meta:{sex:"men",mechanical_load:"low",dimensions:{length_mm:12,width_mm:12,depth_mm:0.2}} },
  },
  {
    label: "Neha's CBC — skin target",
    key: "neha_cbc",
    payload: { tissue_key:"skin_dermis", sex:"women", bio:{rbc:4.95,hemoglobin:12.4,hematocrit:38.3,wbc:7.8,platelets:367,glucose:90,creatinine:0.7,bun:14,alt:22,ast:18,alp:75,sodium:140,potassium:4.1,iga:180,igg:1100,igm:95,ige:45}, hla:{}, immune_flags:{autoimmune_active:false,prior_rejection:false}, patient_meta:{sex:"women",mechanical_load:"medium",dimensions:{length_mm:30,width_mm:20,depth_mm:2}} },
  },
];

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────

type AppTab = "simulate" | "compare" | "history";

export default function BioSim() {
  const [prompt,       setPrompt]       = useState("");
  const [loading,      setLoading]      = useState(false);
  const [generating,   setGenerating]   = useState(false);
  const [result,       setResult]       = useState<SimResult | null>(null);
  const [prevResult,   setPrevResult]   = useState<SimResult | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [appTab,       setAppTab]       = useState<AppTab>("simulate");
  const [runs,         setRuns]         = useState<RunListItem[]>([]);
  const [demoOpen,     setDemoOpen]     = useState(false);
  const [copied,       setCopied]       = useState(false);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`${API}/biosim/runs`);
      if (res.ok) setRuns(await res.json());
    } catch { /* server not ready yet */ }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API}/biosim/runs`);
        if (res.ok) setRuns(await res.json());
      } catch { /* not ready */ }
    };
    load();
  }, []);

  async function runSim(payload: object) {
    setLoading(true); setError(null);
    const snap = result;
    try {
      const res  = await fetch(`${API}/biosim/runs`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
      const text = await res.text();
      const data = JSON.parse(text);
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
      if (snap) setPrevResult(snap);
      setResult(data);
      setAppTab("simulate");
      fetchRuns();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setLoading(false); }
  }

  async function generateFromPrompt() {
    if (!prompt.trim()) return;
    setGenerating(true); setError(null);
    try {
      const res  = await fetch(`${API}/biosim/generate-payload`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ prompt }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to parse prompt");
      await runSim(data.payload);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setGenerating(false); }
  }

  async function loadFromHistory(id: string) {
    try {
      const res  = await fetch(`${API}/biosim/runs/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      const snap = result;
      if (snap) setPrevResult(snap);
      setResult(data.result);
      setAppTab("simulate");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }

  function copySpec() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result.spec, null, 2));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  const isRunning = loading || generating;

  return (
    <div className="min-h-screen bg-white text-stone-900" style={{ fontFamily: "system-ui, sans-serif" }}>

      {/* nav */}
      <nav className="sticky top-0 z-20 bg-white border-b border-stone-100">
        <div className="max-w-6xl mx-auto px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight">Zyogen</span>
            <span className="text-stone-300 text-[12px]">/</span>
            <span className="font-mono text-[11px] text-stone-400">BioSim</span>
          </div>
          <div className="flex items-center gap-1 bg-stone-100 rounded-lg p-0.5">
            {(["simulate","compare","history"] as AppTab[]).map(t => (
              <button key={t} onClick={() => setAppTab(t)}
                className={`font-mono text-[10px] px-3 py-1.5 rounded-md transition-colors capitalize
                  ${appTab === t ? "bg-white text-stone-900 shadow-sm" : "text-stone-400 hover:text-stone-600"}`}>
                {t}{t === "history" && runs.length > 0 ? ` (${runs.length})` : ""}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {result && (
              <button onClick={copySpec}
                className="font-mono text-[10px] text-stone-400 hover:text-stone-700 border border-stone-200 rounded-lg px-3 py-1.5 transition-colors">
                {copied ? "copied ✓" : "copy spec"}
              </button>
            )}
            <span className="font-mono text-[9px] text-stone-300">v2 · research only</span>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 pb-24">

        {/* ── SIMULATE TAB ── */}
        {appTab === "simulate" && (
          <div className="flex flex-col gap-8">

            {/* prompt bar */}
            <div className="pt-10 pb-6">
              <div className="text-center mb-8">
                <h1 className="text-[40px] font-normal tracking-[-2px] text-stone-900 leading-[1.05] mb-3"
                  style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                  Simulate before you print.
                </h1>
                <p className="text-[14px] text-stone-400 max-w-xl mx-auto leading-relaxed">
                  Describe a patient and tissue target in plain English. Zyogen computes physics, viability, rejection risk, and a 6-month outcome model.
                </p>
              </div>

              <div className="max-w-3xl mx-auto">
                <div className="border border-stone-200 rounded-2xl overflow-hidden bg-stone-50 focus-within:border-stone-400 transition-colors">
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generateFromPrompt(); }}
                    placeholder="e.g. female patient, 18 years old, skin graft target. Hb 12.4, RBC 4.95, WBC 7.8, platelets 367, low mechanical load..."
                    rows={3}
                    className="w-full bg-transparent px-5 pt-4 pb-3 text-[13px] text-stone-700 placeholder:text-stone-300 resize-none outline-none leading-relaxed"
                  />
                  <div className="flex items-center justify-between px-5 py-3 border-t border-stone-100">
                    <span className="font-mono text-[9px] text-stone-300">⌘ + Enter to run · NLP-parsed via GPT-4o</span>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <button onClick={() => setDemoOpen(p => !p)}
                          className="font-mono text-[10px] text-stone-400 hover:text-stone-600 border border-stone-200 rounded-lg px-3 py-1.5 bg-white transition-colors">
                          demo ↓
                        </button>
                        {demoOpen && (
                          <div className="absolute bottom-full mb-2 right-0 bg-white border border-stone-100 rounded-xl shadow-lg overflow-hidden z-50 w-80">
                            {DEMO_CASES.map(d => (
                              <button key={d.key}
                                onClick={() => { setDemoOpen(false); runSim(d.payload); }}
                                className="w-full text-left px-4 py-3 font-mono text-[10px] text-stone-600 hover:bg-stone-50 border-b border-stone-50 last:border-0 transition-colors">
                                {d.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={generateFromPrompt} disabled={isRunning || !prompt.trim()}
                        className="text-[12px] font-medium px-5 py-1.5 rounded-lg bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                        {isRunning ? (
                          <span className="flex items-center gap-2">
                            <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            {generating ? "parsing..." : "simulating..."}
                          </span>
                        ) : "Run simulation →"}
                      </button>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="mt-3 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                    <span className="font-mono text-[10px] text-red-500">{error}</span>
                  </div>
                )}
              </div>
            </div>

            {/* disclaimer */}
            {result && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-5 py-2.5">
                <span className="font-mono text-[9px] text-amber-600">
                  ⚠ AI-generated research aid — physics models from Ozbolat 2016, Murphy & Atala 2014. Requires biomedical engineer validation before clinical use.
                </span>
              </div>
            )}

            {/* results */}
            {result ? (
              <ResultsPanel result={result} prev={prevResult} />
            ) : !isRunning && (
              <div className="border border-dashed border-stone-150 rounded-2xl p-16 text-center">
                <p className="font-mono text-[11px] text-stone-300">Describe a patient above or load a demo to see the full simulation.</p>
              </div>
            )}

            {isRunning && (
              <div className="border border-stone-100 rounded-2xl p-16 flex flex-col items-center gap-4">
                <div className="w-8 h-8 border-2 border-stone-200 border-t-stone-700 rounded-full animate-spin" />
                <p className="font-mono text-[11px] text-stone-400">{generating ? "Parsing clinical description..." : "Running physics, viability, rejection, and metabolic models..."}</p>
              </div>
            )}
          </div>
        )}

        {/* ── COMPARE TAB ── */}
        {appTab === "compare" && (
          <div className="pt-8">
            <ComparePanel runs={runs} />
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {appTab === "history" && (
          <div className="pt-8">
            <HistoryPanel runs={runs} onLoad={loadFromHistory} />
          </div>
        )}
      </div>
    </div>
  );
}

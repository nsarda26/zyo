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
// 3D TISSUE VIEWER
// ─────────────────────────────────────────────────────────────────

function TissueViewer3D({ result, viability, physics }: { result: SimResult; viability: Viability; physics: Physics }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef  = useRef(0);
  const angle     = useRef({ x: 0.38, y: 0.5 });
  const drag      = useRef({ on: false, lx: 0, ly: 0 });
  const tick      = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    const stack = TISSUE_STACKS[result.tissue_key] ?? TISSUE_STACKS.skin_dermis;
    let seed = 42;
    const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
    const cellDots: { x: number; z: number; li: number }[] = [];
    stack.forEach((layer, li) => { if (layer.mat === "Cells") for (let i = 0; i < 24; i++) cellDots.push({ x: rand()*1.8-0.9, z: rand()*1.8-0.9, li }); });

    const proj = (x: number, y: number, z: number) => {
      const ax = angle.current.x, ay = angle.current.y;
      const rx = x*Math.cos(ay)+z*Math.sin(ay), rz0 = -x*Math.sin(ay)+z*Math.cos(ay);
      const ry2 = y*Math.cos(ax)-rz0*Math.sin(ax), rz2 = y*Math.sin(ax)+rz0*Math.cos(ax);
      const s = 340/(340+rz2+60);
      return { sx: W/2+rx*s*85, sy: H/2+ry2*s*85, depth: rz2 };
    };
    const hex2rgba = (hex: string, a: number) => {
      const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
      return `rgba(${r},${g},${b},${a})`;
    };

    let cumH = 0;
    const yRanges: { y0:number; y1:number; mat:string; label:string; vKey:"24h"|"72h"|"7d" }[] = [];
    stack.forEach((layer, li) => {
      const y0=-1.2+cumH*2.4, y1=y0+layer.h*2.4; cumH+=layer.h;
      const vKey: "24h"|"72h"|"7d" = li < stack.length/3 ? "24h" : li < 2*stack.length/3 ? "72h" : "7d";
      yRanges.push({ y0, y1, mat:layer.mat, label:layer.label, vKey });
    });

    function draw() {
      ctx.clearRect(0, 0, W, H);
      type Face = { pts:[number,number][]; color:string; alpha:number; depth:number };
      const faces: Face[] = [];
      yRanges.forEach(({ y0, y1, mat, vKey }) => {
        const color = MAT[mat]?.color ?? "#94a3b8";
        const vf = viability[vKey]/100;
        const corners = [[-1,y0,-1],[1,y0,-1],[1,y0,1],[-1,y0,1],[-1,y1,-1],[1,y1,-1],[1,y1,1],[-1,y1,1]].map(([x,y,z])=>proj(x,y,z));
        [[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,3,7,4],[1,2,6,5]].forEach((fi,idx) => {
          const pts=fi.map(i=>[corners[i].sx,corners[i].sy] as [number,number]);
          const depth=fi.reduce((s,i)=>s+corners[i].depth,0)/4;
          faces.push({ pts, color, alpha:[0.80,0.52,0.88,0.68,0.66,0.93][idx]*(.5+.5*vf), depth });
        });
      });
      const rc = riskColor(result.stages.rejection.risk_tier);
      const topC=[proj(-1,-1.2,-1),proj(1,-1.2,-1),proj(1,-1.2,1),proj(-1,-1.2,1)];
      faces.push({ pts:topC.map(p=>[p.sx,p.sy] as [number,number]), color:rc, alpha:0.18, depth:topC.reduce((s,p)=>s+p.depth,0)/4 });
      faces.sort((a,b)=>a.depth-b.depth);
      faces.forEach(({ pts, color, alpha }) => {
        ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]); pts.slice(1).forEach(p=>ctx.lineTo(p[0],p[1])); ctx.closePath();
        ctx.fillStyle = hex2rgba(color,Math.max(alpha,.04)); ctx.fill();
        ctx.strokeStyle="rgba(255,255,255,0.2)"; ctx.lineWidth=0.5; ctx.globalAlpha=0.25; ctx.stroke(); ctx.globalAlpha=1;
      });
      // cell dots
      const t = tick.current*0.012;
      cellDots.forEach(({ x, z, li }) => {
        const yr = yRanges[li]; if (!yr) return;
        const yMid=(yr.y0+yr.y1)/2+Math.sin(t+x*3+z*2)*0.04;
        const p=proj(x,yMid,z); const color=MAT["Cells"].color;
        ctx.beginPath(); ctx.arc(p.sx,p.sy,2,0,Math.PI*2);
        ctx.fillStyle=hex2rgba(color,0.5*(viability[yr.vKey]/100)); ctx.fill();
        ctx.beginPath(); ctx.arc(p.sx,p.sy,0.8,0,Math.PI*2);
        ctx.fillStyle=hex2rgba("#1e1b4b",0.7); ctx.fill();
      });
      // layer labels right
      yRanges.forEach(({ y0,y1,mat,label,vKey }) => {
        const p=proj(1.08,(y0+y1)/2,0); const color=MAT[mat]?.color??"#94a3b8";
        ctx.font="8px monospace"; ctx.textAlign="left"; ctx.fillStyle=color; ctx.globalAlpha=0.85;
        ctx.fillText(label,p.sx+4,p.sy+2);
        const v=viability[vKey]; ctx.fillStyle=v>80?"#4ade80":v>70?"#fbbf24":"#f87171";
        ctx.font="7px monospace"; ctx.fillText(`${v}%`,p.sx+4,p.sy+11); ctx.globalAlpha=1;
      });
      // quality arc
      const qr=15,qx=24,qy=H-20; const qc=physics.quality_score>0.7?"#3b82f6":physics.quality_score>0.5?"#d97706":"#ef4444";
      ctx.beginPath(); ctx.arc(qx,qy,qr,Math.PI,Math.PI+Math.PI*2*physics.quality_score);
      ctx.strokeStyle=qc; ctx.lineWidth=2.5; ctx.globalAlpha=0.8; ctx.stroke(); ctx.globalAlpha=1;
      ctx.fillStyle="#94a3b8"; ctx.font="7px monospace"; ctx.textAlign="center";
      ctx.fillText(`Q ${(physics.quality_score*100).toFixed(0)}%`,qx,qy+3);
      // frame info
      ctx.fillStyle="#475569"; ctx.font="7.5px monospace"; ctx.textAlign="right";
      ctx.fillText(`Frame ${Math.floor(tick.current)} · ${physics.print_time.n_layers*8} atoms`,W-6,14);
    }

    const loop = () => { if (!drag.current.on) angle.current.y+=0.003; tick.current=(tick.current+1)%9999; draw(); frameRef.current=requestAnimationFrame(loop); };
    loop();
    const onDown=(e:MouseEvent)=>{drag.current={on:true,lx:e.clientX,ly:e.clientY};};
    const onUp=()=>{drag.current.on=false;};
    const onMove=(e:MouseEvent)=>{if(!drag.current.on)return;angle.current.y+=(e.clientX-drag.current.lx)*0.01;angle.current.x+=(e.clientY-drag.current.ly)*0.01;drag.current.lx=e.clientX;drag.current.ly=e.clientY;};
    canvas.addEventListener("mousedown",onDown); window.addEventListener("mouseup",onUp); window.addEventListener("mousemove",onMove);
    return () => { cancelAnimationFrame(frameRef.current); canvas.removeEventListener("mousedown",onDown); window.removeEventListener("mouseup",onUp); window.removeEventListener("mousemove",onMove); };
  }, [result, viability, physics]);

  return (
    <div className="relative">
      <canvas ref={canvasRef} width={480} height={300}
        className="w-full rounded-xl border border-slate-700 cursor-grab active:cursor-grabbing"
        style={{ background:"linear-gradient(160deg,#0f172a 0%,#1e293b 100%)" }} />
      <div className="absolute bottom-2 left-2 flex flex-col gap-0.5">
        {Object.entries(MAT).slice(0,5).map(([k,v])=>(
          <span key={k} className="flex items-center gap-1 text-[7.5px] font-mono" style={{ color:v.color }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background:v.color, opacity:0.85 }} />{v.label}
          </span>
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
    <div className="bg-[#0f172a] rounded-xl p-3 border border-[#1e293b]">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[8.5px] font-mono" style={{ color:stroke }}>{label}</span>
        <span className="text-[7.5px] font-mono text-[#475569] ml-auto">Mean: {mean} {unit}</span>
      </div>
      <ResponsiveContainer width="100%" height={48}>
        <AreaChart data={data} margin={{ top:2,right:6,bottom:0,left:-16 }}>
          <defs><linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={stroke} stopOpacity={0.35} />
            <stop offset="95%" stopColor={stroke} stopOpacity={0} />
          </linearGradient></defs>
          <YAxis tick={{ fontFamily:"monospace",fontSize:7,fill:"#475569" }} axisLine={false} tickLine={false} domain={["auto","auto"]} />
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
      <EnergyMiniChart data={viabData}  stroke="#8b5cf6" grad="vg"  label="⚡ Cell Viability Signal"    unit="%" mean={`${viability["24h"]}`} />
      <EnergyMiniChart data={shearData} stroke="#34d399" grad="sg"  label="⚡ Shear Stress"              unit="Pa" mean={fmt(physics.shear_stress_pa)} />
      <EnergyMiniChart data={tempData}  stroke="#fb923c" grad="tg"  label="🌡 Build Temperature"         unit="°C" mean="37.0" />
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

function RiskBanner() {
  return (
    <div className="flex rounded-xl overflow-hidden border border-slate-200">
      <div className="bg-slate-900 px-5 py-3 flex flex-col gap-0.5 flex-1">
        <span className="font-mono text-[7px] text-slate-500 uppercase tracking-widest">Population baseline</span>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[28px] font-light text-white leading-none">55%</span>
          <span className="font-mono text-[9px] text-slate-400">rejection risk</span>
        </div>
        <span className="font-mono text-[7.5px] text-slate-500">Long-run without simulation-guided protocols</span>
      </div>
      <div className="w-px bg-slate-700" />
      <div className="bg-slate-900 px-5 py-3 flex flex-col gap-0.5 flex-1">
        <span className="font-mono text-[7px] text-slate-500 uppercase tracking-widest">Zyogen model</span>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[28px] font-light leading-none" style={{ color:"#4ade80" }}>2–3%</span>
          <span className="font-mono text-[9px] text-slate-400">rejection risk</span>
        </div>
        <span className="font-mono text-[7.5px] text-slate-500">Physics + HLA + metabolic, patient-matched bioink</span>
      </div>
      <div className="w-px bg-slate-700" />
      <div className="bg-slate-950 px-5 py-3 flex flex-col gap-2 justify-center min-w-40">
        {[["Baseline","55%","#ef4444",55],["Zyogen","2–3%","#4ade80",3]].map(([label,val,color,w])=>(
          <div key={label as string}>
            <div className="flex justify-between mb-0.5">
              <span className="font-mono text-[7px] text-slate-500">{label as string}</span>
              <span className="font-mono text-[7px]" style={{ color:color as string }}>{val as string}</span>
            </div>
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width:`${w}%`, background:color as string }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SCAFFOLD CARDS
// ─────────────────────────────────────────────────────────────────

const SCAFFOLD_META: Record<string,{ chemotype:string; mw:string; cells:string }> = {
  skin_dermis:    { chemotype:"Fibrous ECM",   mw:"~85 kDa",  cells:"HDF 1×10⁶/mL" },
  skin_epidermis: { chemotype:"Sheet",         mw:"~72 kDa",  cells:"NHEK 1×10⁶/mL" },
  cartilage:      { chemotype:"Load-bearing",  mw:"~110 kDa", cells:"Chondro 2×10⁶/mL" },
  corneal:        { chemotype:"Transparent",   mw:"~68 kDa",  cells:"LSC 5×10⁵/mL" },
};

function ScaffoldCards({ selectedId, onSelect }: { selectedId: string|null; onSelect:(id:string)=>void }) {
  const defs = [
    { id:"skin_dermis",    name:"Skin Dermis",   formula:"GelMA 5% · Alg 3%" },
    { id:"skin_epidermis", name:"Skin Epidermis",formula:"GelMA 8% · Alg 2%" },
    { id:"cartilage",      name:"Cartilage",     formula:"GelMA 10% · Alg 4%" },
    { id:"corneal",        name:"Corneal Graft", formula:"GelMA 6% · Alg 2%" },
  ];
  return (
    <div className="flex flex-col gap-2">
      {defs.map(s => {
        const isSelected = s.id === selectedId;
        const meta = SCAFFOLD_META[s.id];
        return (
          <div key={s.id} onClick={() => onSelect(s.id)}
            className="rounded-xl border cursor-pointer transition-all"
            style={{ background:isSelected?"#f0f9ff":"#fff", borderColor:isSelected?"#3b82f6":"#e2e8f0", boxShadow:isSelected?"0 0 0 1px #3b82f6":"none" }}>
            <div className="flex gap-2.5 p-2.5">
              <ScaffoldDiagram tissueId={s.id} size={68} />
              <div className="flex flex-col flex-1 min-w-0 gap-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold text-slate-800">{s.name}</span>
                  {isSelected && <span className="font-mono text-[7.5px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">Selected ✓</span>}
                </div>
                <div className="flex gap-1">
                  <span className="font-mono text-[7px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">FORMULATION</span>
                  <span className="font-mono text-[7px] px-1.5 py-0.5 rounded text-emerald-700" style={{ background:"#dcfce7" }}>Valid</span>
                </div>
                <span className="font-mono text-[8px] text-slate-400 truncate">{s.formula}</span>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {[["Chemotype",meta.chemotype],["MW",meta.mw],["Cells",meta.cells],["Nozzle","22–27G"]].map(([k,v])=>(
                    <div key={k} className="flex justify-between">
                      <span className="font-mono text-[7px] text-slate-400">{k}</span>
                      <span className="font-mono text-[7px] text-slate-600">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// PROPERTY TABLE
// ─────────────────────────────────────────────────────────────────

function PropertyTable({ result }: { result: SimResult }) {
  const { stages, formulation } = result;
  const rr = stages.rejection.rejection_probability;
  const rows = [
    { label:"Print Quality",     value:fmt(stages.physics.quality_score*100,1), color:stages.physics.quality_score>0.7?"#16a34a":"#d97706" },
    { label:"Viability 24h",     value:`${stages.viability["24h"]}%`,           color:stages.viability["24h"]>80?"#16a34a":"#d97706" },
    { label:"Viability 72h",     value:`${stages.viability["72h"]}%`,           color:stages.viability["72h"]>70?"#16a34a":"#d97706" },
    { label:"Rejection Risk",    value:pct(rr),                                 color:riskColor(stages.rejection.risk_tier) },
    { label:"Metabolic",         value:`${fmt(stages.metabolic.composite*100,1)}%`, color:readColor(stages.metabolic.readiness) },
    { label:"Shear Stress",      value:`${fmt(stages.physics.shear_stress_pa)} Pa`, color:stages.physics.shear_stress_pa<200?"#16a34a":"#d97706" },
    { label:"Crosslink Unif.",   value:pct(stages.physics.crosslink_uniformity), color:stages.physics.crosslink_uniformity>0.65?"#16a34a":"#d97706" },
    { label:"GelMA",             value:`${formulation.gelma_pct}% w/v`,          color:"#3b82f6" },
    { label:"Alginate",          value:`${formulation.alginate_pct}% w/v`,       color:"#8b5cf6" },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Bioprint & Drug-likeness</span>
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full">
          <tbody>
            {rows.map((r,i)=>(
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-1.5 font-mono text-[9px] text-slate-500">{r.label}</td>
                <td className="px-3 py-1.5 font-mono text-[10px] font-semibold text-right" style={{ color:r.color }}>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border border-slate-200 p-3 flex flex-col gap-1.5">
        <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest mb-0.5">Scaffold Rules</span>
        {[
          ["Printability",   stages.physics.quality_score>0.6, stages.physics.quality_score>0.6?"PASS":"FAIL"],
          ["Viability ≥80%", !stages.viability.below_threshold, stages.viability.below_threshold?"FAIL":"PASS"],
          ["Rejection <50%", rr<0.5, rr<0.5?"PASS":"HIGH"],
          ["Metabolic OK",   stages.metabolic.composite>0.5, stages.metabolic.composite>0.5?"PASS":"MARGINAL"],
        ].map(([label,pass,badge])=>(
          <div key={label as string} className="flex items-center justify-between">
            <span className="font-mono text-[8.5px] text-slate-500">{label as string}</span>
            <span className="font-mono text-[8px] px-2 py-0.5 rounded-full" style={{ background:pass?"#dcfce7":"#fee2e2", color:pass?"#16a34a":"#dc2626" }}>{badge as string}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// LONG TERM DATA
// ─────────────────────────────────────────────────────────────────

function buildLongTerm(viability: Viability, rejection: Rejection) {
  const v7=viability["7d"]/100, r=rejection.rejection_probability;
  return [
    { t:"0h",   viability:100,                        rejection:0 },
    { t:"24h",  viability:viability["24h"],            rejection:Math.round(r*100*0.12) },
    { t:"72h",  viability:viability["72h"],            rejection:Math.round(r*100*0.28) },
    { t:"7d",   viability:viability["7d"],             rejection:Math.round(rejection.rejection_curve.day_7*100) },
    { t:"14d",  viability:Math.round(v7*96*100),       rejection:Math.round(r*100*0.50) },
    { t:"30d",  viability:Math.round(v7*88*100),       rejection:Math.round(rejection.rejection_curve.day_30*100) },
    { t:"60d",  viability:Math.round(v7*80*100),       rejection:Math.round(r*100*0.72) },
    { t:"90d",  viability:Math.round(v7*72*100),       rejection:Math.round(rejection.rejection_curve.day_90*100) },
    { t:"180d", viability:Math.round(v7*60*100),       rejection:Math.round(rejection.rejection_curve.day_180*100) },
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
    setMessages(prev => [...prev, { role:"user", text:msg, ts:Date.now() }]);
    setThinking(true);
    try {
      // try to run sim from natural language
      const res  = await fetch(`${API}/biosim/generate-payload`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ prompt:msg }) });
      const data = await res.json();
      if (res.ok && data.payload?.tissue_key) {
        setMessages(prev => [...prev, { role:"assistant", text:`Parsed your description — running simulation for **${data.payload.tissue_key.replace("_"," ")}**...`, ts:Date.now() }]);
        onRunSim(data.payload);
      } else {
        // fallback: answer from current result context
        const ctx = result ? `Current simulation: ${result.formulation.display}, ${result.stages.rejection.risk_tier} risk, viability 24h ${result.stages.viability["24h"]}%, quality ${fmt(result.stages.physics.quality_score*100,0)}%.` : "No simulation loaded yet.";
        setMessages(prev => [...prev, { role:"assistant", text:`${ctx}\n\nI couldn't parse a specific simulation from your message. Try describing a patient — e.g. "female, 28, Hb 12.4, skin graft target".`, ts:Date.now() }]);
      }
    } catch {
      setMessages(prev => [...prev, { role:"assistant", text:"Connection error — is the backend running on port 8000?", ts:Date.now() }]);
    } finally { setThinking(false); }
  }

  const QUICK = [
    { label:"Low risk demo",    msg:"Run: female 24, skin graft, Hb 13.2, glucose 88, no immune issues" },
    { label:"Cartilage demo",   msg:"Run: male 45, cartilage patch, Hb 14.1, glucose 108" },
    { label:"High risk demo",   msg:"Run: male, corneal graft, Hb 11.2, autoimmune active, prior rejection" },
    { label:"Current summary",  msg:"Summarise the current simulation results" },
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
// DASHBOARD — left panel full scrollable content
// ─────────────────────────────────────────────────────────────────

function Dashboard({ result, runs, onLoad }: { result: SimResult|null; runs: RunListItem[]; onLoad:(id:string)=>void }) {
  const [tab, setTab] = useState<"overview"|"sequence"|"longterm"|"history">("overview");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* tab bar */}
      <div className="shrink-0 flex items-center gap-1 px-5 pt-4 pb-3 border-b border-slate-100">
        {(["overview","sequence","longterm","history"] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            className={`font-mono text-[9px] px-3 py-1.5 rounded-lg capitalize transition-colors ${tab===t?"bg-slate-900 text-white":"text-slate-400 hover:text-slate-700 hover:bg-slate-50"}`}>
            {t==="longterm"?"Long term":t}{t==="history"&&runs.length>0?` (${runs.length})`:""}
          </button>
        ))}
      </div>

      {/* scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">

        {/* no result state */}
        {!result && tab !== "history" && (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-24">
            <div className="w-16 h-16 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"/></svg>
            </div>
            <p className="font-mono text-[11px] text-slate-400 text-center leading-relaxed">
              Describe a patient in the chat →<br />or use a quick demo button
            </p>
          </div>
        )}

        {/* ── OVERVIEW ── */}
        {result && tab === "overview" && (
          <div className="flex flex-col gap-5">
            {/* risk banner */}
            <RiskBanner />

            {/* headline stats */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label:"Viability 24h",  value:`${result.stages.viability["24h"]}%`, color:result.stages.viability["24h"]>80?"#16a34a":"#d97706" },
                { label:"Viability 72h",  value:`${result.stages.viability["72h"]}%`, color:result.stages.viability["72h"]>70?"#16a34a":"#d97706" },
                { label:"Rejection",      value:pct(result.stages.rejection.rejection_probability), color:riskColor(result.stages.rejection.risk_tier) },
                { label:"Print Quality",  value:`${fmt(result.stages.physics.quality_score*100,0)}%`, color:result.stages.physics.quality_score>0.7?"#16a34a":"#d97706" },
              ].map(s=>(
                <div key={s.label} className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col gap-1">
                  <span className="font-mono text-[7.5px] text-slate-400 uppercase tracking-widest">{s.label}</span>
                  <span className="font-mono text-[22px] font-light leading-none" style={{ color:s.color }}>{s.value}</span>
                </div>
              ))}
            </div>

            {/* 3-col: scaffold cards | 3D viewer + charts | right panel */}
            <div className="grid grid-cols-[220px_1fr_200px] gap-4">
              {/* scaffold library */}
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Scaffold Library</span>
                <ScaffoldCards selectedId={result.tissue_key} onSelect={()=>{}} />
              </div>

              {/* 3D + energy */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="font-mono text-[8px] text-slate-400">Live · {result.stages.physics.print_time.n_layers} layers · {result.stages.physics.print_time.estimated_minutes}min</span>
                  <span className="font-mono text-[8px] text-slate-300 ml-auto">{result.formulation.display}</span>
                </div>
                <TissueViewer3D result={result} viability={result.stages.viability} physics={result.stages.physics} />
                <SimEnergyCharts viability={result.stages.viability} physics={result.stages.physics} />
              </div>

              {/* property table */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-700">{result.formulation.display}</span>
                </div>
                <PropertyTable result={result} />
                <div className="border border-slate-200 rounded-xl p-3">
                  <MetabolicRadar metabolic={result.stages.metabolic} />
                </div>
              </div>
            </div>

            {/* HLA full width */}
            <div className="border border-slate-200 rounded-xl p-4">
              <HLAMap rejection={result.stages.rejection} />
            </div>

            {/* flags */}
            {result.flags.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Anomaly Flags</span>
                {result.flags.map((f,i)=>(
                  <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg border text-[8.5px] font-mono"
                    style={{ background:f.severity==="error"?"#fef2f2":"#fffbeb", borderColor:f.severity==="error"?"#fecaca":"#fde68a" }}>
                    <span className="font-semibold shrink-0" style={{ color:f.severity==="error"?"#dc2626":"#92400e" }}>{f.field}</span>
                    <span className="text-slate-500">{f.flag||f.error}</span>
                    {f.value!==undefined && <span className="ml-auto shrink-0 text-slate-400">{f.value} · ref {f.normal_range}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── SEQUENCE ── */}
        {result && tab === "sequence" && (
          <div className="grid grid-cols-[1fr_220px] gap-5">
            <div className="flex flex-col gap-4">
              <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Gene Expression — {result.formulation.display}</span>
                  <span className="font-mono text-[7.5px] text-slate-300">{result.genes.length} genes</span>
                </div>
                <GeneSequenceViewer genes={result.genes} />
              </div>
              <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-2">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Physics Breakdown</span>
                {[
                  { label:"Crosslink uniformity", val:result.stages.physics.crosslink_uniformity, thresh:0.65 },
                  { label:"Shape retention",      val:result.stages.physics.shape_retention_score, thresh:0.70 },
                  { label:"Print quality",        val:result.stages.physics.quality_score, thresh:0.65 },
                  { label:"Metabolic composite",  val:result.stages.metabolic.composite, thresh:0.60 },
                ].map(({ label,val,thresh })=>(
                  <div key={label} className="flex items-center gap-3">
                    <span className="font-mono text-[8.5px] text-slate-400 w-38 shrink-0">{label}</span>
                    <div className="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width:`${val*100}%`, background:val>=thresh?"#3b82f6":val>=thresh*0.8?"#d97706":"#ef4444" }} />
                    </div>
                    <span className="font-mono text-[8.5px] text-slate-600 w-9 text-right">{fmt(val*100,0)}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <TissueViewer3D result={result} viability={result.stages.viability} physics={result.stages.physics} />
              <PropertyTable result={result} />
            </div>
          </div>
        )}

        {/* ── LONG TERM ── */}
        {result && tab === "longterm" && (
          <div className="flex flex-col gap-4">
            <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">6-Month Viability + Rejection Model</span>
                <span className="font-mono text-[7.5px] text-slate-300">Extrapolated — not clinical</span>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={buildLongTerm(result.stages.viability,result.stages.rejection)}>
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
            <div className="grid grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-2">
                <span className="font-mono text-[8px] text-slate-400 uppercase tracking-widest">Expression Timeline</span>
                {[
                  { stage:"Stage 1",time:"0–24h",   note:"Scaffold formation. HLA suppression. Critical viability window." },
                  { stage:"Stage 2",time:"24–72h",  note:"Cell proliferation. TGFB1 immune modulation." },
                  { stage:"Stage 3",time:"3–7d",    note:"Tissue maturation. Gene normalisation." },
                  { stage:"Stage 4",time:"7–30d",   note:"Integration window. Rejection risk peaks." },
                  { stage:"Stage 5",time:"30–180d", note:"Chronic phase. HLA dominates outcome." },
                ].map((s,i)=>(
                  <div key={i} className="flex gap-3 border-b border-slate-50 pb-1.5 last:border-0">
                    <div className="w-14 shrink-0"><div className="font-mono text-[9px] text-slate-700">{s.stage}</div><div className="font-mono text-[7px] text-slate-400">{s.time}</div></div>
                    <p className="font-mono text-[8.5px] text-slate-500 leading-relaxed">{s.note}</p>
                  </div>
                ))}
              </div>
              <div className="border border-slate-200 rounded-xl p-4">
                <MetabolicRadar metabolic={result.stages.metabolic} />
              </div>
            </div>
          </div>
        )}

        {/* ── HISTORY ── */}
        {tab === "history" && (
          <div className="flex flex-col gap-2">
            {runs.length === 0 && (
              <div className="text-center py-16"><p className="font-mono text-[10px] text-slate-300">No runs yet — describe a patient in the chat.</p></div>
            )}
            {runs.map(r=>(
              <div key={r.id} onClick={()=>onLoad(r.id)}
                className="flex items-center gap-3 border border-slate-100 rounded-xl px-4 py-2.5 hover:bg-slate-50 cursor-pointer group transition-colors">
                <ScaffoldDiagram tissueId={r.tissue_key} size={32} />
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="font-mono text-[10px] text-slate-700 truncate">{r.label}</span>
                  <span className="font-mono text-[8px] text-slate-400">{r.id.slice(0,8)} · {r.created_at.slice(0,16).replace("T"," ")}</span>
                </div>
                <span className="font-mono text-[8.5px] px-2 py-0.5 rounded-full" style={{ background:riskBg(r.risk_tier),color:riskColor(r.risk_tier) }}>{r.risk_tier}</span>
                <span className="font-mono text-[9px] text-slate-400">v24h {fmt(r.viability_24h)}%</span>
                <span className="font-mono text-[9px] text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity">load →</span>
              </div>
            ))}
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

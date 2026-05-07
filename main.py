import math, json, uuid, sqlite3, os
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

# ─────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────

FIELD_SPECS = {
    "rbc_men":           {"unit":"10⁶/µL", "v_min":1.0,  "v_max":8.0,    "n_min":4.5,   "n_max":5.9,   "flag_low":"low_rbc",              "flag_high":"polycythemia"},
    "rbc_women":         {"unit":"10⁶/µL", "v_min":1.0,  "v_max":8.0,    "n_min":4.1,   "n_max":5.1,   "flag_low":"low_rbc",              "flag_high":"polycythemia"},
    "hemoglobin_men":    {"unit":"g/dL",   "v_min":3.0,  "v_max":25.0,   "n_min":13.5,  "n_max":17.5,  "flag_low":"anemia",               "flag_high":"polycythemia"},
    "hemoglobin_women":  {"unit":"g/dL",   "v_min":3.0,  "v_max":25.0,   "n_min":12.0,  "n_max":15.5,  "flag_low":"anemia",               "flag_high":"polycythemia"},
    "hematocrit_men":    {"unit":"%",      "v_min":10.0, "v_max":70.0,   "n_min":41.0,  "n_max":53.0,  "flag_low":"low_hematocrit",       "flag_high":"high_hematocrit"},
    "hematocrit_women":  {"unit":"%",      "v_min":10.0, "v_max":70.0,   "n_min":36.0,  "n_max":46.0,  "flag_low":"low_hematocrit",       "flag_high":"high_hematocrit"},
    "wbc":               {"unit":"10³/µL", "v_min":0.5,  "v_max":50.0,   "n_min":4.5,   "n_max":11.0,  "flag_low":"leukopenia",           "flag_high":"leukocytosis"},
    "platelets":         {"unit":"10³/µL", "v_min":10.0, "v_max":1000.0, "n_min":150.0, "n_max":400.0, "flag_low":"thrombocytopenia",     "flag_high":"thrombocytosis"},
    "glucose":           {"unit":"mg/dL",  "v_min":20.0, "v_max":800.0,  "n_min":70.0,  "n_max":99.0,  "flag_low":"hypoglycemia",         "flag_high":"hyperglycemia"},
    "creatinine_men":    {"unit":"mg/dL",  "v_min":0.1,  "v_max":15.0,   "n_min":0.7,   "n_max":1.3,   "flag_low":None,                  "flag_high":"renal_impairment"},
    "creatinine_women":  {"unit":"mg/dL",  "v_min":0.1,  "v_max":15.0,   "n_min":0.6,   "n_max":1.1,   "flag_low":None,                  "flag_high":"renal_impairment"},
    "bun":               {"unit":"mg/dL",  "v_min":1.0,  "v_max":200.0,  "n_min":7.0,   "n_max":20.0,  "flag_low":None,                  "flag_high":"elevated_bun"},
    "alt":               {"unit":"U/L",    "v_min":1.0,  "v_max":2000.0, "n_min":7.0,   "n_max":56.0,  "flag_low":None,                  "flag_high":"liver_dysfunction"},
    "ast":               {"unit":"U/L",    "v_min":1.0,  "v_max":2000.0, "n_min":10.0,  "n_max":40.0,  "flag_low":None,                  "flag_high":"liver_dysfunction"},
    "alp":               {"unit":"U/L",    "v_min":10.0, "v_max":1000.0, "n_min":44.0,  "n_max":147.0, "flag_low":None,                  "flag_high":"liver_dysfunction"},
    "sodium":            {"unit":"mEq/L",  "v_min":100.0,"v_max":180.0,  "n_min":136.0, "n_max":145.0, "flag_low":"hyponatremia",         "flag_high":"hypernatremia"},
    "potassium":         {"unit":"mEq/L",  "v_min":1.5,  "v_max":8.0,    "n_min":3.5,   "n_max":5.0,   "flag_low":"hypokalemia",          "flag_high":"hyperkalemia"},
    "iga":               {"unit":"mg/dL",  "v_min":1.0,  "v_max":2000.0, "n_min":70.0,  "n_max":400.0, "flag_low":"IgA_deficiency",       "flag_high":"elevated_IgA"},
    "igg":               {"unit":"mg/dL",  "v_min":100.0,"v_max":4000.0, "n_min":700.0, "n_max":1600.0,"flag_low":"hypogammaglobulinemia", "flag_high":"elevated_IgG"},
    "igm":               {"unit":"mg/dL",  "v_min":10.0, "v_max":1000.0, "n_min":40.0,  "n_max":230.0, "flag_low":"low_IgM",              "flag_high":"elevated_IgM"},
    "ige":               {"unit":"IU/mL",  "v_min":0.0,  "v_max":5000.0, "n_min":0.0,   "n_max":100.0, "flag_low":None,                  "flag_high":"atopic_allergy_risk"},
}

FORMULATIONS = {
    "skin_dermis": {
        "display":"Skin — Dermal Layer",
        "alginate_pct":3.0, "gelma_pct":5.0, "cell_type":"Human Dermal Fibroblasts (HDF)",
        "cell_density_per_ml":1e6, "crosslinker":"CaCl₂ 100mM + UV 405nm",
        "uv_exposure_sec":15, "uv_wavelength_nm":405,
        "build_temp_c":22, "nozzle_gauge":"25G",
        "pressure_mpa_low":0.15, "pressure_mpa_high":0.20,
        "speed_mms_low":5, "speed_mms_high":12, "layer_height_mm":0.20,
        "gel_viscosity_class":"medium", "scaffold_type":"fibrous",
    },
    "skin_epidermis": {
        "display":"Skin — Epidermal Layer",
        "alginate_pct":2.0, "gelma_pct":8.0, "cell_type":"Normal Human Epidermal Keratinocytes (NHEK)",
        "cell_density_per_ml":1e6, "crosslinker":"CaCl₂ 100mM + UV 405nm",
        "uv_exposure_sec":20, "uv_wavelength_nm":405,
        "build_temp_c":20, "nozzle_gauge":"27G",
        "pressure_mpa_low":0.12, "pressure_mpa_high":0.18,
        "speed_mms_low":5, "speed_mms_high":10, "layer_height_mm":0.15,
        "gel_viscosity_class":"low", "scaffold_type":"sheet",
    },
    "cartilage": {
        "display":"Cartilage Patch",
        "alginate_pct":4.0, "gelma_pct":10.0, "cell_type":"Chondrocytes",
        "cell_density_per_ml":2e6, "crosslinker":"CaCl₂ 150mM + UV 405nm",
        "uv_exposure_sec":30, "uv_wavelength_nm":405,
        "build_temp_c":10, "nozzle_gauge":"22G",
        "pressure_mpa_low":0.20, "pressure_mpa_high":0.30,
        "speed_mms_low":8, "speed_mms_high":15, "layer_height_mm":0.25,
        "gel_viscosity_class":"high", "scaffold_type":"load_bearing",
    },
    "corneal": {
        "display":"Corneal Epithelial Graft",
        "alginate_pct":2.0, "gelma_pct":6.0, "cell_type":"Limbal Stem Cells",
        "cell_density_per_ml":5e5, "crosslinker":"CaCl₂ 80mM + UV 365nm",
        "uv_exposure_sec":10, "uv_wavelength_nm":365,
        "build_temp_c":18, "nozzle_gauge":"27G",
        "pressure_mpa_low":0.10, "pressure_mpa_high":0.15,
        "speed_mms_low":5, "speed_mms_high":8, "layer_height_mm":0.10,
        "gel_viscosity_class":"low", "scaffold_type":"transparent",
    },
}

NOZZLE_RADIUS = {"22G":0.000203, "25G":0.000127, "27G":0.0000889}
HLA_MISMATCH_RISK = {0:0.05, 1:0.15, 2:0.28, 3:0.42, 4:0.58, 5:0.72, 6:0.85}

TISSUE_GENES = {
    "skin_dermis":    [("COL1A1","Collagen I alpha chain","17q21","overexpressed"),("COL1A2","Collagen scaffold","7q22","overexpressed"),("MMP1","ECM remodelling","11q22","normal"),("TGFB1","Immune modulation","19q13","normal"),("HLA-A","MHC I antigen — suppressed","6p21","suppressed")],
    "skin_epidermis": [("KRT14","Basal layer structure","17q21","overexpressed"),("KRT1","Suprabasal diff.","12q13","normal"),("FLG","Barrier formation","1q21","normal"),("DSG1","Desmosomal adhesion","18q12","normal"),("HLA-A","MHC I antigen — suppressed","6p21","suppressed")],
    "cartilage":      [("ACAN","Aggrecan — load bearing","15q26","overexpressed"),("COL2A1","Type II collagen","12q13","overexpressed"),("SOX9","Chondro differentiation","17q24","overexpressed"),("COMP","Cartilage matrix protein","19p13","normal"),("HLA-B","MHC I antigen — suppressed","6p21","suppressed")],
    "corneal":        [("KRT3","Corneal epithelial marker","12q13","overexpressed"),("PAX6","Corneal dev. regulator","11p13","overexpressed"),("TP63","Limbal stem maintenance","3q27","normal"),("MUC16","Ocular surface barrier","19p13","normal"),("HLA-A","MHC I antigen — suppressed","6p21","suppressed")],
}

# ─────────────────────────────────────────────────────────────────
# PHYSICS ENGINE
# ─────────────────────────────────────────────────────────────────

def estimate_viscosity(alginate_pct: float, gelma_pct: float) -> float:
    """Herschel-Bulkley approximation for hydrogel viscosity (Pa·s)"""
    return 0.8 + (alginate_pct * 0.32) + (gelma_pct * 0.16)

def compute_shear_stress(pressure_mpa: float, nozzle_gauge: str) -> float:
    """Wall shear stress τ = (P·r)/(2L) for capillary extrusion"""
    r = NOZZLE_RADIUS[nozzle_gauge]
    L = 0.012
    return round((pressure_mpa * 1e6 * r) / (2 * L), 2)

def compute_uv_penetration_depth(uv_exposure_sec: float, wavelength_nm: float, gelma_pct: float) -> float:
    """Beer-Lambert law for UV crosslink depth through hydrogel"""
    mu = 0.10 + (gelma_pct * 0.020) + (0.002 * (wavelength_nm - 365) / 40)
    depth = (1 / mu) * math.log(1 + uv_exposure_sec * 0.055)
    return round(depth, 3)

def compute_filament_diameter(pressure_mpa: float, nozzle_gauge: str, alginate_pct: float, gelma_pct: float) -> float:
    """Predicted extruded filament diameter (mm) from die-swell model"""
    r = NOZZLE_RADIUS[nozzle_gauge]
    d_nozzle_mm = r * 2 * 1000
    eta = estimate_viscosity(alginate_pct, gelma_pct)
    k = 0.78 / eta
    return round(d_nozzle_mm * (1 + k * pressure_mpa), 4)

def compute_crosslink_uniformity(uv_depth: float, layer_height: float, gelma_pct: float) -> float:
    """Crosslink uniformity score 0–1 based on depth vs layer thickness"""
    penetration_ratio = uv_depth / layer_height
    base = min(penetration_ratio * 0.6, 1.0)
    gelma_bonus = min((gelma_pct - 5) * 0.02, 0.15)
    return round(min(base + gelma_bonus, 1.0), 3)

def compute_shape_retention(pressure_mpa: float, alginate_pct: float, gelma_pct: float, build_temp_c: float) -> float:
    """Shape retention score 0–1 from Ouyang et al. regression"""
    visc = estimate_viscosity(alginate_pct, gelma_pct)
    temp_factor = max(0, 1 - (build_temp_c - 10) * 0.008)
    pressure_factor = min(pressure_mpa / 0.25, 1.0)
    return round(min(0.4 + 0.3 * visc * temp_factor + 0.3 * pressure_factor, 1.0), 3)

def compute_print_time(dimensions: dict, formulation: dict, speed_mms: float) -> dict:
    """Estimate print time from dimensions, layer height, print speed"""
    l = dimensions.get("length_mm", 20)
    w = dimensions.get("width_mm", 20)
    d = dimensions.get("depth_mm", 2)
    layer_h = formulation["layer_height_mm"]
    n_layers = math.ceil(d / layer_h)
    path_per_layer_mm = (l * w) / 0.8  # approximate infill path
    time_per_layer_s = path_per_layer_mm / speed_mms
    total_s = int(n_layers * time_per_layer_s)
    return {
        "n_layers": n_layers,
        "estimated_minutes": round(total_s / 60, 1),
        "path_length_mm": round(path_per_layer_mm * n_layers, 0),
    }

def run_physics(formulation: dict, pressure_mpa: float, dimensions: dict, shear_override_pa: float | None = None) -> dict:
    uv_depth = compute_uv_penetration_depth(
        formulation["uv_exposure_sec"], formulation["uv_wavelength_nm"], formulation["gelma_pct"]
    )
    # Shear is only recalculated when nozzle or extrusion speed changes.
    # If a previous shear value is passed in (GelMA-only change), it is reused unchanged.
    if shear_override_pa is not None:
        shear = shear_override_pa
    else:
        shear = compute_shear_stress(pressure_mpa, formulation["nozzle_gauge"])
    filament_d = compute_filament_diameter(pressure_mpa, formulation["nozzle_gauge"], formulation["alginate_pct"], formulation["gelma_pct"])
    crosslink_u = compute_crosslink_uniformity(uv_depth, formulation["layer_height_mm"], formulation["gelma_pct"])
    shape_r = compute_shape_retention(pressure_mpa, formulation["alginate_pct"], formulation["gelma_pct"], formulation["build_temp_c"])
    print_t = compute_print_time(dimensions, formulation, (formulation["speed_mms_low"] + formulation["speed_mms_high"]) / 2)
    viscosity = estimate_viscosity(formulation["alginate_pct"], formulation["gelma_pct"])

    return {
        "shear_stress_pa":         shear,
        "shear_recalculated":      shear_override_pa is None,
        "uv_penetration_depth_mm": uv_depth,
        "filament_diameter_mm":    filament_d,
        "crosslink_uniformity":    crosslink_u,
        "shape_retention_score":   shape_r,
        "bio_ink_viscosity_pas":   round(viscosity, 3),
        "print_time":              print_t,
        "quality_score":           round((crosslink_u * 0.35 + shape_r * 0.35 + min(1, 1 - (shear - 50) / 500) * 0.30), 3),
    }

# ─────────────────────────────────────────────────────────────────
# SCORING / VIABILITY ENGINE
# ─────────────────────────────────────────────────────────────────

def validate_field(value: float, spec_key: str, sex: str = "men") -> dict:
    key = spec_key if spec_key in FIELD_SPECS else f"{spec_key}_{sex}"
    if key not in FIELD_SPECS:
        return {"valid": True}
    spec = FIELD_SPECS[key]
    if not isinstance(value, (int, float)):
        return {"valid": False, "error": f"{spec_key} must be numeric"}
    if value < spec["v_min"] or value > spec["v_max"]:
        return {"valid": False, "error": f"{spec_key} value {value} outside plausible range ({spec['v_min']}–{spec['v_max']} {spec['unit']})"}
    if value < spec["n_min"] and spec["flag_low"]:
        return {"valid": True, "flag": spec["flag_low"], "severity": "warning", "value": value, "normal_range": f"{spec['n_min']}–{spec['n_max']} {spec['unit']}"}
    if value > spec["n_max"] and spec["flag_high"]:
        return {"valid": True, "flag": spec["flag_high"], "severity": "warning", "value": value, "normal_range": f"{spec['n_min']}–{spec['n_max']} {spec['unit']}"}
    return {"valid": True}

def validate_all(bio: dict, sex: str) -> tuple[bool, list]:
    flags = []
    blocked = False

    for f in ["rbc","hemoglobin","hematocrit","wbc","platelets","glucose","creatinine","bun","alt","ast","alp","sodium","potassium","iga","igg","igm","ige"]:
        if f not in bio:
            continue
        r = validate_field(bio[f], f, sex)
        if not r["valid"]:
            flags.append({"field": f, "error": r["error"], "severity": "error"})
            blocked = True
        elif "flag" in r:
            flags.append({"field": f, "flag": r["flag"], "severity": r["severity"], "value": r.get("value"), "normal_range": r.get("normal_range")})

    if "hematocrit" in bio and "hemoglobin" in bio:
        ratio = bio["hematocrit"] / bio["hemoglobin"]
        if abs(ratio - 3.0) > 0.6:
            flags.append({"field": "hematocrit/hemoglobin", "flag": "Hct/Hb_ratio_anomaly", "severity": "warning", "note": f"Ratio {ratio:.2f} — expected ~3.0"})

    diff_keys = ["neutrophils","lymphocytes","monocytes","eosinophils","basophils"]
    if all(k in bio for k in diff_keys):
        total = sum(bio[k] for k in diff_keys)
        if abs(total - 100) > 2:
            flags.append({"field": "wbc_differential", "flag": "differential_sum_error", "severity": "error", "note": f"Sums to {total:.1f}%, must be 100±2"})
            blocked = True

    return not blocked, flags

def predict_viability(shear_pa: float, hemoglobin: float, glucose: float, sex: str, tissue_key: str, crosslink_u: float) -> dict:
    # Base viability from shear stress (Ozbolat 2016 benchmarks)
    if shear_pa < 80:
        base = {"24h": 88.0, "72h": 82.0, "7d": 75.0}
    elif shear_pa < 150:
        base = {"24h": 85.0, "72h": 78.0, "7d": 72.0}
    elif shear_pa < 250:
        base = {"24h": 80.0, "72h": 72.0, "7d": 64.0}
    elif shear_pa < 400:
        base = {"24h": 73.0, "72h": 63.0, "7d": 55.0}
    else:
        base = {"24h": 62.0, "72h": 50.0, "7d": 40.0}

    # Patient bio modifiers
    hb_norm = 13.5 if sex == "men" else 12.0
    hb_penalty = round(min(max((hb_norm - hemoglobin) / hb_norm * 14.0, 0), 9.0) if hemoglobin < hb_norm else 0.0, 2)
    glucose_penalty = 12.0 if glucose > 160 else (8.0 if glucose > 126 else (4.0 if glucose > 99 else 0.0))

    # UV crosslink bonus (better crosslinking → better structural support → higher viability)
    crosslink_bonus = round((crosslink_u - 0.5) * 6.0, 2) if crosslink_u > 0.5 else 0.0

    # Tissue-specific modifier
    tissue_mod = {"skin_dermis": 0, "skin_epidermis": 0, "cartilage": -3.0, "corneal": 2.0}.get(tissue_key, 0)

    total_penalty = hb_penalty + glucose_penalty - crosslink_bonus - tissue_mod

    result = {t: round(max(v - total_penalty, 0), 1) for t, v in base.items()}
    result["modifiers"] = {
        "shear_stress_pa": round(shear_pa, 2),
        "hb_penalty_pct":  hb_penalty,
        "glucose_penalty_pct": glucose_penalty,
        "crosslink_bonus_pct": crosslink_bonus,
        "tissue_modifier_pct": tissue_mod,
        "net_delta_pct": round(-total_penalty, 2),
    }
    result["below_threshold"] = result["24h"] < 80 or result["72h"] < 70
    result["threshold_note"] = "Zyogen target: ≥80% at 24h, ≥70% at 72h"
    return result

def compute_rejection_risk(hla_patient: dict, immune_flags: dict, bio: dict) -> dict:
    # HLA mismatch logic
    hla_keys = ["HLA_A1","HLA_A2","HLA_B1","HLA_B2","HLA_DR1","HLA_DR2"]
    typed = sum(1 for k in hla_keys if hla_patient.get(k))
    assumed_mismatches = max(0, 6 - typed)
    base_risk = HLA_MISMATCH_RISK.get(assumed_mismatches, 0.5)

    modifiers = []

    # HLA confirmed match: binary clinical override applied before all other modifiers.
    # Drops base risk by 37% regardless of immune variable state.
    if immune_flags.get("hla_confirmed_match"):
        hla_override_delta = -round(base_risk * 0.37, 3)
        base_risk = round(base_risk + hla_override_delta, 3)
        modifiers.append({"factor": "hla_confirmed_match_override", "delta": hla_override_delta})

    if immune_flags.get("autoimmune_active"):
        base_risk += 0.15; modifiers.append({"factor":"autoimmune_active","delta":+0.15})
    if immune_flags.get("prior_rejection"):
        base_risk += 0.22; modifiers.append({"factor":"prior_rejection","delta":+0.22})
    if immune_flags.get("leukocytosis") or bio.get("wbc", 7) > 11.0:
        base_risk += 0.10; modifiers.append({"factor":"leukocytosis","delta":+0.10})
    if bio.get("igg", 1000) > 1600:
        base_risk += 0.06; modifiers.append({"factor":"elevated_IgG","delta":+0.06})
    if bio.get("igm", 100) > 230:
        base_risk += 0.05; modifiers.append({"factor":"elevated_IgM","delta":+0.05})
    if bio.get("iga", 200) < 70:
        base_risk += 0.08; modifiers.append({"factor":"IgA_deficiency","delta":+0.08})
    if bio.get("creatinine", 1.0) > 1.5:
        base_risk += 0.07; modifiers.append({"factor":"renal_impairment","delta":+0.07})

    risk = min(round(base_risk, 3), 0.97)
    tier = "low" if risk < 0.20 else ("moderate" if risk < 0.50 else "high")

    day_curve = {
        "day_7":   round(risk * 0.25, 3),
        "day_30":  round(risk * 0.60, 3),
        "day_90":  round(risk * 0.82, 3),
        "day_180": round(risk * 0.95, 3),
    }

    return {
        "rejection_probability":     risk,
        "risk_tier":                 tier,
        "assumed_hla_mismatches":    assumed_mismatches,
        "typed_hla_loci":            typed,
        "modifiers_applied":         modifiers,
        "rejection_curve":           day_curve,
        "recommendation": (
            "Standard monitoring protocol." if tier == "low" else
            "Enhanced immunosuppression monitoring recommended." if tier == "moderate" else
            "High-risk — consider HLA typing, intensified immunosuppression, and frequent rejection screening."
        ),
    }

def compute_metabolic_score(bio: dict) -> dict:
    """Composite metabolic readiness score for bioprinting candidacy"""
    scores = {}

    # Oxygen delivery capacity (hemoglobin + RBC)
    hb = bio.get("hemoglobin", 13.0)
    scores["oxygen_delivery"] = round(min(hb / 14.0, 1.0), 3)

    # Glycemic stability (glucose)
    glc = bio.get("glucose", 90)
    scores["glycemic_stability"] = 1.0 if glc <= 99 else (0.7 if glc <= 126 else (0.4 if glc <= 160 else 0.1))

    # Renal clearance (creatinine + BUN)
    cr = bio.get("creatinine", 0.9)
    bun = bio.get("bun", 14)
    scores["renal_clearance"] = round(min(1.0, max(0, 1 - (cr - 0.7) * 0.3 - (bun - 14) * 0.01)), 3)

    # Hepatic function (ALT + AST)
    alt = bio.get("alt", 25)
    ast = bio.get("ast", 20)
    scores["hepatic_function"] = round(min(1.0, max(0, 1 - max(0, alt - 56) * 0.003 - max(0, ast - 40) * 0.004)), 3)

    # Immune competence (WBC + immunoglobulins)
    wbc = bio.get("wbc", 7.0)
    igg = bio.get("igg", 1000)
    scores["immune_competence"] = round(min(1.0, (min(wbc, 11) / 11) * 0.5 + min(igg / 1600, 1) * 0.5), 3)

    composite = round(sum(scores.values()) / len(scores), 3)
    readiness = "optimal" if composite >= 0.8 else ("adequate" if composite >= 0.6 else ("marginal" if composite >= 0.4 else "poor"))

    return {"subscores": scores, "composite": composite, "readiness": readiness}

# ─────────────────────────────────────────────────────────────────
# OPENAI NARRATIVE LAYER
# ─────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a clinical bioprinting decision-support AI for Zyogen — India's first homegrown bioprinting platform.

You receive fully computed, physics-validated simulation data. Your job:
1. Write a clinical narrative that explains findings clearly to a biomedical engineer or clinician
2. Flag biological interaction risks with specificity — reference actual computed values
3. Identify data gaps that affect simulation confidence
4. List post-print monitoring priorities with time windows
5. If comparing two runs, provide a specific diff analysis — what changed, why it matters

Rules:
- Reference the computed numbers directly. Never invent values.
- Use clinical language but keep it accessible.
- Never diagnose. Use "values suggest", "flags for review", "indicates".
- Always end with: "Research aid — requires biomedical engineer validation."
- overall_assessment must be exactly one sentence, plain string.
- clinical_narrative must be 2–4 paragraphs, plain string."""

def call_openai(patient_summary: dict, compare_summary: dict | None = None) -> dict:
    if compare_summary:
        prompt = f"""
You are performing a COMPARISON analysis of two bioprinting simulation runs.

RUN A (baseline):
{json.dumps(patient_summary, indent=2)}

RUN B (modified):
{json.dumps(compare_summary, indent=2)}

Return JSON:
{{
  "clinical_narrative": "comparison narrative — what changed between runs and clinical implications",
  "interaction_flags": ["specific interaction risks flagging actual values"],
  "missing_data_warnings": ["data gaps affecting confidence"],
  "monitoring_priorities": ["post-print checkpoints with time windows"],
  "overall_assessment": "one sentence summary of how Run B differs from Run A",
  "comparison_delta": {{
    "viability_24h_delta": number,
    "viability_72h_delta": number,
    "rejection_risk_delta": number,
    "quality_score_delta": number,
    "key_driver": "one sentence on the main factor driving the difference"
  }}
}}
"""
    else:
        prompt = f"""
Patient biological summary (physics-computed, clinically validated):
{json.dumps(patient_summary, indent=2)}

Return JSON:
{{
  "clinical_narrative": "2-4 paragraph plain English narrative",
  "interaction_flags": ["biological interaction risks with specific values"],
  "missing_data_warnings": ["missing or uncertain inputs affecting confidence"],
  "monitoring_priorities": ["post-print checkpoints with time windows"],
  "overall_assessment": "one sentence for the report header"
}}
"""

    resp = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        temperature=0.2,
        max_tokens=1200,
    )
    ai = json.loads(resp.choices[0].message.content)
    for key in ["overall_assessment", "clinical_narrative"]:
        if isinstance(ai.get(key), dict):
            ai[key] = " ".join(str(v) for v in ai[key].values())
    return ai

# ─────────────────────────────────────────────────────────────────
# BIOCOMPILER SPEC ASSEMBLER
# ─────────────────────────────────────────────────────────────────

def assemble_spec(tissue_key: str, formulation: dict, physics: dict, viability: dict, rejection: dict, metabolic: dict, flags: list, patient_meta: dict, pressure_mpa: float) -> dict:
    warnings = [f["flag"] for f in flags if "flag" in f]
    if rejection["risk_tier"] == "high":
        warnings.append("HIGH_REJECTION_RISK — review HLA typing and immunosuppression plan")
    if viability.get("below_threshold"):
        warnings.append("VIABILITY_BELOW_THRESHOLD — review print parameters and patient candidacy")
    if physics["quality_score"] < 0.6:
        warnings.append("LOW_PRINT_QUALITY_SCORE — adjust pressure/speed/concentration")
    if metabolic["readiness"] == "poor":
        warnings.append("POOR_METABOLIC_READINESS — patient may not be suitable for this procedure")

    return {
        "spec_version":  "1.0",
        "spec_id":       str(uuid.uuid4()),
        "source":        "zyogen_biosim_v1",
        "generated_at":  datetime.now().isoformat(),
        "tissue_type":   tissue_key,
        "tissue_display": formulation["display"],
        "dimensions":    patient_meta.get("dimensions", {}),
        "patient_profile": {
            "sex":                patient_meta.get("sex"),
            "mechanical_load":    patient_meta.get("mechanical_load","medium"),
            "metabolic_readiness": metabolic["readiness"],
        },
        "bio_ink": {
            "alginate_pct":        formulation["alginate_pct"],
            "gelma_pct":           formulation["gelma_pct"],
            "cell_type":           formulation["cell_type"],
            "cell_density_per_ml": formulation["cell_density_per_ml"],
            "crosslinker":         formulation["crosslinker"],
            "photoinitiator_pct":  0.5,
            "viscosity_class":     formulation["gel_viscosity_class"],
        },
        "print_parameters": {
            "nozzle_gauge":            formulation["nozzle_gauge"],
            "extrusion_pressure_mpa":  round(pressure_mpa, 3),
            "print_speed_mm_s":        round((formulation["speed_mms_low"] + formulation["speed_mms_high"]) / 2, 1),
            "layer_height_mm":         formulation["layer_height_mm"],
            "build_temp_c":            formulation["build_temp_c"],
            "uv_exposure_sec":         formulation["uv_exposure_sec"],
            "uv_wavelength_nm":        formulation["uv_wavelength_nm"],
        },
        "physics_outputs":   physics,
        "viability_estimate": {
            "at_24h_pct": viability["24h"],
            "at_72h_pct": viability["72h"],
            "at_7d_pct":  viability["7d"],
            "below_threshold": viability["below_threshold"],
        },
        "rejection_risk":    rejection,
        "metabolic_score":   metabolic,
        "anomaly_flags":     flags,
        "warnings":          warnings,
        "disclaimer":        "AI-generated research aid. Requires biomedical engineer validation before clinical or laboratory use.",
    }

# ─────────────────────────────────────────────────────────────────
# PIPELINE
# ─────────────────────────────────────────────────────────────────

def _build_regression_diff(baseline: dict, current: dict) -> dict:
    """Compare current simulation output against a baseline and flag regressions."""
    regressions = []
    improvements = []

    checks = [
        # (label, baseline_path, current_path, higher_is_better)
        ("viability_24h",          ["stages","viability","24h"],              ["stages","viability","24h"],              True),
        ("viability_72h",          ["stages","viability","72h"],              ["stages","viability","72h"],              True),
        ("viability_7d",           ["stages","viability","7d"],               ["stages","viability","7d"],               True),
        ("rejection_probability",  ["stages","rejection","rejection_probability"], ["stages","rejection","rejection_probability"], False),
        ("quality_score",          ["stages","physics","quality_score"],      ["stages","physics","quality_score"],      True),
        ("shear_stress_pa",        ["stages","physics","shear_stress_pa"],    ["stages","physics","shear_stress_pa"],    False),
        ("metabolic_composite",    ["stages","metabolic","composite"],        ["stages","metabolic","composite"],        True),
        ("crosslink_uniformity",   ["stages","physics","crosslink_uniformity"], ["stages","physics","crosslink_uniformity"], True),
        ("shape_retention",        ["stages","physics","shape_retention_score"], ["stages","physics","shape_retention_score"], True),
    ]

    def _get(d, path):
        for k in path:
            if not isinstance(d, dict):
                return None
            d = d.get(k)
        return d

    for label, b_path, c_path in [(c[0], c[1], c[2]) for c in checks]:
        higher_is_better = next(c[3] for c in checks if c[0] == label)
        b_val = _get(baseline, b_path)
        c_val = _get(current, c_path)
        if b_val is None or c_val is None:
            continue
        delta = round(c_val - b_val, 4)
        if delta == 0:
            continue
        worsened = (delta < 0 and higher_is_better) or (delta > 0 and not higher_is_better)
        entry = {"parameter": label, "baseline": b_val, "current": c_val, "delta": delta}
        if worsened:
            regressions.append(entry)
        else:
            improvements.append(entry)

    return {
        "regressions":    regressions,
        "improvements":   improvements,
        "has_regressions": len(regressions) > 0,
    }


def run_simulation(payload: dict, baseline_result: dict | None = None) -> dict:
    """
    Run one simulation step.

    baseline_result: if provided, this run is treated as the next step in a
    sequential chain. The previous shear stress is reused unless nozzle gauge
    or extrusion pressure changed, and a regression diff is appended to the output.
    """
    tissue_key   = payload["tissue_key"]
    sex          = payload["sex"]
    bio          = payload["bio"]
    hla          = payload.get("hla", {})
    immune_flags = payload.get("immune_flags", {})
    patient_meta = payload.get("patient_meta", {})

    if tissue_key not in FORMULATIONS:
        return {"error": f"Tissue '{tissue_key}' not in v1. Supported: {list(FORMULATIONS.keys())}"}

    all_valid, flags = validate_all(bio, sex)
    if not all_valid:
        return {"error": "Input validation failed", "flags": flags}

    formulation = FORMULATIONS[tissue_key]
    load = patient_meta.get("mechanical_load", "medium")
    p_lo, p_hi = formulation["pressure_mpa_low"], formulation["pressure_mpa_high"]
    pressure = {"low": p_lo, "medium": (p_lo + p_hi) / 2, "high": p_hi}[load]

    dimensions = patient_meta.get("dimensions", {"length_mm": 20, "width_mm": 20, "depth_mm": 2})

    # Fix 3: only recalculate shear when nozzle or pressure actually changed.
    # GelMA-only changes carry forward the previous shear value.
    shear_override = None
    if baseline_result:
        prev_physics = baseline_result.get("stages", {}).get("physics", {})
        prev_nozzle  = baseline_result.get("formulation", {}).get("nozzle_gauge")
        prev_pressure = baseline_result.get("spec", {}).get("print_parameters", {}).get("extrusion_pressure_mpa")
        nozzle_changed   = prev_nozzle   is not None and prev_nozzle   != formulation["nozzle_gauge"]
        pressure_changed = prev_pressure is not None and abs(prev_pressure - pressure) > 1e-6
        if not nozzle_changed and not pressure_changed:
            shear_override = prev_physics.get("shear_stress_pa")

    physics   = run_physics(formulation, pressure, dimensions, shear_override_pa=shear_override)
    viability = predict_viability(
        physics["shear_stress_pa"],
        bio.get("hemoglobin", 13.5), bio.get("glucose", 90.0),
        sex, tissue_key, physics["crosslink_uniformity"]
    )
    rejection = compute_rejection_risk(hla, immune_flags, bio)
    metabolic = compute_metabolic_score(bio)

    genes = TISSUE_GENES.get(tissue_key, TISSUE_GENES["skin_dermis"])

    patient_summary = {
        "tissue_target":    tissue_key,
        "mechanical_load":  load,
        "sex":              sex,
        "anomaly_flags":    [f.get("flag") or f.get("error") for f in flags],
        "physics":          physics,
        "viability":        {k: v for k, v in viability.items() if k != "modifiers"},
        "viability_modifiers": viability["modifiers"],
        "rejection":        {k: v for k, v in rejection.items() if k != "rejection_curve"},
        "metabolic":        metabolic,
        "key_bio_values":   {k: bio[k] for k in ["hemoglobin","glucose","wbc","platelets","igg","igm","creatinine"] if k in bio},
    }

    ai_output = call_openai(patient_summary)
    spec = assemble_spec(tissue_key, formulation, physics, viability, rejection, metabolic, flags, patient_meta, pressure)

    result = {
        "spec":          spec,
        "flags":         flags,
        "ai_output":     ai_output,
        "stages": {
            "physics":   physics,
            "viability": viability,
            "rejection": rejection,
            "metabolic": metabolic,
        },
        "genes":         genes,
        "tissue_key":    tissue_key,
        "formulation": {
            "display":      formulation["display"],
            "cell_type":    formulation["cell_type"],
            "alginate_pct": formulation["alginate_pct"],
            "gelma_pct":    formulation["gelma_pct"],
            "nozzle_gauge": formulation["nozzle_gauge"],
        },
        "chained_from_baseline": baseline_result is not None,
    }

    # Fix 4: always attach regression diff when a baseline is present.
    if baseline_result:
        result["regression_diff"] = _build_regression_diff(baseline_result, result)

    return result

# ─────────────────────────────────────────────────────────────────
# NLP PAYLOAD GENERATOR
# ─────────────────────────────────────────────────────────────────

NLP_SYSTEM = """You convert clinical descriptions into structured bioprinting simulation payloads.

CRITICAL UNIT CONVERSIONS — always apply:
- platelets: 10³/µL  (3.67 lakhs = 367, "3,67,000" = 367)
- rbc: 10⁶/µL
- wbc: 10³/µL  (7800 per cumm = 7.8, 11000 = 11.0)
- hemoglobin: g/dL
- hematocrit: %
- glucose, creatinine, bun: mg/dL
- alt, ast, alp: U/L
- sodium, potassium: mEq/L
- iga, igg, igm: mg/dL
- ige: IU/mL

STRICT RULES:
- Extract ONLY values explicitly stated. Never infer or guess unlisted bio values.
- NEVER include neutrophils/lymphocytes/monocytes/eosinophils/basophils UNLESS all 5 are mentioned AND sum to 100.
- Infer sex from context (female/male/woman/man/girl/boy).
- Infer tissue from condition context (burn/wound → skin_dermis, joint/cartilage → cartilage, eye/corneal → corneal).
- mechanical_load: default medium unless stated.
- dimensions: default {length_mm:20, width_mm:20, depth_mm:2} unless stated.

Return ONLY valid JSON — no prose, no markdown:
{
  "tissue_key": "skin_dermis|skin_epidermis|cartilage|corneal",
  "sex": "men|women",
  "bio": {},
  "hla": {},
  "immune_flags": {"autoimmune_active": false, "prior_rejection": false},
  "patient_meta": {
    "sex": "men|women",
    "mechanical_load": "low|medium|high",
    "dimensions": {"length_mm": 20, "width_mm": 20, "depth_mm": 2}
  }
}"""

# ─────────────────────────────────────────────────────────────────
# FASTAPI
# ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Zyogen BioSim API v2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    conn = sqlite3.connect("biosim.db")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    db = get_db()
    # check if schema is stale and migrate automatically
    try:
        cols = [r[1] for r in db.execute("PRAGMA table_info(sim_runs)").fetchall()]
        if cols and len(cols) != 10:
            db.execute("DROP TABLE sim_runs")
            db.commit()
    except Exception:
        pass
    db.execute("""
        CREATE TABLE IF NOT EXISTS sim_runs (
            id            TEXT PRIMARY KEY,
            tissue_key    TEXT,
            sex           TEXT,
            risk_tier     TEXT,
            quality_score REAL,
            viability_24h REAL,
            input_data    TEXT,
            result        TEXT,
            label         TEXT,
            created_at    TEXT
        )
    """)
    db.commit()

init_db()

class SimPayload(BaseModel):
    tissue_key:      str
    sex:             str
    bio:             dict
    hla:             dict = {}
    immune_flags:    dict = {}
    patient_meta:    dict = {}
    label:           Optional[str] = None
    # Fix 1: supply this to chain this run on top of a previous result
    baseline_run_id: Optional[str] = None

class PromptPayload(BaseModel):
    prompt: str

class ComparePayload(BaseModel):
    run_a_id: str
    run_b_id: str

@app.post("/biosim/runs")
def create_run(payload: SimPayload):
    # Fix 1: load baseline result when baseline_run_id is provided so this run
    # chains sequentially from that state rather than recalculating from scratch.
    baseline_result = None
    if payload.baseline_run_id:
        db = get_db()
        row = db.execute("SELECT result FROM sim_runs WHERE id=?", (payload.baseline_run_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Baseline run {payload.baseline_run_id} not found")
        baseline_result = json.loads(row["result"])

    result = run_simulation(payload.model_dump(), baseline_result=baseline_result)
    if "error" in result:
        raise HTTPException(status_code=422, detail=result)

    run_id = str(uuid.uuid4())
    risk_tier = result["stages"]["rejection"]["risk_tier"]
    quality   = result["stages"]["physics"]["quality_score"]
    v24       = result["stages"]["viability"]["24h"]
    db = get_db()
    db.execute(
        "INSERT INTO sim_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
        (run_id, payload.tissue_key, payload.sex, risk_tier, quality, v24,
         json.dumps(payload.model_dump()), json.dumps(result),
         payload.label or f"{payload.tissue_key} · {payload.sex}",
         datetime.now().isoformat())
    )
    db.commit()
    return {"run_id": run_id, **result}

@app.get("/biosim/runs")
def list_runs():
    db = get_db()
    rows = db.execute(
        "SELECT id, tissue_key, sex, risk_tier, quality_score, viability_24h, label, created_at FROM sim_runs ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    return [dict(r) for r in rows]

@app.get("/biosim/runs/{run_id}")
def get_run(run_id: str):
    db = get_db()
    row = db.execute("SELECT * FROM sim_runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    r = dict(row)
    r["result"]     = json.loads(r["result"])
    r["input_data"] = json.loads(r["input_data"])
    return r

@app.post("/biosim/compare")
def compare_runs(body: ComparePayload):
    db = get_db()
    rows = {rid: db.execute("SELECT * FROM sim_runs WHERE id=?", (rid,)).fetchone()
            for rid in [body.run_a_id, body.run_b_id]}
    for rid, row in rows.items():
        if not row:
            raise HTTPException(status_code=404, detail=f"Run {rid} not found")

    a = json.loads(dict(rows[body.run_a_id])["result"])
    b = json.loads(dict(rows[body.run_b_id])["result"])

    def summary(r):
        return {
            "tissue_target":  r.get("tissue_key"),
            "physics":        r["stages"]["physics"],
            "viability":      {k: v for k, v in r["stages"]["viability"].items() if k != "modifiers"},
            "rejection":      {k: v for k, v in r["stages"]["rejection"].items() if k != "rejection_curve"},
            "metabolic":      r["stages"]["metabolic"],
            "anomaly_flags":  [f.get("flag") or f.get("error") for f in r.get("flags", [])],
        }

    ai_output = call_openai(summary(a), compare_summary=summary(b))

    delta = {
        "viability_24h": round(b["stages"]["viability"]["24h"] - a["stages"]["viability"]["24h"], 1),
        "viability_72h": round(b["stages"]["viability"]["72h"] - a["stages"]["viability"]["72h"], 1),
        "viability_7d":  round(b["stages"]["viability"]["7d"]  - a["stages"]["viability"]["7d"],  1),
        "rejection_probability": round(b["stages"]["rejection"]["rejection_probability"] - a["stages"]["rejection"]["rejection_probability"], 3),
        "quality_score": round(b["stages"]["physics"]["quality_score"] - a["stages"]["physics"]["quality_score"], 3),
        "shear_stress":  round(b["stages"]["physics"]["shear_stress_pa"] - a["stages"]["physics"]["shear_stress_pa"], 2),
        "metabolic_composite": round(b["stages"]["metabolic"]["composite"] - a["stages"]["metabolic"]["composite"], 3),
    }

    return {
        "run_a": {"id": body.run_a_id, **a},
        "run_b": {"id": body.run_b_id, **b},
        "delta": delta,
        "ai_output": ai_output,
    }

class ChatPayload(BaseModel):
    question: str
    sim_context: dict  # the full stages + formulation from the current result
    history: list[dict] = []  # [{role, content}, ...] prior turns

CHAT_SYSTEM = """You are a clinical bioprinting expert embedded in the Zyogen BioSim platform.
You have access to the exact computed simulation values for the current run.
Answer the clinician or engineer's question specifically, referencing the actual numbers provided.

Rules:
- Only reference values present in the sim_context. Never invent numbers.
- Use clinical language but keep it accessible.
- Never diagnose. Use "values suggest", "flags for review", "indicates".
- Short answers: 2-4 sentences unless a detailed explanation is explicitly asked for.
- Always end answers with: "Research aid — requires validation."
- Plain text only — no markdown, no bullet points unless asked."""

@app.post("/biosim/chat")
def chat_on_result(body: ChatPayload):
    context_block = json.dumps(body.sim_context, indent=2)
    messages = [
        {"role": "system", "content": CHAT_SYSTEM},
        {"role": "user",   "content": f"Current simulation data:\n{context_block}"},
        {"role": "assistant", "content": "Understood. I have the simulation data. Ask me anything about it."},
    ]
    for h in body.history[-6:]:  # keep last 3 turns of real history
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": body.question})

    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=0.2,
        max_tokens=400,
    )
    return {"answer": resp.choices[0].message.content.strip()}

class AgentPayload(BaseModel):
    message: str
    current_run_id: Optional[str] = None
    history: list[dict] = []  # [{role, content}] prior turns

AGENT_SYSTEM = """You are the Zyogen BioSim agentic assistant.
You decide what action to take based on the user's message and current simulation state.

You MUST return ONLY a valid JSON object — no prose, no markdown, no code fences.

{
  "action": "<one of: simulate | answer | show_card | modify_params | clarify>",
  "text": "<short conversational reply, plain string>",
  "card": null | { "type": "<stats|viability|rejection|physics|metabolic|hla|flags|longterm|gene>", "title": "<string>" },
  "sim_payload": null | { FULL payload — see format below },
  "param_edits": null | { only the changed fields from: "nozzle_gauge", "gelma_pct", "pressure_override" }
}

sim_payload format (ALL fields required when action=simulate):
{
  "tissue_key": "skin_dermis|skin_epidermis|cartilage|corneal",
  "sex": "men|women",
  "bio": {
    "hemoglobin": <number g/dL>,
    "glucose": <number mg/dL>,
    "wbc": <number 10^3/µL, e.g. 7.0>,
    "platelets": <number 10^3/µL, e.g. 250>,
    "creatinine": <number mg/dL, e.g. 0.9>,
    "igg": <number mg/dL, e.g. 1000>
  },
  "hla": {},
  "immune_flags": { "autoimmune_active": false, "prior_rejection": false, "hla_confirmed_match": false },
  "patient_meta": { "mechanical_load": "medium", "dimensions": { "length_mm": 20, "width_mm": 20, "depth_mm": 2 } }
}

IMPORTANT bio unit rules:
- wbc: 10^3/µL — 7800/cumm = 7.8
- platelets: 10^3/µL — 250000 = 250
- hemoglobin: g/dL — normal range ~12-17
- glucose: mg/dL — normal ~70-99
- creatinine: mg/dL — normal ~0.6-1.2
- igg: mg/dL — normal ~700-1600

Action rules:
- "simulate": user describing a patient or asking to run. Build complete sim_payload.
- "answer": question about current sim — text only, card null, no simulation.
- "show_card": user wants to see a view — set card type, text explains it. Never re-simulate.
- "modify_params": user wants to change nozzle/GelMA/pressure on current run. Set param_edits only.
- "clarify": not enough info to simulate. Ask in text."""

@app.post("/biosim/agent")
def agent(body: AgentPayload):
    current_sim_summary = None
    if body.current_run_id:
        db = get_db()
        row = db.execute("SELECT result FROM sim_runs WHERE id=?", (body.current_run_id,)).fetchone()
        if row:
            r = json.loads(row["result"])
            current_sim_summary = {
                "tissue": r.get("tissue_key"),
                "formulation": r.get("formulation"),
                "physics": r["stages"]["physics"],
                "viability": {k: v for k, v in r["stages"]["viability"].items() if k != "modifiers"},
                "rejection": {k: v for k, v in r["stages"]["rejection"].items() if k != "rejection_curve"},
                "metabolic": r["stages"]["metabolic"],
                "flags": [f.get("flag") or f.get("error") for f in r.get("flags", [])],
            }

    state_block = f"\nCurrent simulation:\n{json.dumps(current_sim_summary, indent=2)}" if current_sim_summary else "\nNo simulation loaded yet."
    messages = [
        {"role": "system", "content": AGENT_SYSTEM + state_block},
    ]
    for h in body.history[-8:]:
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": body.message})

    resp = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=messages,
        temperature=0.1,
        max_tokens=800,
    )
    result = json.loads(resp.choices[0].message.content)

    # Ensure sim_payload always has required defaults so it doesn't 422
    if result.get("action") == "simulate" and isinstance(result.get("sim_payload"), dict):
        sp = result["sim_payload"]
        sp.setdefault("hla", {})
        sp.setdefault("immune_flags", {"autoimmune_active": False, "prior_rejection": False, "hla_confirmed_match": False})
        sp.setdefault("patient_meta", {"mechanical_load": "medium", "dimensions": {"length_mm": 20, "width_mm": 20, "depth_mm": 2}})
        bio = sp.setdefault("bio", {})
        bio.setdefault("hemoglobin", 13.5)
        bio.setdefault("glucose", 90.0)
        bio.setdefault("wbc", 7.0)
        bio.setdefault("platelets", 250.0)
        bio.setdefault("creatinine", 0.9)
        bio.setdefault("igg", 1000.0)

    # If modify_params, merge edits onto current sim payload and chain
    if result.get("action") == "modify_params" and body.current_run_id and result.get("param_edits"):
        db = get_db()
        row = db.execute("SELECT input_data, result FROM sim_runs WHERE id=?", (body.current_run_id,)).fetchone()
        if row:
            base_input = json.loads(row["input_data"])
            base_result = json.loads(row["result"])
            edits = result["param_edits"]
            # Apply top-level overrides
            for k in ["tissue_key", "sex"]:
                if k in edits:
                    base_input[k] = edits[k]
            # GelMA/nozzle go into formulation overrides stored in patient_meta
            pm = base_input.setdefault("patient_meta", {})
            for k in ["gelma_pct", "nozzle_gauge", "pressure_override"]:
                if k in edits:
                    pm[f"override_{k}"] = edits[k]
            base_input["baseline_run_id"] = body.current_run_id
            sim_result = run_simulation(base_input, baseline_result=base_result)
            if "error" not in sim_result:
                run_id = str(uuid.uuid4())
                db.execute(
                    "INSERT INTO sim_runs VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (run_id, sim_result["tissue_key"],
                     base_input["sex"],
                     sim_result["stages"]["rejection"]["risk_tier"],
                     sim_result["stages"]["physics"]["quality_score"],
                     sim_result["stages"]["viability"]["24h"],
                     json.dumps(base_input), json.dumps(sim_result),
                     f"Modified · {sim_result['formulation']['display']}",
                     datetime.now().isoformat())
                )
                db.commit()
                result["sim_result"] = sim_result
                result["new_run_id"] = run_id

    return result

@app.post("/biosim/generate-payload")
def generate_payload(body: PromptPayload):
    resp = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": NLP_SYSTEM},
            {"role": "user",   "content": body.prompt},
        ],
        temperature=0.0,
        max_tokens=900,
    )
    payload = json.loads(resp.choices[0].message.content)
    return {"payload": payload}

@app.delete("/biosim/runs/{run_id}")
def delete_run(run_id: str):
    db = get_db()
    db.execute("DELETE FROM sim_runs WHERE id=?", (run_id,))
    db.commit()
    return {"deleted": run_id}

@app.get("/biosim/health")
def health():
    return {"status": "ok", "version": "2.0", "tissues": list(FORMULATIONS.keys())}

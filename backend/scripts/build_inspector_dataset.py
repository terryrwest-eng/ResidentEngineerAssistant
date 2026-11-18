"""
Offline Fine-Tuning Dataset Builder for Terry's Resident Engineer / Inspector Voice.

Cost: $0.00 (100% local Python — zero external API calls).
OneDrive Safety: Checks Windows `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_OFFLINE`
(`0x401000`) before opening any file so cloud-only OneDrive stubs are never hydrated.

Sources read (priority order):
1. Rebuilt DRB-audited MCN reports:
   `C:\\Users\\Terry\\OneDrive - City of San Diego\\Morena Conveyance North\\19 - Daily Report Reconstruction\\_reports\\_data\\*.json`
2. Daily Field Report Word exports:
   `C:\\Users\\Terry\\OneDrive - City of San Diego\\Morena Conveyance North\\06 - Daily Reports\\2025\\*.docx`
   `C:\\Users\\Terry\\OneDrive - City of San Diego\\Morena Conveyance North\\06 - Daily Reports\\2026\\*.docx`
   (Dates already covered by Source 1 are skipped so superseded drafts never dilute audited reports.)

Outputs written under `DAILY-REPORTER-V3/training_data/`:
- `inspector_voice_train.jsonl` (OpenAI / Unsloth ChatML `{"messages": [...]}` format)
- `inspector_voice_val.jsonl`
- `dataset_manifest.json` (exact file, activity, and example counts)
"""

from __future__ import annotations

import json
import logging
import os
import pathlib
import re
import sys
from typing import TypedDict

import docx

# Allow running directly from DAILY-REPORTER-V3 root
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.services.narrative_model import (  # noqa: E402
    SECOND_PASS_BULLET_SYSTEM_PROMPT,
    SECOND_PASS_PROSE_SYSTEM_PROMPT,
)
from app.services.summary_format import (  # noqa: E402
    INSPECTOR_VOICE_RULES,
    clean_inspector_prose,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("build_inspector_dataset")

ONEDRIVE_CLOUD_STUB_MASK: int = 0x401000

REBUILT_JSON_DIR = pathlib.Path(
    r"C:\Users\Terry\OneDrive - City of San Diego\Morena Conveyance North"
    r"\19 - Daily Report Reconstruction\_reports\_data"
)
DAILY_REPORTS_DIR = pathlib.Path(
    r"C:\Users\Terry\OneDrive - City of San Diego\Morena Conveyance North"
    r"\06 - Daily Reports"
)
GAS_CO_DIR = pathlib.Path(r"C:\Users\Terry\OneDrive\Gas Co")
OUTPUT_DIR = REPO_ROOT / "training_data"

RESOURCE_HEADERS = {
    "manpower:",
    "equipment:",
    "extra work manpower:",
    "extra work equipment:",
    "consultants:",
}

NUMBER_WORDS = {
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
    "9": "nine",
    "10": "ten",
    "12": "twelve",
}


class ExtractedActivity(TypedDict):
    work_area: str
    stations: str
    bullets: list[str]


class ExtractedReport(TypedDict):
    report_date: str
    source_kind: str
    source_file: str
    general_notes: str
    activities: list[ExtractedActivity]


def is_locally_cached(path: pathlib.Path) -> bool:
    """Return True only when the file is physically present on local disk."""
    try:
        st = path.stat()
    except OSError as exc:
        logger.warning("Cannot stat %s: %s", path, exc)
        return False
    attrs = getattr(st, "st_file_attributes", 0)
    return (attrs & ONEDRIVE_CLOUD_STUB_MASK) == 0


def _parse_date_from_text_or_name(text: str, filename: str) -> str:
    """Extract canonical YYYY-MM-DD date from report header or filename."""
    m_iso = re.search(r"(202[4-9])-(\d{2})-(\d{2})", filename)
    if m_iso:
        return f"{m_iso.group(1)}-{m_iso.group(2)}-{m_iso.group(3)}"
    m_mdy = re.search(r"(\d{2})-(\d{2})-(202[4-9])", text + " " + filename)
    if m_mdy:
        return f"{m_mdy.group(3)}-{m_mdy.group(1)}-{m_mdy.group(2)}"
    return filename


def _clean_bullet_list(raw_lines: list[str], where: str) -> list[str]:
    """Clean and normalize bullet lines while keeping every factual detail intact."""
    joined = "\n".join(raw_lines)
    cleaned_block = clean_inspector_prose(joined, where)
    bullets: list[str] = []
    for raw_ln in cleaned_block.splitlines():
        ln = raw_ln.strip()
        if not ln:
            continue
        if ln.startswith(("Start Time:", "End Time:", "Hours:")):
            continue
        if ln.lower().startswith("imported from:"):
            continue
        # Skip raw digout schedule sub-rows when building narrative prose targets
        if re.match(r"^[-–]\s*(?:[NESW]B\s+)?DO\s*#", ln):
            continue
        ln = re.sub(r"^[•\-\*–]\s*", "", ln).strip()
        if len(ln) < 12:
            continue
        if not ln.endswith((".", "!", "?")):
            ln += "."
        bullets.append(f"• {ln}")
    return bullets


def load_rebuilt_json_reports() -> tuple[list[ExtractedReport], int]:
    """Load audited MCN JSON reports from `19 - Daily Report Reconstruction`."""
    reports: list[ExtractedReport] = []
    skipped_cloud = 0
    if not REBUILT_JSON_DIR.exists():
        logger.warning("Rebuilt JSON directory not found: %s", REBUILT_JSON_DIR)
        return reports, skipped_cloud

    for jf in sorted(REBUILT_JSON_DIR.glob("*.json")):
        if not is_locally_cached(jf):
            skipped_cloud += 1
            continue
        try:
            raw = json.loads(jf.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed reading JSON %s: %s", jf, exc)
            continue

        r_date = str(raw.get("date") or jf.stem).strip()
        notes = clean_inspector_prose(str(raw.get("notes") or "").strip(), f"json.{r_date}.notes")
        acts: list[ExtractedActivity] = []
        for idx, act in enumerate(raw.get("activities") or []):
            if not isinstance(act, dict):
                continue
            work_area = str(act.get("work_area") or act.get("title") or "").strip()
            stations = str(act.get("stations") or "").strip()
            raw_bullets = [str(b) for b in (act.get("bullets") or []) if str(b).strip()]
            if not raw_bullets and act.get("summary"):
                raw_bullets = str(act.get("summary") or "").splitlines()
            bullets = _clean_bullet_list(raw_bullets, f"json.{r_date}.act{idx}")
            if bullets:
                acts.append({
                    "work_area": work_area,
                    "stations": stations,
                    "bullets": bullets,
                })
        if acts or notes:
            reports.append({
                "report_date": r_date,
                "source_kind": "rebuilt_mcn_json",
                "source_file": jf.name,
                "general_notes": notes,
                "activities": acts,
            })
    return reports, skipped_cloud


def parse_docx_report(path: pathlib.Path) -> ExtractedReport | None:
    """Extract General Notes and per-activity bullet lists from a Daily Field Report .docx."""
    try:
        doc = docx.Document(str(path))
    except Exception as exc:
        logger.warning("Failed opening DOCX %s: %s", path.name, exc)
        return None

    paragraphs = doc.paragraphs
    if not paragraphs:
        return None

    first_text = paragraphs[0].text.strip()
    report_date = _parse_date_from_text_or_name(first_text, path.name)

    general_notes_lines: list[str] = []
    activities: list[ExtractedActivity] = []

    section = "header"
    current_title = ""
    current_lines: list[str] = []
    in_resources = False

    def flush_activity() -> None:
        nonlocal current_title, current_lines, in_resources
        if current_title and current_lines:
            stations = ""
            work_area = current_title
            if " — " in current_title:
                work_area, stations = [p.strip() for p in current_title.split(" — ", 1)]
            bullets = _clean_bullet_list(current_lines, f"docx.{report_date}.{work_area}")
            if bullets:
                activities.append({
                    "work_area": work_area,
                    "stations": stations,
                    "bullets": bullets,
                })
        current_title = ""
        current_lines = []
        in_resources = False

    for par in paragraphs[1:]:
        txt = par.text.strip()
        if not txt:
            continue
        style_name = (par.style.name if par.style else "") or ""
        is_bold = any(bool(r.bold) for r in par.runs if r.text.strip())

        if txt == "General Notes:":
            section = "notes"
            continue
        if style_name.startswith("Heading") and "Activities Detail" in txt:
            section = "activities"
            continue
        if style_name.startswith("Heading") and "Consolidated Resources" in txt:
            flush_activity()
            break

        if section == "notes":
            general_notes_lines.append(txt)
            continue

        if section == "activities":
            low = txt.lower()
            if low in RESOURCE_HEADERS or low.startswith("hours:"):
                in_resources = True
                continue
            if txt.startswith(("DAILY FIELD REPORT", "Project:", "Prepared By:", "Resident Engineer:", "Weather:")):
                in_resources = True
                continue
            # New activity title: bold single-line header outside bullet markers
            if is_bold and not txt.startswith(("•", "-", "*", "–")) and "\n" not in txt:
                flush_activity()
                current_title = txt
                continue
            if not in_resources and current_title:
                for sub_ln in txt.splitlines():
                    if sub_ln.strip():
                        current_lines.append(sub_ln.strip())

    flush_activity()
    cleaned_notes = clean_inspector_prose(
        "\n".join(general_notes_lines).strip(), f"docx.{report_date}.notes"
    )
    if not activities and not cleaned_notes:
        return None

    return {
        "report_date": report_date,
        "source_kind": "daily_report_docx",
        "source_file": path.name,
        "general_notes": cleaned_notes,
        "activities": activities,
    }


def make_rough_shorthand(bullets: list[str]) -> str:
    """
    Convert clean inspector bullets into realistic rough field-note shorthand
    WITHOUT dropping a single station, measurement, company, or fact.
    """
    notes: list[str] = []
    for b in bullets:
        s = re.sub(r"^•\s*", "", b).strip().rstrip(".")
        # Strip leading articles and casualize connectors into field notebook style
        s = re.sub(r"^(?:The crew|Crew)\s+", "", s)
        s = re.sub(r"\band\s+", "& ", s, count=1)
        if len(s) > 1 and s[0].isupper() and not s.startswith(("OHL", "HMS", "SRK", "AV-", "BO-", "BF-", "I ")):
            s = s[0].lower() + s[1:]
        notes.append(f"- {s}")
    return "\n".join(notes)


def make_stiff_ai_draft(bullets: list[str]) -> str:
    """
    Create a synthetic 'bad AI draft' carrying the exact same facts (introducing
    third-person 'The inspector', stiff corporate verbs, and legal number parens)
    so Pass 2 fine-tuning learns to strip every AI tell while preserving 100% of facts.
    """
    corrupted: list[str] = []
    for b in bullets:
        s = b
        # Inject third-person inspector phrasing on RE observation bullets
        s = re.sub(
            r"^•\s*(?:I\s+)?(Visited|Walked|Met\s+with|Inspected|Reminded|Checked)\b",
            lambda m: f"• The inspector {m.group(1).lower()}",
            s,
        )
        # Inject stiff corporate words
        s = re.sub(r"\bused\b", "utilized", s)
        s = re.sub(r"\bstarted\b", "commenced", s)
        s = re.sub(r"\bbefore\b", "prior to", s)
        s = re.sub(r"\bBMPs\b", "Best Management Practices (BMPs)", s)
        s = re.sub(r"\bcathodic protection\b", "cathodic protection (CP)", s, flags=re.IGNORECASE)
        # Inject legal number parentheticals on standalone small counts (not stations/times)
        s = re.sub(
            r"(?<![\d+:\.-])\b([2-9]|10|12)\b(?!\s*(?::|AM|PM|inch|in\b|ft\b|%|tons|\+))",
            lambda m: f"{NUMBER_WORDS[m.group(1)]} ({m.group(1)})",
            s,
            count=1,
        )
        corrupted.append(s)
    return "\n".join(corrupted)


GENERAL_NOTES_SYSTEM_PROMPT: str = (
    "You are a 20+ year Pipeline Construction Resident Engineer writing the "
    "General Notes overview at the top of your daily construction report.\n\n"
    "RULES:\n"
    "1. Walk through the day's activities in order in 1 to 2 direct sentences per "
    "activity so the reader sees what happened and where before reading the detail.\n"
    "2. Include any site visits, delays, utility conflicts, testing, or discussions "
    "you had on site.\n"
    "3. Write zero parentheses anywhere in General Notes and never refer to yourself "
    "in the third person.\n\n"
    + INSPECTOR_VOICE_RULES
)


def build_training_examples(reports: list[ExtractedReport]) -> list[tuple[str, dict]]:
    """Build `(report_date, chatml_example)` pairs across all 3 narrative tasks."""
    examples: list[tuple[str, dict]] = []

    rewrite_sys = (
        "You are a 20+ year Pipeline Construction Resident Engineer and Field Inspector "
        "cleaning up rough field notes into direct, factual daily report bullets in your own voice.\n\n"
        + INSPECTOR_VOICE_RULES
    )

    for rep in reports:
        r_date = rep["report_date"]
        for act in rep["activities"]:
            target_bullets = "\n".join(act["bullets"]).strip()
            if not target_bullets:
                continue

            loc_header = f"Location: {act['work_area']}"
            if act["stations"]:
                loc_header += f"\nStations: {act['stations']}"

            # Example Type 1: Rough field shorthand -> Inspector bullets
            rough_input = make_rough_shorthand(act["bullets"])
            examples.append((
                r_date,
                {
                    "messages": [
                        {"role": "system", "content": rewrite_sys},
                        {
                            "role": "user",
                            "content": f"{loc_header}\nRAW FIELD NOTES TO TRANSFORM:\n{rough_input}",
                        },
                        {"role": "assistant", "content": target_bullets},
                    ]
                },
            ))

            # Example Type 2: Stiff AI draft -> Clean Pass 2 Inspector bullets
            stiff_draft = make_stiff_ai_draft(act["bullets"])
            if stiff_draft != target_bullets:
                examples.append((
                    r_date,
                    {
                        "messages": [
                            {"role": "system", "content": SECOND_PASS_BULLET_SYSTEM_PROMPT},
                            {
                                "role": "user",
                                "content": f"DRAFT FIELD TEXT TO REWRITE IN RESIDENT ENGINEER VOICE:\n{stiff_draft}",
                            },
                            {"role": "assistant", "content": target_bullets},
                        ]
                    },
                ))

        # Example Type 3: Day's activities -> General Notes overview
        notes = rep["general_notes"].strip()
        if notes and len(notes) >= 40 and rep["activities"]:
            act_digest = "\n\n".join(
                f"ACTIVITY: {a['work_area']}\n" + "\n".join(a["bullets"])
                for a in rep["activities"]
            )
            examples.append((
                r_date,
                {
                    "messages": [
                        {"role": "system", "content": GENERAL_NOTES_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": f"WRITE GENERAL NOTES FROM TODAY'S ACTIVITIES:\n\n{act_digest}",
                        },
                        {"role": "assistant", "content": notes},
                    ]
                },
            ))
            # Also include Pass 2 prose de-stiffening example when notes can be synthetically stiffened
            stiff_notes = make_stiff_ai_draft([f"• {notes}"])[2:].strip()
            if stiff_notes != notes:
                examples.append((
                    r_date,
                    {
                        "messages": [
                            {"role": "system", "content": SECOND_PASS_PROSE_SYSTEM_PROMPT},
                            {
                                "role": "user",
                                "content": f"DRAFT FIELD TEXT TO REWRITE IN RESIDENT ENGINEER VOICE:\n{stiff_notes}",
                            },
                            {"role": "assistant", "content": notes},
                        ]
                    },
                ))

    return examples


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Rebuilt JSON reports (highest authority)
    rebuilt_reports, rebuilt_cloud_skipped = load_rebuilt_json_reports()
    covered_dates = {r["report_date"] for r in rebuilt_reports}
    logger.info(
        "Loaded %d rebuilt MCN JSON reports (cloud stubs skipped: %d)",
        len(rebuilt_reports),
        rebuilt_cloud_skipped,
    )

    # 2. Daily Field Report .docx files (2025 + 2026) not superseded by rebuilt JSON
    docx_reports: list[ExtractedReport] = []
    docx_cloud_skipped = 0
    docx_superseded = 0
    for year_sub in ("2025", "2026"):
        folder = DAILY_REPORTS_DIR / year_sub
        if not folder.exists():
            continue
        for df in sorted(folder.glob("*.docx")):
            if df.name.startswith("~$"):
                continue
            if not is_locally_cached(df):
                docx_cloud_skipped += 1
                continue
            parsed = parse_docx_report(df)
            if not parsed:
                continue
            if parsed["report_date"] in covered_dates:
                docx_superseded += 1
                continue
            covered_dates.add(parsed["report_date"])
            docx_reports.append(parsed)

    logger.info(
        "Loaded %d non-overlapping DOCX reports (superseded by rebuilt JSON: %d, cloud stubs skipped: %d)",
        len(docx_reports),
        docx_superseded,
        docx_cloud_skipped,
    )

    # 3. Optional Gas Co archive check (--check-gas-co; 219,864 files in tree)
    gas_co_total = 0
    gas_co_local = 0
    if "--check-gas-co" in sys.argv and GAS_CO_DIR.exists():
        for pf in GAS_CO_DIR.rglob("*.pdf"):
            if pf.is_file():
                gas_co_total += 1
                if is_locally_cached(pf):
                    gas_co_local += 1
        logger.info(
            "SoCalGas archive check: %d total PDFs, %d locally cached (%d cloud-only stubs left untouched)",
            gas_co_total,
            gas_co_local,
            gas_co_total - gas_co_local,
        )

    all_reports = sorted(rebuilt_reports + docx_reports, key=lambda r: r["report_date"])
    dated_examples = build_training_examples(all_reports)

    # Verify zero leaked notices or illegal self-references in assistant targets.
    # Anaphoric "the inspector" is valid ONLY when a specific outside specialty
    # inspector (City inspector, weld inspector, electrical inspector, Kleinfelder)
    # was explicitly named in the same text block.
    outside_inspector_re = re.compile(
        r"\b(?:City|weld|welding|electrical|cathodic|Kleinfelder|San\s+Diego|deputy|special)\s+inspector\b",
        re.IGNORECASE,
    )
    target_violations = 0
    for r_date, ex in dated_examples:
        assistant_text = ex["messages"][-1]["content"]
        if "No report exists for" in assistant_text:
            logger.error("Leaked no-report notice on %s: %r", r_date, assistant_text)
            target_violations += 1
            continue
        if re.search(r"\bThe\s+Resident\s+Engineer\b", assistant_text, re.IGNORECASE):
            logger.error("Third-person Resident Engineer on %s: %r", r_date, assistant_text)
            target_violations += 1
            continue
        if re.search(r"\bThe\s+inspector\b", assistant_text, re.IGNORECASE) and not outside_inspector_re.search(
            assistant_text
        ):
            logger.error("Third-person self-reference on %s: %r", r_date, assistant_text)
            target_violations += 1

    if target_violations:
        logger.error("Aborting: %d target cleanliness violations found", target_violations)
        return 1

    # Deterministic 90/10 split by index (ordered chronologically)
    train_items: list[dict] = []
    val_items: list[dict] = []
    for idx, (_, item) in enumerate(dated_examples):
        if idx % 10 == 9:
            val_items.append(item)
        else:
            train_items.append(item)

    train_path = OUTPUT_DIR / "inspector_voice_train.jsonl"
    val_path = OUTPUT_DIR / "inspector_voice_val.jsonl"
    manifest_path = OUTPUT_DIR / "dataset_manifest.json"

    with train_path.open("w", encoding="utf-8") as f_tr:
        for row in train_items:
            f_tr.write(json.dumps(row, ensure_ascii=False) + "\n")

    with val_path.open("w", encoding="utf-8") as f_va:
        for row in val_items:
            f_va.write(json.dumps(row, ensure_ascii=False) + "\n")

    total_activities = sum(len(r["activities"]) for r in all_reports)
    manifest = {
        "rebuilt_json_reports": len(rebuilt_reports),
        "docx_reports_used": len(docx_reports),
        "docx_superseded_by_rebuilt_json": docx_superseded,
        "total_unique_reports": len(all_reports),
        "total_activities": total_activities,
        "train_examples": len(train_items),
        "val_examples": len(val_items),
        "total_examples": len(dated_examples),
        "gas_co_pdfs_total": gas_co_total,
        "gas_co_pdfs_locally_cached": gas_co_local,
        "target_violations": target_violations,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    logger.info("Wrote dataset: %s", json.dumps(manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

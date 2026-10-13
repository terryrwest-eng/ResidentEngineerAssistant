"""
Verify how an activity's work area is split for PMWeb's On Site grid.

Terry's format is "Location - Company - Title". The PMWeb export read every work
area by position, so a two-part one, "AR Concrete - curb ramps and concrete
flatwork", put the company in Location and the description in Company, and the
row went into PMWeb with Company and Activities blank (2026-01-06 and
2026-01-07, found 2026-10-13). split_work_area() reads a short work area by what
its parts are. This checks the rule, that a three-part work area reads exactly
as before, and that both PMWeb endpoints call it.

Run from the repo root:  python3 backend/tests/test_work_area_split.py
"""
import inspect
import os
import sys
import tempfile

sys.path.insert(0, "backend")

os.environ.setdefault(
    "DAILY_REPORTER_DATA_DIR", tempfile.mkdtemp(prefix="rea-workarea-")
)

from app.services.pmweb_mappings import split_work_area  # noqa: E402

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  -- got {got!r}, want {want!r}"))


def act(work_area, crew=(), gear=()):
    return {
        "work_area": work_area,
        "manpower": [{"trade": "laborer", "qty": 1, "hours": 8, "company": c} for c in crew],
        "equipment": [{"name": "pickup truck", "qty": 1, "hours": 8, "company": c} for c in gear],
    }


# ── Terry's format reads exactly as before ───────────────────────────────────

check("three parts: location, company, title",
      split_work_area(act("Marian Bear Park, Blow-off #5 - OHLA - 8-inch blow-off trench", ["OHLA"])),
      ("Marian Bear Park, Blow-off #5", "OHLA", "8-inch blow-off trench"))
check("three parts: a company no row names is taken as written",
      split_work_area(act("Marian Bear Park - GC fence - Caltrans Fence Installation", ["OHLA"])),
      ("Marian Bear Park", "GC fence", "Caltrans Fence Installation"))

# ── Several companies named: PMWeb gets the first (Terry, 2026-10-13) ─────────

check("three companies split by slashes give the first",
      split_work_area(act("Marian Bear Park, Blow-off #5 - OHLA / Dean's Welding / Penhall - 8-inch blow-off assembly",
                          ["OHLA", "Dean's Welding"])),
      ("Marian Bear Park, Blow-off #5", "OHLA", "8-inch blow-off assembly"))
check("two companies joined by & give the first",
      split_work_area(act("Executive - OHLA & Picket Fences - Irrigation & Utility Investigation", ["OHLA"])),
      ("Executive", "OHLA", "Irrigation & Utility Investigation"))
check("an & inside one name is not a split",
      split_work_area(act("Genesee Ave - SDG&E - gas service relocation", ["SDG&E"])),
      ("Genesee Ave", "SDG&E", "gas service relocation"))
check("Pickett Fences is PMWeb's Picket Fences",
      split_work_area(act("Genesee Avenue Median - Pickett Fences - Site Work", ["Pickett Fences"])),
      ("Genesee Avenue Median", "Picket Fences", "Site Work"))
check("a two-part work area naming several companies gives the first",
      split_work_area(act("OHLA / Dean's Welding - 8-inch blow-off welding", ["OHLA", "Dean's Welding"])),
      ("", "OHLA", "8-inch blow-off welding"))
check("a two-part work area whose second part names several companies",
      split_work_area(act("Executive Dr - OHLA & Picket Fences", ["Picket Fences"])),
      ("Executive Dr", "OHLA", ""))
check("hyphens inside words do not split",
      split_work_area(act("30-inch force main - OHLA - interior joint patching", ["OHLA"])),
      ("30-inch force main", "OHLA", "interior joint patching"))

# ── Two parts: the company first ─────────────────────────────────────────────

check("company then description (2026-01-06's AR Concrete row)",
      split_work_area(act("AR Concrete - curb ramps and concrete flatwork", ["AR Concrete"], ["AR Concrete"])),
      ("", "AR Concrete", "curb ramps and concrete flatwork"))
check("company then description, the company named only on an equipment row",
      split_work_area(act("AR Concrete - curb ramps", [], ["AR Concrete"])),
      ("", "AR Concrete", "curb ramps"))
check("company matched regardless of case",
      split_work_area(act("ar concrete - curb ramps", ["AR Concrete"])),
      ("", "ar concrete", "curb ramps"))

# ── Two parts: the company second ────────────────────────────────────────────

check("location then company (2025-12-30's fibre optic row)",
      split_work_area(act("Fibre optic backfill and 8-inch drain line to the vault - OHLA", ["OHLA"])),
      ("Fibre optic backfill and 8-inch drain line to the vault", "OHLA", ""))
check("OHLA in the work area matches OHL NA on the rows",
      split_work_area(act("Vault #7 - OHLA", ["OHL NA"])),
      ("Vault #7", "OHLA", ""))

# ── Two parts: no company named ──────────────────────────────────────────────

check("location then description, the company from the one crew company",
      split_work_area(act("Radcliffe Lane at Genesee Avenue - slab-on-grade pour and finish",
                          ["Brino Builders"], ["Brino Builders", "Kleinfelder"])),
      ("Radcliffe Lane at Genesee Avenue", "Brino Builders", "slab-on-grade pour and finish"))
check("location then description, two crew companies leave Company blank",
      split_work_area(act("Towne Center in front of UTC Mall - Traffic Control & Formwork",
                          ["AR Concrete", "HMS"])),
      ("Towne Center in front of UTC Mall", "", "Traffic Control & Formwork"))
check("location then description, no crew rows leave Company blank",
      split_work_area(act("Genesee Avenue - asphalt patch")),
      ("Genesee Avenue", "", "asphalt patch"))

# ── One part ─────────────────────────────────────────────────────────────────

check("location only, the company from the one crew company",
      split_work_area(act("Genesee", ["AR Concrete"])),
      ("Genesee", "AR Concrete", ""))
check("an empty work area stays empty",
      split_work_area(act("")),
      ("", "", ""))
check("a missing work area stays empty",
      split_work_area({}),
      ("", "", ""))

# ── Both PMWeb endpoints use it ──────────────────────────────────────────────

from app.routers import export, reports  # noqa: E402

for name, fn in (("export.get_pmweb_full", export.get_pmweb_full),
                 ("reports.get_activities_consolidated", reports.get_activities_consolidated)):
    src = inspect.getsource(fn)
    results.append("split_work_area(act)" in src and 'split(" - ")' not in src)
    print(f"{'PASS' if results[-1] else 'FAIL'}  {name} reads the work area through split_work_area")

failed = results.count(False)
print(f"\n{len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)

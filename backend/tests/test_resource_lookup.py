"""Verify resource names already written in PMWeb's own form survive the export.

WHY THIS EXISTS: a report's resource tables were right on screen and right in
the saved JSON, but the Word export and the PMWeb extension showed different
equipment — which read as "my edits are not saving" and sent us looking at the
save path for hours. Nothing was wrong with saving. lookup_resource() rewrote
the names on the way out.

Step 3 of the lookup asked `if key in normalized` against every key in
RESOURCE_MAP, in dict order, and returned the first hit. The table contains the
keys "pe" and "truck", so for a resource NOT in the table:

    "LE-170- Airless Paint Striper"  ->  "pe" matches inside "striper"  ->  LL-09- PE
    "LE-169- DOT Truck"              ->  "truck" matches               ->  LE-01- Crew Truck
    "LE-161- Traffic Control Truck"  ->  "truck" matches               ->  LE-01- Crew Truck

Two traffic control trucks and a DOT truck consolidated into one
"LE-01- Crew Truck, qty 3", and a paint striper was exported as a person.

Fixtures are the real rows from the 2026-08-05 report this was found on.
"""
import sys

sys.path.insert(0, "backend")

from app.services.pmweb_mappings import lookup_resource, _builtin_catalog  # noqa: E402

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# --- A resource already in PMWeb's form is never rewritten ------------------
# These are the ones that broke. None of them is in RESOURCE_MAP.
for name in (
    "LE-170- Airless Paint Striper",
    "LE-169- DOT Truck",
    "LE-161- Traffic Control Truck",
):
    got = lookup_resource(name)
    check(f"untouched: {name}", got == name, f"got {got!r}")

# These are in the map, and must still come back as themselves.
for name in (
    "LE-51- Pickup Truck",
    "LE-01- Crew Truck",
    "LL-02- Foreman",
    "LL-03- Laborers",
    "LL-09- PE",
):
    got = lookup_resource(name)
    check(f"untouched: {name}", got == name, f"got {got!r}")

# Lower case still resolves to the catalog's own spelling.
check(
    "lowercase code is canonicalised",
    lookup_resource("le-01- crew truck") == "LE-01- Crew Truck",
    f"got {lookup_resource('le-01- crew truck')!r}",
)

# --- Loose human input still maps, which is what the table is FOR -----------
for typed, expected in (
    ("pe", "LL-09- PE"),
    ("truck", "LE-01- Crew Truck"),
    ("foreman", "LL-02- Foreman"),
    ("laborer", "LL-03- Laborers"),
    ("mini", "LE-04- Mini Excavator"),
    ("950", "LE-02- CAT 950 Wheel Loader"),
    ("cat 330", "LE-05- CAT 330 Excavator"),
):
    got = lookup_resource(typed)
    check(f"maps: {typed!r} -> {expected}", got == expected, f"got {got!r}")

# --- A short key must not match inside a longer word ------------------------
# The specific failure: "pe" inside "striper".
check(
    "'pe' does not match inside 'striper'",
    lookup_resource("airless paint striper") != "LL-09- PE",
    f"got {lookup_resource('airless paint striper')!r}",
)

# Empty input keeps its long-standing default.
check("empty input defaults to Laborers", lookup_resource("") == "LL-03- Laborers")

# --- against a real synced catalogue, it resolves what the matcher resolves --
# Same rules as frontend/src/lib/resourceMatcher.ts, so the two agree on both
# what they resolve AND what they refuse to.
CATALOG = _builtin_catalog() + [
    "LE-161- Traffic Control Truck", "LE-167- Thermoplastic Truck",
    "LE-168- Paint Stencil Truck", "LE-169- DOT Truck",
    "LE-170- Airless Paint Striper", "LE-172- Airless Paint Grinder",
    "LE-173- Thermo Stencil Truck", "LE-176- Hot Melt Loop Sealant Applicator",
    "LE-177- Self Contained Saw Cutting Truck", "LE-178- Traffic Loop Saw",
]

for spoken, expected in (
    ("self contained saw truck", "LE-177- Self Contained Saw Cutting Truck"),
    ("saw truck", "LE-177- Self Contained Saw Cutting Truck"),
    ("thermo stencil truck", "LE-173- Thermo Stencil Truck"),
    ("dot truck", "LE-169- DOT Truck"),
    ("traffic control truck", "LE-161- Traffic Control Truck"),
    ("paint striper", "LE-170- Airless Paint Striper"),
):
    got = lookup_resource(spoken, CATALOG)
    check(f"resolves: {spoken!r}", got == expected, f"got {got!r}")

# --- and refuses the rest rather than inventing one ------------------------
# These are different NAMES for a resource, not shortened forms of one. The
# matcher leaves them for the resolution dialog; guessing here would undo that.
for spoken in ("striping truck", "hot melt trailer", "air compressor"):
    got = lookup_resource(spoken, CATALOG)
    check(f"left alone: {spoken!r}", got == spoken, f"got {got!r}")

# Ambiguous on its own — a dozen entries are trucks.
check("bare 'dump truck' does not become a crew truck",
      lookup_resource("dump truck", CATALOG) != "LE-01- Crew Truck",
      f"got {lookup_resource('dump truck', CATALOG)!r}")


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)

"""Debug script: reproduce the activities-consolidated hours calculation."""
import json
import sys

# Load the report
with open("sunday_report_raw.json", "r", encoding="utf-8-sig") as f:
    report = json.load(f)

activities = report.get("activities", [])
print(f"Total activities: {len(activities)}")

for i, act in enumerate(activities):
    work_area = act.get("work_area", "")
    print(f"\n=== Activity {i+1}: {work_area[:80]} ===")
    
    LUNCH_DEDUCTION_HOURS = 0.5
    total_hours = 0.0
    
    table_names = ["manpower", "equipment", "extra_work_manpower", "extra_work_equipment", "consultant_manpower"]
    resource_tables = [act.get(name, []) for name in table_names]
    
    for tbl_name, table in zip(table_names, resource_tables):
        table_total = 0.0
        for item in table:
            try:
                qty = float(item.get("qty", 0) or 0)
                hrs = float(item.get("hours", 0) or 0)
                if hrs > 4:
                    row_total = (qty * hrs) - (qty * LUNCH_DEDUCTION_HOURS)
                else:
                    row_total = qty * hrs
                table_total += row_total
                name = item.get("name") or item.get("trade") or "?"
                print(f"  {tbl_name}: {name:30s} qty={qty:5.1f} hrs={hrs:6.1f} → row_total={row_total:8.2f}")
            except (ValueError, TypeError) as e:
                print(f"  ERROR: {e} in {item}")
        
        if table:
            print(f"  --- {tbl_name} subtotal: {table_total:.2f} ({len(table)} rows)")
        total_hours += table_total
    
    print(f"\n  GRAND TOTAL: {total_hours:.2f}")
    print(f"  Rounded: {round(total_hours, 2)}")

# Also calculate what aggregate_for_pmweb would give
print("\n\n=== aggregate_for_pmweb comparison ===")
pmweb_total = 0.0
STANDARD_HOURS = 8.0
for act in activities:
    tables_and_flags = [
        (act.get("manpower", []), False),
        (act.get("equipment", []), True),
        (act.get("extra_work_manpower", []), False),
        (act.get("extra_work_equipment", []), True),
        (act.get("consultant_manpower", []), False),
    ]
    for items, is_equip in tables_and_flags:
        for item in items:
            qty = float(item.get("qty", 0) or 0)
            hours = float(item.get("hours", 0) or 0)
            if qty <= 0 or hours <= 0:
                continue
            if not is_equip and hours > STANDARD_HOURS:
                pmweb_total += qty * STANDARD_HOURS
                pmweb_total += qty * (hours - STANDARD_HOURS)
            else:
                pmweb_total += qty * hours

print(f"PMWeb aggregate total_hours sum: {pmweb_total:.2f}")

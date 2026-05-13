"""
Daily Reporter V3 — PMWeb Resource & Company Mappings

Preserves all lookup tables from the legacy app exactly.
These map user-entered shorthand to official PMWeb dropdown values.
"""

COMPANY_MAP: dict[str, str] = {
    "ohl": "OHL NA",
    "ohl na": "OHL NA",
    "ohla": "OHL NA",
    "city": "City of San Diego",
    "city of san diego": "City of San Diego",
    "san diego": "City of San Diego",
    "hka": "HKA-Tech",
    "hka tech": "HKA-Tech",
    "aecom": "AECOM",
    "hdr": "HDR Engineering INC",
    "hdr engineering": "HDR Engineering INC",
    "stantec": "Stantec Consulting Services Inc",
    "kiewit": "Kiewit Infrastructure West Co.",
    "pcl": "PCL Construction, Inc.",
    "shimmick": "Shimmick Construction Company, Inc.",
    "flatiron": "Flatiron West Inc",
    "rasic": "W. A. Rasic Construction",
    "wa rasic": "W. A. Rasic Construction",
    "sukut": "Sukut Construction LLC",
    "filanc": "Filanc Construction",
    "jr filanc": "J. R. Filanc Construction Co.",
    "j.r. filanc": "J. R. Filanc Construction Co.",
    "twining": "Twining",
    "kleinfelder": "Kleinfelder Inc.",
    "nv5": "NV5 Inc",
    "badger": "Badger Daylighting Corp",
    "cascade": "Cascade Environmental",
    "paleo": "Paleo Solutions Inc.",
    "paleo solutions": "Paleo Solutions Inc.",
    "_default": "OHL NA",
}

RESOURCE_MAP: dict[str, str] = {
    # ── Labor ──────────────────────────────────────
    "super": "LL-01- Superintendent",
    "superintendent": "LL-01- Superintendent",
    "foreman": "LL-02- Foreman",
    "laborer": "LL-03- Laborers",
    "laborers": "LL-03- Laborers",
    "labor": "LL-03- Laborers",
    "operator": "LL-04- Operator",
    "operators": "LL-04- Operator",
    "journeyman": "LL-05- Journeyman",
    "apprentice": "LL-06- Apprentice",
    "engineer": "LL-07- Engineer",
    "pm": "LL-08- PM",
    "project manager": "LL-08- PM",
    "pe": "LL-09- PE",
    "project engineer": "LL-09- PE",
    "gf": "LL-10- GF",
    "general foreman": "LL-10- GF",
    "teamster": "LL-11- Teamster",
    "carpenter": "LL-12- Carpenter",
    "ironworker": "LL-13- Ironworker",
    "pump operator": "LL-14- Pump Operator",
    "cement mason": "LL-15- Cement Mason",
    "mason": "LL-15- Cement Mason",
    "vac truck operator": "LL-16- Vac Truck Operator",
    "electrician": "LL-17- Electrician",
    "visitor": "LL-18- Visitor",
    "welder": "LL-19- Welder",
    "cwi": "LL-20- Certified Welding Inspector (CWI)",
    "inspector": "LL-20- Certified Welding Inspector (CWI)",
    "ndt": "LL-21- NDT Technician",
    "safety manager": "LL-22- Safety Manager",
    "safety": "LL-22- Safety Manager",
    "paleo": "LL-23- Paleontologist",
    "archaeologist": "LL-24- Archaeologist",
    "enviro": "LL-25- Environmental Monitor",
    "environmental": "LL-25- Environmental Monitor",
    "monitor": "LL-25- Environmental Monitor",
    "biologist": "LL-26- Biologist",
    "native american": "LL-27- Native American Monitor",
    "nam": "LL-27- Native American Monitor",
    "pipe fitter": "LL-28- Pipe Fitter",
    "painter": "LL-29- Painters",
    "handler": "LL-30- Material Handler",
    "survey": "LL-31- Survey Crew",
    "surveyor": "LL-31- Survey Crew",
    "neta": "LL-32- AEC NETA Technician",
    "resa": "LL-33- RESA Power Technician",
    "plumber": "LL-34- Plumber",
    "abb": "LL-35- ABB - Field Engineer",
    "ace": "LL-36- ACE Crane Technician",
    "csi": "LL-37- CSI Technician",
    "select": "LL-38- Select Electric Technician",
    "big sky": "LL-39- Big Sky Electric Tech.",
    # ── Equipment (generics) ─────────────────────
    "excavator": "LE-109- Excavator",
    "backhoe": "LE-108- Backhoe",
    "skid steer": "LE-125- Skid Steer",
    "compressor": "LE-110- Compressor",
    "forklift": "LE-128- General – Fork Lift",
    "crane": "LE-114- Crane",
    "generator": "LE-70- Generator",
    "pickup": "LE-51- Pickup Truck",
    "truck": "LE-01- Crew Truck",
    "crew truck": "LE-01- Crew Truck",
    "wacker": "LE-81- Mechanical Wacker",
    "mechanical wacker": "LE-81- Mechanical Wacker",
    # ── Equipment (specific) ─────────────────────
    "loader": "LE-02- CAT 950 Wheel Loader",
    "wheel loader": "LE-02- CAT 950 Wheel Loader",
    "950": "LE-02- CAT 950 Wheel Loader",
    "bobcat": "LE-03- Bobcat",
    "mini": "LE-04- Mini Excavator",
    "mini ex": "LE-04- Mini Excavator",
    "mini-excavator": "LE-04- Mini Excavator",
    "330": "LE-05- CAT 330 Excavator",
    "skyjacker": "LE-07- Skyjacker (fork lift)",
    "skip loader": "LE-09- Skip Loader",
    "skip": "LE-09- Skip Loader",
    "336": "LE-10- CAT 336",
    "drill": "LE-100- Liebherr LB20 Drill Rig",
    "rig": "LE-100- Liebherr LB20 Drill Rig",
    "lily": "LE-101- Lily Corp CD15 Epoxy Injection Dispenser",
    "epoxy dispenser": "LE-101- Lily Corp CD15 Epoxy Injection Dispenser",
    "man lift": "LE-102- AHEARN Single Man Lift",
    "single man lift": "LE-102- AHEARN Single Man Lift",
    "magnum": "LE-103- Magnum X7 True Airless Epoxy Injection Sprayer",
    "sprayer": "LE-103- Magnum X7 True Airless Epoxy Injection Sprayer",
    "824": "LE-104- McElroy 824 Fusion Welding Machine",
    "fusion": "LE-104- McElroy 824 Fusion Welding Machine",
    "generac": "LE-105- Generac Generator - United Rentals",
    "link belt": "LE-106- Link Belt RTC 8075",
    "rtc": "LE-106- Link Belt RTC 8075",
    "hammer": "LE-107- APE Hammer VS200 w/power unit",
    "ape": "LE-107- APE Hammer VS200 w/power unit",
    "dozer": "LE-11- CAT D5 Dozer",
    "d5": "LE-11- CAT D5 Dozer",
    "blower": "LE-111- Trailer Mounted Blower",
    "gpr": "LE-112- Hilti PS 1000 Ground Penetrating Radar",
    "radar": "LE-112- Hilti PS 1000 Ground Penetrating Radar",
    "16": "LE-113- McElroy Tracstar 16-inch Fusion Machine",
    "mobilram": "LE-115- ABI Mobilram",
    "24": "LE-116- McElroy Tracstar 24-inch Fusion",
    "seal boss": "LE-117- Seal Boss PA 3000 Epoxy Injection Pump",
    "pump": "LE-117- Seal Boss PA 3000 Epoxy Injection Pump",
    "barge": "LE-118- Barge",
    "710": "LE-119- John Deere 710K Backhoe Loader",
    "scrapper": "LE-12- CAT 637D Scrapper",
    "637": "LE-12- CAT 637D Scrapper",
    "telehandler": "LE-120- CAT TL1055 Telehandler",
    "tl1055": "LE-120- CAT TL1055 Telehandler",
    "case": "LE-121- Case CX225SR Excavator",
    "cx225": "LE-121- Case CX225SR Excavator",
    "324": "LE-122- John Deere 324G Skid Steer",
    "410": "LE-123- John Deere 410L Backhoe",
    "d5g": "LE-124- CAT D5G LGP Dozer",
    "baker": "LE-126- Baker Tank",
    "tank": "LE-126- Baker Tank",
    "246": "LE-127- CAT 246D Skid Steer",
    "genie": "LE-129- Genie Z-30/20N RJ Boom Lift",
    "boom lift": "LE-129- Genie Z-30/20N RJ Boom Lift",
    "roller": "LE-13- Roller H222",
    "h222": "LE-13- Roller H222",
    "tbm": "LE-130- Tunnel Boring Machine",
    "boring": "LE-130- Tunnel Boring Machine",
    "trs": "LE-131- CAT TRS3312 fork lift",
    "yale": "LE-132- Yale 26637 fork lift",
    "snorkel": "LE-133- Snorkel MB26J Man Lift",
    "352": "LE-134- CAT 352 Excavator",
    "325": "LE-135- John Deere 325G Skid Steer",
    "35g": "LE-136- John Deere Mini Excavator 35G",
    "410j": "LE-139- CAT 410J Loader Backhoe",
    "water truck": "LE-14- Water Truck F750",
    "f750": "LE-14- Water Truck F750",
    "ditch witch": "LE-140- Ditch Witch HX30 Vacuum Excavator",
    "vacuum": "LE-140- Ditch Witch HX30 Vacuum Excavator",
    "534": "LE-141- JLG Telehandler 534D10-45",
    "hitachi": "LE-142- HITACHI ZAXIS 75US excavator",
    "zaxis": "LE-142- HITACHI ZAXIS 75US excavator",
    "259b": "LE-143- Cat® 259B Series 3 Compact Track Loader",
    "kobelco": "LE-144- KOBELCO SK210LC Excavator",
    "sk210": "LE-144- KOBELCO SK210LC Excavator",
    "512": "LE-146- JCB 512 Telehandler",
    "jcb": "LE-146- JCB 512 Telehandler",
    "249": "LE-147- Caterpillar 249D3 Compact Track Loader",
    "kubota": "LE-148- Model No. U55-4 Kubota Tight Tail Swing Compact Excavator",
    "u55": "LE-148- Model No. U55-4 Kubota Tight Tail Swing Compact Excavator",
    "bomag": "LE-149- BOMAG BW 124 PDH Single Drum Roller",
    "350": "LE-15- Deer 350G excavator",
    "slurry": "LE-150- Tunnel Slurry Separation Plant",
    "sk55": "LE-151- KOBELCO SK55SRX-7 Mini Excavator",
    "308": "LE-152- CAT 308E2 CR Mini Excavator",
    "hpu": "LE-153- Hydraulic Power Unit",
    "bentonite": "LE-154- Bentonite Mixing Tank",
    "wacker rt": "LE-155- Wacker Neuson RTLx-SC3 Trench Roller",
    "trench roller": "LE-155- Wacker Neuson RTLx-SC3 Trench Roller",
    "lorain": "LE-156- LORAIN LRT-275 Crane",
    "lrt": "LE-156- LORAIN LRT-275 Crane",
    "tack truck": "LE-157- Tack Truck",
    "tack": "LE-157- Tack Truck",
    "cctv": "LE-158- CCTV Truck",
    "cctv truck": "LE-158- CCTV Truck",
    "pup roller": "LE-160- Pup Roller",
    "pup": "LE-160- Pup Roller",
    "grader": "LE-16- CAT 14H Grader",
    "14h": "LE-16- CAT 14H Grader",
    "volvo": "LE-17- Volvo SD 115 B Compactor",
    "compactor": "LE-17- Volvo SD 115 B Compactor",
    "d6": "LE-18- CAT D6 Dozer",
    "sweeper": "LE-19- Street sweeper",
    "485": "LE-21- Kobelco SK 485 Excavator",
    "yanmar": "LE-22- Yanmar ViO 25 Mini Excavator",
    "vio": "LE-22- Yanmar ViO 25 Mini Excavator",
    "dump truck": "LE-23- Super 10 End Dump Truck",
    "super 10": "LE-23- Super 10 End Dump Truck",
    "374": "LE-24- Cat 374 FL Excavator",
    "d5k": "LE-25- Cat D5K2 XL Dozer",
    "966": "LE-26- Cat 966H Loader",
    "jlg": "LE-27- JLG Lift",
    "lift": "LE-27- JLG Lift",
    "water": "LE-28- Water Truck",
    "hamm": "LE-29- Hamm Single Drum Sheeps Foot Roller",
    "sheepsfoot": "LE-29- Hamm Single Drum Sheeps Foot Roller",
    "210": "LE-30- Deere 210L Skip Loader",
    "335": "LE-31- Cat 335F Excavator",
    "skytrak": "LE-32- Skytrak Forklift",
    "730": "LE-33- Cat 730C Articulated Haul Truck",
    "haul truck": "LE-33- Cat 730C Articulated Haul Truck",
    "concrete pump": "LE-34- Concrete Boom Pump",
    "boom pump": "LE-34- Concrete Boom Pump",
    "light tower": "LE-35- Light Tower",
    "sunstate": "LE-36- Sunstate Rental Dump Truck",
    "420": "LE-37- Cat 420F Backhoe",
    "430": "LE-38- Cat 430 Backhoe",
    "304": "LE-39- Cat 304E Mini Ex",
    "saw": "LE-41- Saw Cutter",
    "saw cutter": "LE-41- Saw Cutter",
    "utility": "LE-42- Utility Truck",
    "utility truck": "LE-42- Utility Truck",
    "325f": "LE-43- Cat 325F Excavator",
    "crawler": "LE-44- Kobelco CK 1100 Crawler Crane",
    "ck1100": "LE-44- Kobelco CK 1100 Crawler Crane",
    "259": "LE-45- Cat 259D Skid Steer",
    "bender": "LE-46- Greenle 555 Pipe Bender",
    "threader": "LE-47- Pipe Threader Ridgid 1224",
    "ridgid": "LE-47- Pipe Threader Ridgid 1224",
    "heater": "LE-49- PVC Pipe Heater",
    "roto": "LE-50- Roto Hammer",
    "140": "LE-52- CAT 140M2 Grader",
    "315": "LE-53- Cat 315F Excavator",
    "cs44": "LE-54- Vibratory Soil Compactor CS44B",
    "xtreme": "LE-56- Xtreme Telehandler XR4030",
    "miller": "LE-57- Miller Trailblazer Welding Generator",
    "welding": "LE-57- Miller Trailblazer Welding Generator",
    "welding truck": "LE-58- Welding Truck",
    "s65": "LE-59- Genie S-65 Boom Lift",
    "sakai": "LE-60- Sakai SV410 Sheepsfoot Roller",
    "rd12": "LE-61- Wacker RD12 Roller",
    "5519": "LE-62- Genie GTH 5519 Forklift",
    "paver": "LE-63- Asphalt Paver",
    "auger": "LE-64- Truck-Mounted Auger Drill",
    "crane auger": "LE-65- Crane-Mounted Auger Drill",
    "mixer": "LE-66- Concrete Mixer",
    "pump truck": "LE-67- Concrete Pump Truck",
    "jackhammer": "LE-69- Jackhammer",
    "grinder": "LE-71- Pavement Grinder",
    "arrow": "LE-72- Arrow Board",
    "polaris": "LE-75- Polaris Ranger",
    "ranger": "LE-75- Polaris Ranger",
    "multiquip": "LE-76- Generator Multiquip",
    "321": "LE-77- Cat 321D LCR Hydraulic Excavator",
    "freightliner": "LE-78- Freightliner M2-106 LW2000",
    "bmp": "LE-79- Bomag BMP 8500",
    "hd12": "LE-80- Hamm HD12 Vibratory Roller Compactor",
    "mechanical": "LE-81- Mechanical Wacker",
    "vactor": "LE-82- Vactor Truck",
    "trailer": "LE-83- Equipment-Hauling Trailer",
    "tracstar": "LE-84- TracStar 900 HDPE Fusion Machine",
    "maxim": "LE-85- Maxim 250 Crawler Crane",
    "tl1255": "LE-86- CAT TL1255D",
    "kenworth": "LE-87- Kenworth - T370",
    "t370": "LE-87- Kenworth - T370",
    "2401": "LE-89- McElroy 2401 Fusion Welding Machine",
    "whisperwatt": "LE-90- MQ Power 70 Whisperwatt Generator",
    "211": "LE-91- Model – BOMAG 211D Roller",
    "711": "LE-92- McElroy 711301",
    "lr1100": "LE-93- Maxim LR 1100 Crane",
    "wire feeder": "LE-94- Lincoln LN-25 Wire Feeder",
    "lincoln": "LE-94- Lincoln LN-25 Wire Feeder",
    "vantage": "LE-95- Lincoln Vantage Welding Generator",
    "toyota": "LE-96- Toyota Forklift (Mid Capacity 8FGU30)",
    "hoist": "LE-97- Hoist P550 Forklift",
    "scissor": "LE-98- Scissor Lift",
    "e300": "LE-99- JLG E300AJP Electric Boom Lift",
    "_default": "LL-03- Laborers",
}


def lookup_resource(user_input: str) -> str:
    """Map user input to PMWeb resource dropdown value."""
    if not user_input:
        return "LL-03- Laborers"

    normalized = user_input.lower().strip()

    # 1. Exact key match
    if normalized in RESOURCE_MAP:
        return RESOURCE_MAP[normalized]

    # 2. Exact value match (already a PMWeb code)
    for value in RESOURCE_MAP.values():
        if normalized == value.lower():
            return value

    # 3. Key is substring of input ("cat 330" contains "330")
    for key, value in RESOURCE_MAP.items():
        if key != "_default" and key in normalized:
            return value

    # 4. Input is substring of key
    for key, value in RESOURCE_MAP.items():
        if key != "_default" and normalized in key:
            return value

    # 5. Fuzzy: input appears in PMWeb value string
    for value in RESOURCE_MAP.values():
        if normalized in value.lower():
            return value

    return user_input  # Return as-is if no match


def lookup_company(user_input: str) -> str:
    """Map user input to PMWeb company dropdown value."""
    if not user_input:
        return COMPANY_MAP["_default"]

    normalized = user_input.lower().strip()

    if normalized in COMPANY_MAP:
        return COMPANY_MAP[normalized]

    for key, value in COMPANY_MAP.items():
        if key != "_default" and key in normalized:
            return value

    for key, value in COMPANY_MAP.items():
        if key != "_default" and normalized in key:
            return value

    for key, value in COMPANY_MAP.items():
        if key != "_default" and normalized in value.lower():
            return value

    return user_input

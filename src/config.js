'use strict';

const DB_START = 5;

const SH = {
  LIMITS:    'LIMITS',
  TARGETS:   'TARGETS',
  USERS:     'USERS',
  ALERTS:    'ALERTS',
  AUDIT:     'AUDIT_LOG',
  CHEM_INV:  'Chemical Inventory',
  STOCK_IN:  'Stock Inward Log',
  CRUSHING:  'Crushing',
  MILLING:   'Milling',
  CHEMICAL:  'Chemical Consumption',
  LEACHING:  'Leaching Tanks',
  SLURRY:    'Slurry Samples',
  CARBON:    'Carbon in Leaching Tank',
  FILTER:    'Filter Press',
  CYCLONE:   'Cyclone',
  SCREEN:    'Screen',
  THICKENER: 'Thickener',
  GC:        'GC',
  ELUTION:   'Elution',
  ILS:       'ILS',
  GOLD:      'Gold',
  STOPPAGE:  'Stoppage Reason',
};

const LT_TANKS       = ['LT4','LT5','LT6','LT7','LT8','LT9','LT10'];
const DT_TANKS       = ['DT1','DT2','DT3','DT4'];
const AU_LIMIT_TANKS = ['LT9','LT10','DT1','DT2','DT3','DT4'];
const CARBON_TANKS   = ['LT4','LT5','LT6','LT7','LT8','LT9','LT10'];

const SECTIONS = {
  crushing:    { label:'Crushing',                color:'#C0392B', sheet: SH.CRUSHING   },
  milling:     { label:'Milling',                 color:'#2471A3', sheet: SH.MILLING    },
  leaching:    { label:'Leaching',                color:'#1A7A4A', sheet: SH.LEACHING   },
  slurry:      { label:'Slurry Samples',          color:'#1A7A4A', sheet: SH.SLURRY     },
  carbon:      { label:'Carbon in Leaching Tank', color:'#1A7A4A', sheet: SH.CARBON     },
  cyclone:     { label:'Cyclone',                 color:'#2471A3', sheet: SH.CYCLONE    },
  thickener:   { label:'Thickener',               color:'#7D3C98', sheet: SH.THICKENER  },
  screen:      { label:'Screen',                  color:'#D35400', sheet: SH.SCREEN     },
  filterpress: { label:'Filter Press',            color:'#1D6A96', sheet: SH.FILTER     },
  gc:          { label:'Gravity Concentrate',     color:'#B7950B', sheet: SH.GC         },
  elution:     { label:'Elution',                 color:'#7D3C98', sheet: SH.ELUTION    },
  ils:         { label:'ILS',                     color:'#D35400', sheet: SH.ILS        },
  gold:        { label:'Gold Production',         color:'#B8860B', sheet: SH.GOLD       },
};

// ─── DASHBOARD GROUPING ───────────────────────────────────────────────────────
// Some sections are shown as a single dashboard card whose detail page has
// sub-tabs for related sheets, instead of each sheet getting its own card.
// The group key's own sheet is always the first (default) tab.
const SECTION_GROUPS = {
  milling:  ['milling', 'cyclone', 'thickener'],
  leaching: ['leaching', 'slurry', 'carbon', 'screen'],
};

// Section keys that are folded into a group and should not get their own
// dashboard card (every member of a group except the group's own key).
const HIDDEN_FROM_DASHBOARD = new Set(
  Object.entries(SECTION_GROUPS).flatMap(([parent, members]) => members.filter(m => m !== parent))
);

// Friendlier tab labels for grouped sub-sections (dashboard card titles are
// unaffected — this only controls the sub-tab text on the detail page).
const GROUP_TAB_LABELS = {
  leaching: 'Leaching Tanks',
  carbon:   'Carbon in Tank',
};

const ROLE_CONFIG = {
  supervisor: {
    canSeeAll: true, canWrite: 'all', canAdmin: true, canTargets: true, canChemAdmin: true
  },
  management: {
    sections: Object.keys(SECTIONS), canWrite: [], canAdmin: false, canTargets: true, canChemAdmin: true
  },
  process1: {
    sections: ['crushing','chemical'],
    canWrite: [SH.CRUSHING, SH.CHEMICAL, SH.STOPPAGE, SH.STOCK_IN],
    canAdmin: false, canTargets: false, canChemAdmin: false
  },
  process2: {
    sections: ['milling','leaching','filterpress','cyclone','screen','thickener','chemical'],
    canWrite: [SH.MILLING, SH.LEACHING, SH.SLURRY, SH.CARBON, SH.FILTER, SH.CYCLONE, SH.SCREEN, SH.THICKENER, SH.CHEMICAL, SH.STOPPAGE, SH.STOCK_IN],
    canAdmin: false, canTargets: false, canChemAdmin: false
  },
  process3: {
    sections: ['gc','elution','ils','gold','chemical'],
    canWrite: [SH.GC, SH.ELUTION, SH.ILS, SH.GOLD, SH.CHEMICAL, SH.STOPPAGE, SH.STOCK_IN],
    canAdmin: false, canTargets: false, canChemAdmin: false
  },
  meeting: {
    sections: ['crushing','milling','leaching','filterpress','cyclone','screen','thickener','chemical','gc','elution','ils'],
    canWrite: [], canAdmin: false, canTargets: false, canChemAdmin: false
  },
};

// ─── SHIFT OPTIONS ────────────────────────────────────────────────────────────
const SHIFT_OPTS = ['AM (00:00-12:00)', 'PM (12:00-00:00)'];

// Reading times for leaching tanks
const LEACH_TIMES = ['03:00','07:00','11:00','15:00','19:00','23:00'];

// TIME_SHEETS – sheets that include a time or shift column
const TIME_SHEETS = [SH.LEACHING, SH.CYCLONE];

// ─── SECTION CHEMICALS ───────────────────────────────────────────────────────
const SECTION_CHEMICALS = {
  crushing:    [],
  milling:     ['Flocculant','Coagulant'],
  leaching:    ['Cyanide Leaching','Hydrated Lime','Sodium Hypochlorite','Calcium Hypochlorite','H2O2'],
  slurry:      [],
  carbon:      ['Fresh Carbon'],
  filterpress: [],
  cyclone:     [],
  screen:      [],
  thickener:   ['Flocculant','Coagulant'],
  gc:          [],
  elution:     ['Cyanide Elution','Caustic Soda','HCl'],
  ils:         ['Cyanide ILS','Zinc','Lead Acetate'],
  gold:        [],
};

// ─── ENTRY SHEETS BY ROLE ────────────────────────────────────────────────────
const ENTRY_SHEETS_BY_ROLE = {
  supervisor: [
    SH.CRUSHING, SH.MILLING, SH.CHEMICAL, SH.LEACHING, SH.SLURRY,
    SH.CARBON, SH.FILTER, SH.CYCLONE, SH.SCREEN, SH.THICKENER,
    SH.GC, SH.ELUTION, SH.ILS, SH.GOLD, SH.STOPPAGE, SH.STOCK_IN,
  ],
  process1:   [SH.CRUSHING, SH.CHEMICAL, SH.STOPPAGE, SH.STOCK_IN],
  process2:   [SH.MILLING, SH.LEACHING, SH.SLURRY, SH.CARBON, SH.FILTER, SH.CYCLONE, SH.SCREEN, SH.THICKENER, SH.CHEMICAL, SH.STOPPAGE, SH.STOCK_IN],
  process3:   [SH.GC, SH.ELUTION, SH.ILS, SH.GOLD, SH.CHEMICAL, SH.STOPPAGE, SH.STOCK_IN],
  management: [],
  meeting:    [],
};

// ─── SHEET_PARAMS ─────────────────────────────────────────────────────────────
// Each entry: { key, label, unit, limitId?, autoCalc?, isOverflow?, isTime?, isText?, isSelect?, options?, tank?, tankGroup? }

// Leaching – build dynamically
function _buildLeachingParams() {
  const params = [
    { key: 'Date', label: 'Date', unit: '', isText: true },
    { key: 'Time', label: 'Time', unit: '', isTime: true },
  ];
  // NaCN and Au limits are per-tank (each tank has its own min/max in the
  // Limits editor); pH and DO limits are shared across all tanks of a group.
  LT_TANKS.forEach(t => {
    params.push({ key: `${t} NaCN (ppm)`,       label: 'NaCN',          unit: 'ppm', tank: t, tankGroup: 'Leach', limitId: `LT_NACN_${t}`, limitLabel: `${t} — NaCN (ppm)` });
    params.push({ key: `${t} pH`,               label: 'pH',            unit: '',    tank: t, tankGroup: 'Leach', limitId: 'LEACH_PH', limitLabel: 'All Leach Tanks — pH' });
    params.push({ key: `${t} DO (ppm)`,         label: 'DO',            unit: 'ppm', tank: t, tankGroup: 'Leach', limitId: 'LEACH_DO', limitLabel: 'All Leach Tanks — DO (ppm)' });
    params.push({ key: `${t} Au in Liquor (ppm)`, label: 'Au in Liquor', unit: 'ppm', tank: t, tankGroup: 'Leach', limitId: `LT_AU_${t}` });
    params.push({ key: `${t} Overflow`,         label: 'Overflow',      unit: '',    tank: t, tankGroup: 'Leach', isOverflow: true });
  });
  DT_TANKS.forEach(t => {
    params.push({ key: `${t} NaCN (ppm)`,       label: 'NaCN',          unit: 'ppm', tank: t, tankGroup: 'Detox', limitId: `DT_NACN_${t}`, limitLabel: `${t} — NaCN (ppm)` });
    params.push({ key: `${t} pH`,               label: 'pH',            unit: '',    tank: t, tankGroup: 'Detox', limitId: 'DETOX_PH', limitLabel: 'All Detox Tanks — pH' });
    params.push({ key: `${t} Au in Liquor (ppm)`, label: 'Au in Liquor', unit: 'ppm', tank: t, tankGroup: 'Detox', limitId: `DT_AU_${t}` });
  });
  params.push({ key: 'Notes', label: 'Notes', unit: '', isText: true });
  return params;
}

// "Slurry Samples for Au in Solids" — one Au (ppm) reading per tank per day.
// LT3 is real for slurry sampling even though it isn't a Leaching tank
// (Leaching only runs LT4-LT10).
const SLURRY_AU_TANKS = ['LT3', ...LT_TANKS, ...DT_TANKS];

function _buildSlurryParams() {
  const params = [
    { key: 'Date', label: 'Date', unit: '', isText: true },
  ];
  SLURRY_AU_TANKS.forEach(t => {
    params.push({ key: `${t} Au (ppm)`, label: 'Au in Solids', unit: 'ppm', tank: t, tankGroup: 'Slurry', limitId: `SLURRY_AU_${t}`, limitLabel: `${t} — Au in Solids (ppm)` });
  });
  params.push({ key: 'Notes', label: 'Notes', unit: '', isText: true });
  return params;
}

function _buildCarbonParams() {
  const params = [
    { key: 'Date', label: 'Date', unit: '', isText: true },
  ];
  CARBON_TANKS.forEach(t => {
    params.push({ key: `${t} Carbon (g/L)`,     label: 'Carbon g/L',   unit: 'g/L',  tank: t, tankGroup: 'Carbon' });
    params.push({ key: `${t} Carbon Load (g/t)`, label: 'Carbon Load',  unit: 'g/t',  tank: t, tankGroup: 'Carbon' });
    params.push({ key: `${t} Au on Carbon (g/t)`,label: 'Au on Carbon', unit: 'g/t',  tank: t, tankGroup: 'Carbon' });
  });
  params.push({ key: 'Notes', label: 'Notes', unit: '', isText: true });
  return params;
}

const SHEET_PARAMS = {
  [SH.CRUSHING]: [
    { key: 'Date',          label: 'Date',          unit: '',     isText: true },
    { key: 'Running Hours', label: 'Running Hours',  unit: 'hrs'  },
    { key: 'Production',    label: 'Production',     unit: 't'    },
    { key: 'Feed Size',     label: 'Feed Size',      unit: 'mm'   },
    { key: 'Product Size',  label: 'Product Size',   unit: 'mm'   },
    { key: 'TPH',           label: 'TPH',            unit: 't/hr', autoCalc: true },
    { key: 'Notes',         label: 'Notes',          unit: '',     isText: true },
  ],
  [SH.MILLING]: [
    { key: 'Date',         label: 'Date',          unit: '',     isText: true },
    { key: 'Running Hrs',  label: 'Running Hours', unit: 'hrs'  },
    { key: 'Production',   label: 'Production',    unit: 't'    },
    { key: 'Feed Grade',   label: 'Feed Grade',    unit: 'g/t'  },
    { key: 'Product Size', label: 'Product Size',  unit: 'µm'   },
    { key: 'Ball Load',    label: 'Ball Load',     unit: 't'    },
    { key: 'Water Flow',   label: 'Water Flow',    unit: 'm³/hr' },
    { key: 'TPH',          label: 'TPH',           unit: 't/hr', autoCalc: true },
    { key: 'Notes',        label: 'Notes',         unit: '',     isText: true },
  ],
  [SH.CHEMICAL]: [
    { key: 'Date',                    label: 'Date',                    unit: '',   isText: true },
    { key: 'Section',                 label: 'Section',                 unit: '',   isText: true },
    { key: 'Fresh Carbon',            label: 'Fresh Carbon',            unit: 'kg' },
    { key: 'Hydrated Lime',           label: 'Hydrated Lime',           unit: 'kg' },
    { key: 'Sodium Hypochlorite',     label: 'Sodium Hypochlorite',     unit: 'L'  },
    { key: 'Calcium Hypochlorite',    label: 'Calcium Hypochlorite',    unit: 'kg' },
    { key: 'Flocculant',              label: 'Flocculant',              unit: 'kg' },
    { key: 'Coagulant',               label: 'Coagulant',               unit: 'kg' },
    { key: 'Cyanide Leaching',        label: 'Cyanide Leaching',        unit: 'kg' },
    { key: 'Cyanide ILS',             label: 'Cyanide ILS',             unit: 'kg' },
    { key: 'Cyanide Elution',         label: 'Cyanide Elution',         unit: 'kg' },
    { key: 'Caustic Soda',            label: 'Caustic Soda',            unit: 'kg' },
    { key: 'Zinc',                    label: 'Zinc',                    unit: 'kg' },
    { key: 'Lead Acetate',            label: 'Lead Acetate',            unit: 'kg' },
    { key: 'HCl',                     label: 'HCl',                     unit: 'L'  },
    { key: 'H2O2',                    label: 'H2O2',                    unit: 'L'  },
    { key: 'Notes',                   label: 'Notes',                   unit: '',   isText: true },
  ],
  [SH.LEACHING]: _buildLeachingParams(),
  [SH.SLURRY]:   _buildSlurryParams(),
  [SH.CARBON]:   _buildCarbonParams(),
  [SH.FILTER]: [
    { key: 'Date',     label: 'Date',       unit: '',    isText: true },
    { key: 'Cycles',   label: 'Cycles',     unit: ''     },
    { key: 'Cake Wt',  label: 'Cake Wt',    unit: 't'    },
    { key: 'Moisture', label: 'Moisture',   unit: '%'    },
    { key: 'Dry Wt',   label: 'Dry Wt',     unit: 't',   autoCalc: true },
    { key: 'Au',       label: 'Au',         unit: 'ppm', limitId: 'FILTER_AU' },
    { key: 'Au (g)',   label: 'Au Content', unit: 'g',   autoCalc: true },
    { key: 'Notes',    label: 'Notes',      unit: '',    isText: true },
  ],
  [SH.CYCLONE]: [
    { key: 'Date',          label: 'Date',          unit: '',     isText: true },
    { key: 'Shift',         label: 'Shift',         unit: '',     isSelect: true, options: SHIFT_OPTS },
    { key: 'Feed Pressure', label: 'Feed Pressure', unit: 'kPa'  },
    { key: 'O/F Density',   label: 'O/F Density',   unit: 'g/cm³' },
    { key: 'U/F Density',   label: 'U/F Density',   unit: 'g/cm³' },
    { key: 'O/F Size',      label: 'O/F Size',      unit: 'µm'   },
    { key: 'Notes',         label: 'Notes',         unit: '',     isText: true },
  ],
  [SH.SCREEN]: [
    { key: 'Date',         label: 'Date',          unit: '',     isText: true },
    { key: 'Feed',         label: 'Feed',          unit: 't/hr' },
    { key: 'Oversize',     label: 'Oversize',      unit: '%'    },
    { key: 'Efficiency',   label: 'Efficiency',    unit: '%'    },
    { key: 'Notes',        label: 'Notes',         unit: '',     isText: true },
  ],
  [SH.THICKENER]: [
    { key: 'Date',             label: 'Date',             unit: '',     isText: true },
    { key: 'Underflow Density',label: 'Underflow Density', unit: 'g/cm³' },
    { key: 'Overflow Clarity', label: 'Overflow Clarity', unit: 'NTU'  },
    { key: 'Bed Level',        label: 'Bed Level',        unit: '%'    },
    { key: 'Flocculant Dose',  label: 'Flocculant Dose',  unit: 'g/t'  },
    { key: 'Notes',            label: 'Notes',            unit: '',     isText: true },
  ],
  [SH.GC]: [
    { key: 'Date',         label: 'Date',          unit: '',     isText: true },
    { key: 'Mass (kg)',    label: 'Mass',           unit: 'kg'   },
    { key: 'Au Grade (g/t)', label: 'Au Grade',    unit: 'g/t'  },
    { key: 'Au Content (g)', label: 'Au Content',  unit: 'g',    autoCalc: true },
    { key: 'Recovery (%)',  label: 'Recovery',      unit: '%'    },
    { key: 'Notes',        label: 'Notes',          unit: '',     isText: true },
  ],
  [SH.ELUTION]: [
    { key: 'Date',            label: 'Date',            unit: '',    isText: true },
    { key: 'Carbon In (g/t)', label: 'Carbon In',        unit: 'g/t' },
    { key: 'Carbon Out (g/t)',label: 'Carbon Out',       unit: 'g/t' },
    { key: 'Eluate Au (ppm)', label: 'Eluate Au',        unit: 'ppm' },
    { key: 'Temp (°C)',       label: 'Temperature',      unit: '°C'  },
    { key: 'NaOH (g/L)',      label: 'NaOH',             unit: 'g/L' },
    { key: 'NaCN (g/L)',      label: 'NaCN',             unit: 'g/L' },
    { key: 'Volume (L)',      label: 'Volume',            unit: 'L'   },
    { key: 'Notes',           label: 'Notes',            unit: '',    isText: true },
  ],
  [SH.ILS]: [
    { key: 'Date',            label: 'Date',             unit: '',    isText: true },
    { key: 'Feed Au (ppm)',   label: 'Feed Au',           unit: 'ppm' },
    { key: 'Raffinate Au (ppm)', label: 'Raffinate Au',  unit: 'ppm' },
    { key: 'Strip Au (ppm)',  label: 'Strip Au',          unit: 'ppm' },
    { key: 'Zn Precipitate (g/L)', label: 'Zn Precipitate', unit: 'g/L' },
    { key: 'pH',              label: 'pH',               unit: ''    },
    { key: 'Recovery (%)',    label: 'Recovery',          unit: '%',   autoCalc: true },
    { key: 'Notes',           label: 'Notes',            unit: '',    isText: true },
  ],
  [SH.GOLD]: [
    { key: 'Date',              label: 'Date',              unit: '',   isText: true },
    { key: 'Dore Mass (g)',     label: 'Dore Mass',         unit: 'g'  },
    { key: 'Purity (%)',        label: 'Purity',            unit: '%'  },
    { key: 'Au Content (g)',    label: 'Au Content',        unit: 'g',  autoCalc: true },
    { key: 'Cumulative (g)',    label: 'Cumulative',        unit: 'g',  autoCalc: true },
    { key: 'Notes',             label: 'Notes',             unit: '',   isText: true },
  ],
  [SH.STOPPAGE]: [
    { key: 'Date',              label: 'Date',              unit: '',   isText: true },
    { key: 'Section',           label: 'Section',           unit: '',   isText: true },
    { key: 'Stop Time',         label: 'Stop Time',         unit: '',   isTime: true },
    { key: 'Start Time',        label: 'Start Time',        unit: '',   isTime: true },
    { key: 'Total Stoppage Hrs',label: 'Total Hrs',         unit: 'hrs', autoCalc: true },
    { key: 'Department',        label: 'Department',        unit: '',   isSelect: true, options: ['Mechanical','Electrical','O&M','Operation','Others'] },
    { key: 'Reason',            label: 'Reason',            unit: '',   isText: true },
    { key: 'Action Taken',      label: 'Action Taken',      unit: '',   isText: true },
  ],
  [SH.STOCK_IN]: [
    { key: 'Date',          label: 'Date',          unit: '',   isText: true },
    { key: 'Chemical',      label: 'Chemical',      unit: '',   isText: true },
    { key: 'Quantity',      label: 'Quantity',      unit: ''   },
    { key: 'Unit',          label: 'Unit',          unit: '',   isSelect: true, options: ['kg','L','bag','drum','ton'] },
    { key: 'Supplier',      label: 'Supplier',      unit: '',   isText: true },
    { key: 'Invoice No',    label: 'Invoice No',    unit: '',   isText: true },
    { key: 'Notes',         label: 'Notes',         unit: '',   isText: true },
  ],
  [SH.LIMITS]: [],
  [SH.TARGETS]: [],
  [SH.USERS]: [],
  [SH.CHEM_INV]: [],
  [SH.AUDIT]: [],
};

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function canWrite(role, sheetName) {
  const rc = ROLE_CONFIG[role];
  if (!rc) return false;
  if (rc.canWrite === 'all') return true;
  return Array.isArray(rc.canWrite) && rc.canWrite.includes(sheetName);
}

function canSeeSection(role, sectionKey) {
  const rc = ROLE_CONFIG[role];
  if (!rc) return false;
  if (rc.canSeeAll) return true;
  return Array.isArray(rc.sections) && rc.sections.includes(sectionKey);
}

function canManageTargets(role) {
  const rc = ROLE_CONFIG[role];
  return !!(rc && rc.canTargets);
}

module.exports = {
  DB_START, SH, LT_TANKS, DT_TANKS, AU_LIMIT_TANKS, CARBON_TANKS, SLURRY_AU_TANKS,
  SECTIONS, ROLE_CONFIG, SHIFT_OPTS, LEACH_TIMES, TIME_SHEETS,
  SECTION_CHEMICALS, ENTRY_SHEETS_BY_ROLE, SHEET_PARAMS,
  SECTION_GROUPS, HIDDEN_FROM_DASHBOARD, GROUP_TAB_LABELS,
  canWrite, canSeeSection, canManageTargets,
};

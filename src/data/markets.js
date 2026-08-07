// Indirect-tax regime by market — the layer that turns "£X went here" into "here is what
// selling here would actually involve".
//
// `regime` is the load-bearing field and it is structural: EU membership determines OSS
// eligibility, and that is a fact rather than a rate. `vat` is the headline standard rate
// and is INDICATIVE ONLY — rates move, several moved during 2025, and reduced rates,
// registration thresholds and marketplace-deemed-supplier rules all sit underneath it.
// Nothing here is tax advice; the UI says so, and it should stay saying so.
//
// As at: February 2026.
export const TAX_AS_AT = 'February 2026';

export const REGIMES = {
  'eu-oss': {
    label: 'EU — OSS eligible',
    blurb: 'One OSS registration covers B2C distance sales to all 27 member states; charge the customer’s local rate.',
  },
  vat: {
    label: 'National VAT',
    blurb: 'Standalone VAT registration, local filing and a local rate. No single-registration shortcut.',
  },
  gst: {
    label: 'GST',
    blurb: 'Goods and services tax with its own registration threshold and return cycle.',
  },
  'us-sales-tax': {
    label: 'US sales tax',
    blurb: 'No federal VAT. Obligations arise state by state on economic nexus — typically a $100k or 200-transaction threshold, then state plus local rates.',
  },
  'no-vat': {
    label: 'No general consumption tax',
    blurb: 'No broad VAT or GST. Customs duty and excise can still apply.',
  },
};

// iso2 -> { regime, vat (%, null if none/not a single rate), note }
export const MARKETS = {
  // — EU 27 —
  AT: { regime: 'eu-oss', vat: 20 },
  BE: { regime: 'eu-oss', vat: 21 },
  BG: { regime: 'eu-oss', vat: 20 },
  HR: { regime: 'eu-oss', vat: 25 },
  CY: { regime: 'eu-oss', vat: 19 },
  CZ: { regime: 'eu-oss', vat: 21 },
  DK: { regime: 'eu-oss', vat: 25 },
  EE: { regime: 'eu-oss', vat: 24, note: 'Raised from 22% in July 2025.' },
  FI: { regime: 'eu-oss', vat: 25.5, note: 'Raised from 24% in September 2024.' },
  FR: { regime: 'eu-oss', vat: 20 },
  DE: { regime: 'eu-oss', vat: 19 },
  GR: { regime: 'eu-oss', vat: 24 },
  HU: { regime: 'eu-oss', vat: 27, note: 'Highest standard rate in the EU.' },
  IE: { regime: 'eu-oss', vat: 23 },
  IT: { regime: 'eu-oss', vat: 22 },
  LV: { regime: 'eu-oss', vat: 21 },
  LT: { regime: 'eu-oss', vat: 21 },
  LU: { regime: 'eu-oss', vat: 17, note: 'Lowest standard rate in the EU.' },
  MT: { regime: 'eu-oss', vat: 18 },
  NL: { regime: 'eu-oss', vat: 21 },
  PL: { regime: 'eu-oss', vat: 23 },
  PT: { regime: 'eu-oss', vat: 23 },
  RO: { regime: 'eu-oss', vat: 21, note: 'Raised from 19% in August 2025.' },
  SK: { regime: 'eu-oss', vat: 23, note: 'Raised from 20% in January 2025.' },
  SI: { regime: 'eu-oss', vat: 22 },
  ES: { regime: 'eu-oss', vat: 21 },
  SE: { regime: 'eu-oss', vat: 25 },

  // — rest of Europe —
  GB: { regime: 'vat', vat: 20, note: 'Home market.' },
  CH: { regime: 'vat', vat: 8.1 },
  NO: { regime: 'vat', vat: 25, note: 'VOEC registration for low-value B2C goods.' },
  IS: { regime: 'vat', vat: 24 },
  TR: { regime: 'vat', vat: 20 },
  UA: { regime: 'vat', vat: 20 },
  RS: { regime: 'vat', vat: 20 },

  // — Americas —
  US: { regime: 'us-sales-tax', vat: null, note: 'Rates and nexus rules differ in every state; roughly 11,000 taxing jurisdictions.' },
  CA: { regime: 'gst', vat: 5, note: '5% federal GST; provincial PST/HST takes the combined rate to 5–15%.' },
  MX: { regime: 'vat', vat: 16 },
  BR: { regime: 'vat', vat: null, note: 'Indirect tax reform is mid-transition to CBS/IBS; no single headline rate.' },
  CL: { regime: 'vat', vat: 19 },
  AR: { regime: 'vat', vat: 21 },
  CO: { regime: 'vat', vat: 19 },
  PE: { regime: 'vat', vat: 18 },

  // — Asia-Pacific —
  CN: { regime: 'vat', vat: 13 },
  JP: { regime: 'vat', vat: 10, note: 'Qualified Invoice System applies to input-tax recovery.' },
  KR: { regime: 'vat', vat: 10 },
  IN: { regime: 'gst', vat: 18, note: 'Multi-slab GST (5/12/18/28); 18% is the common slab, not a universal rate.' },
  SG: { regime: 'gst', vat: 9 },
  HK: { regime: 'no-vat', vat: null },
  TW: { regime: 'vat', vat: 5 },
  MY: { regime: 'vat', vat: 8, note: 'Sales & Service Tax rather than a full VAT.' },
  TH: { regime: 'vat', vat: 7 },
  VN: { regime: 'vat', vat: 10 },
  ID: { regime: 'vat', vat: 12 },
  PH: { regime: 'vat', vat: 12 },
  AU: { regime: 'gst', vat: 10 },
  NZ: { regime: 'gst', vat: 15 },

  // — Middle East & Africa —
  AE: { regime: 'vat', vat: 5 },
  SA: { regime: 'vat', vat: 15 },
  QA: { regime: 'no-vat', vat: null },
  KW: { regime: 'no-vat', vat: null },
  IL: { regime: 'vat', vat: 18, note: 'Raised from 17% on 1 January 2025.' },
  KZ: { regime: 'vat', vat: 12 },
  ZA: { regime: 'vat', vat: 15 },
  NG: { regime: 'vat', vat: 7.5 },
  EG: { regime: 'vat', vat: 14 },
  MA: { regime: 'vat', vat: 20 },
  KE: { regime: 'vat', vat: 16 },
};

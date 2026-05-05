/**
 * State statute metadata + system-prompt builders.
 *
 * Used by the chat research-mode toggles. For each state we know:
 *   - code           — 2-letter postal code (FL, CA, ...)
 *   - name           — full state name
 *   - code_url       — root URL of the official statutes site
 *                      (or Justia mirror as fallback for states
 *                      without a curated official URL)
 *   - cornell_url    — Cornell LII state page (when available)
 *   - justia_url     — Justia state codes page (always)
 *   - citation_format — Bluebook abbreviation template
 *                      (interpolated by the model when citing)
 *
 * Curated official URLs ship for FL/CA/TX/NY/IL. The rest fall
 * through to Justia as primary; the user is curating a fuller list
 * over time and entries can be dropped in here without a migration.
 *
 * Pure data + small helper. Runtime-portable (works in Deno edge
 * functions and Node functions).
 */

export const US_STATES = [
  {
    code: 'AL', name: 'Alabama',
    code_url: 'https://law.justia.com/codes/alabama/',
    cornell_url: 'https://www.law.cornell.edu/states/alabama',
    justia_url: 'https://law.justia.com/codes/alabama/',
    citation_format: 'Ala. Code § {section}',
  },
  {
    code: 'AK', name: 'Alaska',
    code_url: 'https://law.justia.com/codes/alaska/',
    cornell_url: 'https://www.law.cornell.edu/states/alaska',
    justia_url: 'https://law.justia.com/codes/alaska/',
    citation_format: 'Alaska Stat. § {section}',
  },
  {
    code: 'AZ', name: 'Arizona',
    code_url: 'https://law.justia.com/codes/arizona/',
    cornell_url: 'https://www.law.cornell.edu/states/arizona',
    justia_url: 'https://law.justia.com/codes/arizona/',
    citation_format: 'Ariz. Rev. Stat. § {section}',
  },
  {
    code: 'AR', name: 'Arkansas',
    code_url: 'https://law.justia.com/codes/arkansas/',
    cornell_url: 'https://www.law.cornell.edu/states/arkansas',
    justia_url: 'https://law.justia.com/codes/arkansas/',
    citation_format: 'Ark. Code Ann. § {section}',
  },
  {
    code: 'CA', name: 'California',
    code_url: 'https://leginfo.legislature.ca.gov/faces/codes.xhtml',
    cornell_url: 'https://www.law.cornell.edu/states/california',
    justia_url: 'https://law.justia.com/codes/california/',
    citation_format: 'Cal. {code_abbrev} § {section}',
  },
  {
    code: 'CO', name: 'Colorado',
    code_url: 'https://law.justia.com/codes/colorado/',
    cornell_url: 'https://www.law.cornell.edu/states/colorado',
    justia_url: 'https://law.justia.com/codes/colorado/',
    citation_format: 'Colo. Rev. Stat. § {section}',
  },
  {
    code: 'CT', name: 'Connecticut',
    code_url: 'https://law.justia.com/codes/connecticut/',
    cornell_url: 'https://www.law.cornell.edu/states/connecticut',
    justia_url: 'https://law.justia.com/codes/connecticut/',
    citation_format: 'Conn. Gen. Stat. § {section}',
  },
  {
    code: 'DE', name: 'Delaware',
    code_url: 'https://law.justia.com/codes/delaware/',
    cornell_url: 'https://www.law.cornell.edu/states/delaware',
    justia_url: 'https://law.justia.com/codes/delaware/',
    citation_format: 'Del. Code Ann. tit. {title}, § {section}',
  },
  {
    code: 'DC', name: 'District of Columbia',
    code_url: 'https://law.justia.com/codes/district-of-columbia/',
    cornell_url: 'https://www.law.cornell.edu/states/district-of-columbia',
    justia_url: 'https://law.justia.com/codes/district-of-columbia/',
    citation_format: 'D.C. Code § {section}',
  },
  {
    code: 'FL', name: 'Florida',
    code_url: 'http://www.leg.state.fl.us/statutes/',
    cornell_url: 'https://www.law.cornell.edu/states/florida',
    justia_url: 'https://law.justia.com/codes/florida/',
    citation_format: 'Fla. Stat. § {section}',
  },
  {
    code: 'GA', name: 'Georgia',
    code_url: 'https://law.justia.com/codes/georgia/',
    cornell_url: 'https://www.law.cornell.edu/states/georgia',
    justia_url: 'https://law.justia.com/codes/georgia/',
    citation_format: 'Ga. Code Ann. § {section}',
  },
  {
    code: 'HI', name: 'Hawaii',
    code_url: 'https://law.justia.com/codes/hawaii/',
    cornell_url: 'https://www.law.cornell.edu/states/hawaii',
    justia_url: 'https://law.justia.com/codes/hawaii/',
    citation_format: 'Haw. Rev. Stat. § {section}',
  },
  {
    code: 'ID', name: 'Idaho',
    code_url: 'https://law.justia.com/codes/idaho/',
    cornell_url: 'https://www.law.cornell.edu/states/idaho',
    justia_url: 'https://law.justia.com/codes/idaho/',
    citation_format: 'Idaho Code § {section}',
  },
  {
    code: 'IL', name: 'Illinois',
    code_url: 'https://www.ilga.gov/legislation/ilcs/ilcs.asp',
    cornell_url: 'https://www.law.cornell.edu/states/illinois',
    justia_url: 'https://law.justia.com/codes/illinois/',
    citation_format: '{chapter} ILCS {act}/{section}',
  },
  {
    code: 'IN', name: 'Indiana',
    code_url: 'https://law.justia.com/codes/indiana/',
    cornell_url: 'https://www.law.cornell.edu/states/indiana',
    justia_url: 'https://law.justia.com/codes/indiana/',
    citation_format: 'Ind. Code § {section}',
  },
  {
    code: 'IA', name: 'Iowa',
    code_url: 'https://law.justia.com/codes/iowa/',
    cornell_url: 'https://www.law.cornell.edu/states/iowa',
    justia_url: 'https://law.justia.com/codes/iowa/',
    citation_format: 'Iowa Code § {section}',
  },
  {
    code: 'KS', name: 'Kansas',
    code_url: 'https://law.justia.com/codes/kansas/',
    cornell_url: 'https://www.law.cornell.edu/states/kansas',
    justia_url: 'https://law.justia.com/codes/kansas/',
    citation_format: 'Kan. Stat. Ann. § {section}',
  },
  {
    code: 'KY', name: 'Kentucky',
    code_url: 'https://law.justia.com/codes/kentucky/',
    cornell_url: 'https://www.law.cornell.edu/states/kentucky',
    justia_url: 'https://law.justia.com/codes/kentucky/',
    citation_format: 'Ky. Rev. Stat. Ann. § {section}',
  },
  {
    code: 'LA', name: 'Louisiana',
    code_url: 'https://law.justia.com/codes/louisiana/',
    cornell_url: 'https://www.law.cornell.edu/states/louisiana',
    justia_url: 'https://law.justia.com/codes/louisiana/',
    citation_format: 'La. {code_abbrev} Ann. § {section}',
  },
  {
    code: 'ME', name: 'Maine',
    code_url: 'https://law.justia.com/codes/maine/',
    cornell_url: 'https://www.law.cornell.edu/states/maine',
    justia_url: 'https://law.justia.com/codes/maine/',
    citation_format: 'Me. Rev. Stat. tit. {title}, § {section}',
  },
  {
    code: 'MD', name: 'Maryland',
    code_url: 'https://law.justia.com/codes/maryland/',
    cornell_url: 'https://www.law.cornell.edu/states/maryland',
    justia_url: 'https://law.justia.com/codes/maryland/',
    citation_format: 'Md. Code Ann., {article} § {section}',
  },
  {
    code: 'MA', name: 'Massachusetts',
    code_url: 'https://law.justia.com/codes/massachusetts/',
    cornell_url: 'https://www.law.cornell.edu/states/massachusetts',
    justia_url: 'https://law.justia.com/codes/massachusetts/',
    citation_format: 'Mass. Gen. Laws ch. {chapter}, § {section}',
  },
  {
    code: 'MI', name: 'Michigan',
    code_url: 'https://law.justia.com/codes/michigan/',
    cornell_url: 'https://www.law.cornell.edu/states/michigan',
    justia_url: 'https://law.justia.com/codes/michigan/',
    citation_format: 'Mich. Comp. Laws § {section}',
  },
  {
    code: 'MN', name: 'Minnesota',
    code_url: 'https://law.justia.com/codes/minnesota/',
    cornell_url: 'https://www.law.cornell.edu/states/minnesota',
    justia_url: 'https://law.justia.com/codes/minnesota/',
    citation_format: 'Minn. Stat. § {section}',
  },
  {
    code: 'MS', name: 'Mississippi',
    code_url: 'https://law.justia.com/codes/mississippi/',
    cornell_url: 'https://www.law.cornell.edu/states/mississippi',
    justia_url: 'https://law.justia.com/codes/mississippi/',
    citation_format: 'Miss. Code Ann. § {section}',
  },
  {
    code: 'MO', name: 'Missouri',
    code_url: 'https://law.justia.com/codes/missouri/',
    cornell_url: 'https://www.law.cornell.edu/states/missouri',
    justia_url: 'https://law.justia.com/codes/missouri/',
    citation_format: 'Mo. Rev. Stat. § {section}',
  },
  {
    code: 'MT', name: 'Montana',
    code_url: 'https://law.justia.com/codes/montana/',
    cornell_url: 'https://www.law.cornell.edu/states/montana',
    justia_url: 'https://law.justia.com/codes/montana/',
    citation_format: 'Mont. Code Ann. § {section}',
  },
  {
    code: 'NE', name: 'Nebraska',
    code_url: 'https://law.justia.com/codes/nebraska/',
    cornell_url: 'https://www.law.cornell.edu/states/nebraska',
    justia_url: 'https://law.justia.com/codes/nebraska/',
    citation_format: 'Neb. Rev. Stat. § {section}',
  },
  {
    code: 'NV', name: 'Nevada',
    code_url: 'https://law.justia.com/codes/nevada/',
    cornell_url: 'https://www.law.cornell.edu/states/nevada',
    justia_url: 'https://law.justia.com/codes/nevada/',
    citation_format: 'Nev. Rev. Stat. § {section}',
  },
  {
    code: 'NH', name: 'New Hampshire',
    code_url: 'https://law.justia.com/codes/new-hampshire/',
    cornell_url: 'https://www.law.cornell.edu/states/new-hampshire',
    justia_url: 'https://law.justia.com/codes/new-hampshire/',
    citation_format: 'N.H. Rev. Stat. Ann. § {section}',
  },
  {
    code: 'NJ', name: 'New Jersey',
    code_url: 'https://law.justia.com/codes/new-jersey/',
    cornell_url: 'https://www.law.cornell.edu/states/new-jersey',
    justia_url: 'https://law.justia.com/codes/new-jersey/',
    citation_format: 'N.J. Stat. Ann. § {section}',
  },
  {
    code: 'NM', name: 'New Mexico',
    code_url: 'https://law.justia.com/codes/new-mexico/',
    cornell_url: 'https://www.law.cornell.edu/states/new-mexico',
    justia_url: 'https://law.justia.com/codes/new-mexico/',
    citation_format: 'N.M. Stat. Ann. § {section}',
  },
  {
    code: 'NY', name: 'New York',
    code_url: 'https://www.nysenate.gov/legislation/laws',
    cornell_url: 'https://www.law.cornell.edu/states/new-york',
    justia_url: 'https://law.justia.com/codes/new-york/',
    citation_format: 'N.Y. {code_abbrev} Law § {section}',
  },
  {
    code: 'NC', name: 'North Carolina',
    code_url: 'https://law.justia.com/codes/north-carolina/',
    cornell_url: 'https://www.law.cornell.edu/states/north-carolina',
    justia_url: 'https://law.justia.com/codes/north-carolina/',
    citation_format: 'N.C. Gen. Stat. § {section}',
  },
  {
    code: 'ND', name: 'North Dakota',
    code_url: 'https://law.justia.com/codes/north-dakota/',
    cornell_url: 'https://www.law.cornell.edu/states/north-dakota',
    justia_url: 'https://law.justia.com/codes/north-dakota/',
    citation_format: 'N.D. Cent. Code § {section}',
  },
  {
    code: 'OH', name: 'Ohio',
    code_url: 'https://law.justia.com/codes/ohio/',
    cornell_url: 'https://www.law.cornell.edu/states/ohio',
    justia_url: 'https://law.justia.com/codes/ohio/',
    citation_format: 'Ohio Rev. Code Ann. § {section}',
  },
  {
    code: 'OK', name: 'Oklahoma',
    code_url: 'https://law.justia.com/codes/oklahoma/',
    cornell_url: 'https://www.law.cornell.edu/states/oklahoma',
    justia_url: 'https://law.justia.com/codes/oklahoma/',
    citation_format: 'Okla. Stat. tit. {title}, § {section}',
  },
  {
    code: 'OR', name: 'Oregon',
    code_url: 'https://law.justia.com/codes/oregon/',
    cornell_url: 'https://www.law.cornell.edu/states/oregon',
    justia_url: 'https://law.justia.com/codes/oregon/',
    citation_format: 'Or. Rev. Stat. § {section}',
  },
  {
    code: 'PA', name: 'Pennsylvania',
    code_url: 'https://law.justia.com/codes/pennsylvania/',
    cornell_url: 'https://www.law.cornell.edu/states/pennsylvania',
    justia_url: 'https://law.justia.com/codes/pennsylvania/',
    citation_format: '{title} Pa. Cons. Stat. § {section}',
  },
  {
    code: 'RI', name: 'Rhode Island',
    code_url: 'https://law.justia.com/codes/rhode-island/',
    cornell_url: 'https://www.law.cornell.edu/states/rhode-island',
    justia_url: 'https://law.justia.com/codes/rhode-island/',
    citation_format: 'R.I. Gen. Laws § {section}',
  },
  {
    code: 'SC', name: 'South Carolina',
    code_url: 'https://law.justia.com/codes/south-carolina/',
    cornell_url: 'https://www.law.cornell.edu/states/south-carolina',
    justia_url: 'https://law.justia.com/codes/south-carolina/',
    citation_format: 'S.C. Code Ann. § {section}',
  },
  {
    code: 'SD', name: 'South Dakota',
    code_url: 'https://law.justia.com/codes/south-dakota/',
    cornell_url: 'https://www.law.cornell.edu/states/south-dakota',
    justia_url: 'https://law.justia.com/codes/south-dakota/',
    citation_format: 'S.D. Codified Laws § {section}',
  },
  {
    code: 'TN', name: 'Tennessee',
    code_url: 'https://law.justia.com/codes/tennessee/',
    cornell_url: 'https://www.law.cornell.edu/states/tennessee',
    justia_url: 'https://law.justia.com/codes/tennessee/',
    citation_format: 'Tenn. Code Ann. § {section}',
  },
  {
    code: 'TX', name: 'Texas',
    code_url: 'https://statutes.capitol.texas.gov/',
    cornell_url: 'https://www.law.cornell.edu/states/texas',
    justia_url: 'https://law.justia.com/codes/texas/',
    citation_format: 'Tex. {code_abbrev} Code Ann. § {section}',
  },
  {
    code: 'UT', name: 'Utah',
    code_url: 'https://law.justia.com/codes/utah/',
    cornell_url: 'https://www.law.cornell.edu/states/utah',
    justia_url: 'https://law.justia.com/codes/utah/',
    citation_format: 'Utah Code Ann. § {section}',
  },
  {
    code: 'VT', name: 'Vermont',
    code_url: 'https://law.justia.com/codes/vermont/',
    cornell_url: 'https://www.law.cornell.edu/states/vermont',
    justia_url: 'https://law.justia.com/codes/vermont/',
    citation_format: 'Vt. Stat. Ann. tit. {title}, § {section}',
  },
  {
    code: 'VA', name: 'Virginia',
    code_url: 'https://law.justia.com/codes/virginia/',
    cornell_url: 'https://www.law.cornell.edu/states/virginia',
    justia_url: 'https://law.justia.com/codes/virginia/',
    citation_format: 'Va. Code Ann. § {section}',
  },
  {
    code: 'WA', name: 'Washington',
    code_url: 'https://law.justia.com/codes/washington/',
    cornell_url: 'https://www.law.cornell.edu/states/washington',
    justia_url: 'https://law.justia.com/codes/washington/',
    citation_format: 'Wash. Rev. Code § {section}',
  },
  {
    code: 'WV', name: 'West Virginia',
    code_url: 'https://law.justia.com/codes/west-virginia/',
    cornell_url: 'https://www.law.cornell.edu/states/west-virginia',
    justia_url: 'https://law.justia.com/codes/west-virginia/',
    citation_format: 'W. Va. Code § {section}',
  },
  {
    code: 'WI', name: 'Wisconsin',
    code_url: 'https://law.justia.com/codes/wisconsin/',
    cornell_url: 'https://www.law.cornell.edu/states/wisconsin',
    justia_url: 'https://law.justia.com/codes/wisconsin/',
    citation_format: 'Wis. Stat. § {section}',
  },
  {
    code: 'WY', name: 'Wyoming',
    code_url: 'https://law.justia.com/codes/wyoming/',
    cornell_url: 'https://www.law.cornell.edu/states/wyoming',
    justia_url: 'https://law.justia.com/codes/wyoming/',
    citation_format: 'Wyo. Stat. Ann. § {section}',
  },
  // Federal entry — selectable when the user wants pure-federal
  // research (no state component). When `code = 'US'`, the state
  // pre-grounding paths target the U.S. Code, federal courts, and
  // Congress directly.
  {
    code: 'US', name: 'Federal (United States)',
    code_url: 'https://www.law.cornell.edu/uscode/text',
    cornell_url: 'https://www.law.cornell.edu/uscode/text',
    justia_url: 'https://law.justia.com/codes/us/',
    citation_format: '{title} U.S.C. § {section}',
    is_federal: true,
  },
];

const _BY_CODE = new Map(US_STATES.map((s) => [s.code, s]));

export function findState(code) {
  if (!code) return null;
  return _BY_CODE.get(String(code).toUpperCase().slice(0, 2)) || null;
}

export function clampStateCode(code) {
  return findState(code)?.code || 'FL';
}

/**
 * CourtListener court IDs grouped by state. Used by the case-law
 * fetcher's jurisdiction filter. Includes the state supreme court,
 * intermediate appellate courts, and any specialized courts that
 * publish opinions to CL. List is intentionally permissive — too
 * broad is fine; CL ranks by relevance.
 */
export const STATE_TO_CL_COURTS = {
  AL: ['ala', 'alacrimapp', 'alacivapp'],
  AK: ['alaska', 'alaskactapp'],
  AZ: ['ariz', 'arizctapp', 'ariztaxct'],
  AR: ['ark', 'arkctapp'],
  CA: ['cal', 'calctapp', 'calappdeptsuper'],
  CO: ['colo', 'coloctapp'],
  CT: ['conn', 'connappct', 'connsuperct'],
  DE: ['del', 'delch', 'delsuperct', 'delfamct'],
  DC: ['dc'],
  FL: ['fla', 'flactapp', 'flsupct'],
  GA: ['ga', 'gactapp'],
  HI: ['haw', 'hawapp'],
  ID: ['idaho', 'idahoctapp'],
  IL: ['ill', 'illappct'],
  IN: ['ind', 'indctapp', 'indtc'],
  IA: ['iowa', 'iowactapp'],
  KS: ['kan', 'kanctapp'],
  KY: ['ky', 'kyctapp'],
  LA: ['la', 'lactapp'],
  ME: ['me'],
  MD: ['md', 'mdctspecapp'],
  MA: ['mass', 'massappct'],
  MI: ['mich', 'michctapp'],
  MN: ['minn', 'minnctapp'],
  MS: ['miss', 'missctapp'],
  MO: ['mo', 'moctapp'],
  MT: ['mont'],
  NE: ['neb', 'nebctapp'],
  NV: ['nev', 'nvctapp'],
  NH: ['nh'],
  NJ: ['nj', 'njsuperctappdiv', 'njtaxct'],
  NM: ['nm', 'nmctapp'],
  NY: ['ny', 'nyappdiv', 'nyappterm', 'nyctapp'],
  NC: ['nc', 'ncctapp'],
  ND: ['nd'],
  OH: ['ohio', 'ohioctapp'],
  OK: ['okla', 'oklacrimapp', 'oklacivapp'],
  OR: ['or', 'orctapp'],
  PA: ['pa', 'pasuperct', 'pacommwct'],
  RI: ['ri'],
  SC: ['sc', 'scctapp'],
  SD: ['sd'],
  TN: ['tenn', 'tennctapp', 'tenncrimapp'],
  TX: ['tex', 'texapp', 'texcrimapp'],
  UT: ['utah', 'utahctapp'],
  VT: ['vt'],
  VA: ['va', 'vactapp'],
  WA: ['wash', 'washctapp'],
  WV: ['wva'],
  WI: ['wis', 'wisctapp'],
  WY: ['wyo'],
  // Pure-federal selection: SCOTUS + every circuit court of appeals.
  US: ['scotus', 'ca1', 'ca2', 'ca3', 'ca4', 'ca5', 'ca6', 'ca7', 'ca8', 'ca9', 'ca10', 'ca11', 'cadc', 'cafc'],
};

/**
 * Federal court IDs to include alongside state courts when the
 * user has selected a state (i.e., not the "US" federal-only
 * option). Maps each state to its corresponding U.S. Court of
 * Appeals circuit. SCOTUS is always included.
 *
 * Federal district courts within each state would be ideal
 * additions but the CL court IDs follow the per-district naming
 * convention (e.g. flmd, flnd, flsd) and CL search by court
 * accepts a comma list. For v1 we include just SCOTUS + circuit;
 * district-level coverage falls to web search if the model needs it.
 */
export const STATE_TO_FEDERAL_COURTS = {
  AL: ['scotus', 'ca11'],
  AK: ['scotus', 'ca9'],
  AZ: ['scotus', 'ca9'],
  AR: ['scotus', 'ca8'],
  CA: ['scotus', 'ca9'],
  CO: ['scotus', 'ca10'],
  CT: ['scotus', 'ca2'],
  DE: ['scotus', 'ca3'],
  DC: ['scotus', 'cadc'],
  FL: ['scotus', 'ca11'],
  GA: ['scotus', 'ca11'],
  HI: ['scotus', 'ca9'],
  ID: ['scotus', 'ca9'],
  IL: ['scotus', 'ca7'],
  IN: ['scotus', 'ca7'],
  IA: ['scotus', 'ca8'],
  KS: ['scotus', 'ca10'],
  KY: ['scotus', 'ca6'],
  LA: ['scotus', 'ca5'],
  ME: ['scotus', 'ca1'],
  MD: ['scotus', 'ca4'],
  MA: ['scotus', 'ca1'],
  MI: ['scotus', 'ca6'],
  MN: ['scotus', 'ca8'],
  MS: ['scotus', 'ca5'],
  MO: ['scotus', 'ca8'],
  MT: ['scotus', 'ca9'],
  NE: ['scotus', 'ca8'],
  NV: ['scotus', 'ca9'],
  NH: ['scotus', 'ca1'],
  NJ: ['scotus', 'ca3'],
  NM: ['scotus', 'ca10'],
  NY: ['scotus', 'ca2'],
  NC: ['scotus', 'ca4'],
  ND: ['scotus', 'ca8'],
  OH: ['scotus', 'ca6'],
  OK: ['scotus', 'ca10'],
  OR: ['scotus', 'ca9'],
  PA: ['scotus', 'ca3'],
  RI: ['scotus', 'ca1'],
  SC: ['scotus', 'ca4'],
  SD: ['scotus', 'ca8'],
  TN: ['scotus', 'ca6'],
  TX: ['scotus', 'ca5'],
  UT: ['scotus', 'ca10'],
  VT: ['scotus', 'ca2'],
  VA: ['scotus', 'ca4'],
  WA: ['scotus', 'ca9'],
  WV: ['scotus', 'ca4'],
  WI: ['scotus', 'ca7'],
  WY: ['scotus', 'ca10'],
};

/**
 * Builds the system-prompt block injected when the statutes toggle
 * is on. Optionally includes already-fetched primary-authority
 * statute text under "Authoritative Statutory Source" — when the
 * waterfall succeeded — so the model can quote it verbatim.
 */
export function buildStatuteSystemBlock(state, fetched = null) {
  const primary = fetched?.primary || null;        // 'state' | 'cornell' | 'justia'
  const text = fetched?.parsed_text || null;
  const url = fetched?.source_url || state.code_url;
  const isFederal = !!state.is_federal;

  let header = isFederal
    ? `## Statute-First Research Mode (Federal — U.S. Code)\n\nYou are operating in statute-first research mode. The user (a licensed attorney) requires that the U.S. Code be treated as primary authority.\n\n`
    : `## Statute-First Research Mode (${state.name})\n\nYou are operating in statute-first research mode. The user (a licensed attorney) requires that ${state.name} statutes be treated as primary authority. Federal law (U.S. Code, U.S. Constitution, federal regulations) is also relevant — cite federal authority when it bears on the question, but state law is your primary anchor.\n\n`;

  if (text) {
    header +=
      `### Authoritative Statutory Source\n` +
      `Source: ${url}${primary ? `   [primary=${primary}]` : ''}\n\n` +
      `---\n${text.slice(0, 8000)}\n---\n\n` +
      `Use the verbatim language above when citing. Always include the exact section number and the source URL. ` +
      `If the user's question is not addressed by this section, say so plainly and use your web_search tool to look for related sections.\n\n`;
  }

  header +=
    `### Sourcing rules\n` +
    `1. When you cite a statute, use Bluebook form: "${state.citation_format}".\n` +
    `2. Attach the source URL using footnote-style markdown: write the citation in prose, then immediately after the citation place "[1](URL)" where URL is the deep link to that section. Example: 'Fla. Stat. § 768.81 [1](http://www.leg.state.fl.us/statutes/...)'. Number the footnotes sequentially.\n` +
    `3. NEVER paste raw URLs into the prose itself. Refer to a website by hostname when discussing it (e.g., "available at leg.state.fl.us" — NOT the full URL).\n` +
    `4. If you cannot retrieve current statutory text, label your answer as "general principles" rather than authoritative law.\n` +
    `5. Quote operative statutory language sparingly (≤25 words) and put it in double quotes.\n` +
    `6. Never invent a statute citation. If you don't have a verified one, say so.\n` +
    `7. Statute language overrides any case-law commentary you might know — when statute and case appear to conflict, follow the statute and note the conflict.\n`;

  if (!isFederal) {
    header +=
      `\n### Federal-Law Backstop\n` +
      `Always check whether federal law (U.S. Code at law.cornell.edu/uscode/text, federal regulations, the U.S. Constitution) is implicated. Common scenarios: federal preemption, dormant Commerce Clause, civil-rights statutes, federal procedural rules in diversity, ERISA, federal tax. When federal law is relevant, cite it in the same Bluebook footnote format ("12 U.S.C. § 5301 [1](https://www.law.cornell.edu/uscode/text/12/5301)"). State law remains your anchor for state-specific questions.\n`;
  }

  header +=
    `\nAuthoritative source URLs (footnote targets — do NOT echo as bare URLs in prose):\n` +
    `  ${isFederal ? 'primary' : 'state primary'}: ${state.code_url}\n` +
    `  Cornell: ${state.cornell_url}\n` +
    `  Justia: ${state.justia_url}\n` +
    (isFederal ? '' : `  U.S. Code (Cornell): https://www.law.cornell.edu/uscode/text\n  CFR (Cornell): https://www.law.cornell.edu/cfr/text\n  Supreme Court (oyez or supreme.justia.com): supreme.justia.com\n`);

  return header;
}

/**
 * Allowed-domain lists for each provider's web_search tool. We
 * restrict to known authoritative sources for the selected state,
 * plus universal authoritative domains. All four providers receive
 * the same base list; Grok caps at 5 entries (we send the most
 * authoritative).
 */
export function buildAllowedDomains({ statutesOn, caseLawOn, legiscanOn, state }) {
  const set = new Set();
  if (state) {
    try { set.add(new URL(state.code_url).hostname); } catch {}
    try { set.add(new URL(state.cornell_url).hostname); } catch {}
    try { set.add(new URL(state.justia_url).hostname); } catch {}
  }
  // Federal authoritative domains — always included so the model
  // can pull U.S. Code, CFR, federal regulations, and federal-court
  // material alongside any state-specific research. Per the user's
  // requirement that federal law is always available alongside
  // state law, regardless of which state is selected.
  set.add('law.cornell.edu');           // U.S. Code, CFR, Constitution
  set.add('law.justia.com');             // U.S. Code mirror + state codes
  set.add('supreme.justia.com');         // SCOTUS opinions
  set.add('supremecourt.gov');           // Official SCOTUS site
  set.add('congress.gov');               // Federal bills + statutes-at-large
  set.add('uscode.house.gov');           // Official U.S. Code
  set.add('ecfr.gov');                   // Electronic CFR (federal regs)
  set.add('federalregister.gov');        // Federal Register
  if (caseLawOn) set.add('www.courtlistener.com');
  if (legiscanOn) set.add('legiscan.com');
  return Array.from(set);
}

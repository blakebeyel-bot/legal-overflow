/**
 * Minimum-viable company profile used when a user runs a review without
 * having filled the form or uploaded a playbook.
 *
 * With this profile, every specialist's Tier-1 (profile-driven) checks
 * produce zero findings because `red_flags` is empty and every
 * `positions.<category>` is absent. The entire review comes from Tier-2
 * (industry-baseline) checks informed by the system-level checklists in
 * each agent's system prompt. The UI tags these as INDUSTRY BASELINE.
 *
 * The `_is_default_profile` marker lets the client UI and future code
 * detect that no real profile is driving the review — useful for
 * showing a "run the form for a tailored review" nudge.
 *
 * Required-fields come from config/company_profile.schema.json.
 */
export const DEFAULT_PROFILE = {
  company: {
    name: 'Anonymous Company',
    short_name: 'Client',
    industry: 'General',
    role_in_contracts: 'Party',
    business_description:
      'No company profile has been configured. Review is running on industry-baseline checks only; fill the Configure form for a profile-driven review.',
  },
  jurisdiction: {
    primary: 'Not specified',
    secondary: [],
    preferred_statutes: {},
    disfavored_venues: [],
  },
  positions: {},
  red_flags: [],
  escalation: {
    senior_reviewers: [],
    escalation_trigger_severity: 'Blocker',
  },
  voice: {
    tone: 'professional',
    speaker_label: 'Party',
    counterparty_label: 'Counterparty',
    max_comment_length_chars: 500,
    cite_statutes: false,
    cite_industry_standards: true,
  },
  output: {
    // Field names align with company_profile.schema.json (reviewer_author,
    // not reviewer_name; annotated_file_suffix, not file_naming_suffix).
    reviewer_author: 'Legal Overflow',
    reviewer_initials: 'LO',
    annotated_file_suffix: '_Annotated',
  },
  _is_default_profile: true,
};

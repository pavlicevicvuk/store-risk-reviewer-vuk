export type Platform = 'ios' | 'android' | 'both';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export type FindingCategory = 'Code' | 'Configuration' | 'Metadata' | 'Compliance';

// What the reviewer is allowed to judge against: the curated rule pack only, or the
// official Apple/Google guideline excerpts only. Kept as an `as const` map (no enum) so
// stripping types leaves valid JS.
export const REVIEW_BASIS = {
  rules: 'rules',
  docs: 'docs',
} as const;

export type ReviewBasis = (typeof REVIEW_BASIS)[keyof typeof REVIEW_BASIS];

export type DiffFile = {
  path: string;
  status: string;
  patch: string;
};

export type Rule = {
  id: string;
  title: string;
  platform: Platform;
  category: FindingCategory;
  defaultSeverity: Severity;
  guidelineRef: string;
  signals: string;
  remediation: string;
};

export type Finding = {
  ruleId: string;
  platform: Platform;
  category: FindingCategory;
  severity: Severity;
  title: string;
  file: string;
  evidence: string;
  guidelineRef: string;
  remediation: string;
};

export type FileAnalysis = {
  findings: Finding[];
  overflowCount: number;
};

export type RiskSummary = {
  iosRisk: RiskLevel;
  androidRisk: RiskLevel;
  combinedRisk: RiskLevel;
};

export type ReportInput = RiskSummary & {
  findings: Finding[];
  filesAnalyzed: number;
  overflowCount: number;
  agentRequests: number;
  fromCache: boolean;
  model: string;
  basis: ReviewBasis;
  rulesVersion: string;
  corpusVersion: string;
};

export type Platform = 'ios' | 'android' | 'both';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export type FindingCategory = 'Code' | 'Configuration' | 'Metadata' | 'Compliance';

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
};

export type RiskSummary = {
  iosRisk: RiskLevel;
  androidRisk: RiskLevel;
  combinedRisk: RiskLevel;
};

export type ReportInput = RiskSummary & {
  findings: Finding[];
  filesAnalyzed: number;
  filesCached: number;
  model: string;
  rulesVersion: string;
};

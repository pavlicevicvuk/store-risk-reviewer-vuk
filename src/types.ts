export type Platform = 'ios' | 'android' | 'both';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export type FindingCategory = 'Code' | 'Configuration' | 'Metadata' | 'Compliance';

export type DiffFile = {
  path: string;
  status: string;
  patch: string;
};

export type Finding = {
  guidelineId: string;
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
  requests: number;
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
  model: string;
  corpusVersion: string;
};

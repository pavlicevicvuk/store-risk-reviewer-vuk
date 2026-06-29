import type { Finding, Platform, RiskLevel, RiskSummary, Severity } from './types.ts';

const SEVERITY_TO_RISK: Record<Severity, RiskLevel> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const RISK_ORDER: readonly RiskLevel[] = ['Low', 'Medium', 'High', 'Critical'];

const higherRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;

const appliesTo = (finding: Finding, platform: Platform): boolean =>
  finding.platform === platform || finding.platform === 'both';

const riskForPlatform = (findings: Finding[], platform: Platform): RiskLevel => {
  let risk: RiskLevel = 'Low';
  for (const finding of findings) {
    if (appliesTo(finding, platform)) {
      risk = higherRisk(risk, SEVERITY_TO_RISK[finding.severity]);
    }
  }
  return risk;
};

export const scoreFindings = (findings: Finding[]): RiskSummary => {
  const iosRisk = riskForPlatform(findings, 'ios');
  const androidRisk = riskForPlatform(findings, 'android');
  return {
    iosRisk,
    androidRisk,
    combinedRisk: higherRisk(iosRisk, androidRisk),
  };
};

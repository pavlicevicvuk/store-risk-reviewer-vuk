// Each report embeds a hidden marker as its first line so a re-run can find and update its
// own previous comment instead of stacking a new one on every push.
export const DOCS_REPORT_MARKER = '<!-- ai-review-report-docs -->';
export const AUDIT_REPORT_MARKER = '<!-- ai-audit-report -->';

const LEADING_MARKER = /^\s*(<!--[^>]*-->)/;

export const extractMarker = (body: string): string | undefined => {
  const match = LEADING_MARKER.exec(body);
  return match?.[1];
};

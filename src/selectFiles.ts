import type { DiffFile } from './types.ts';

const RELEVANT_PATTERNS: RegExp[] = [
  /\.(ts|tsx|js|jsx)$/,
  /\.(swift|m|mm|h)$/,
  /\.(kt|java)$/,
  /Info\.plist$/,
  /\.entitlements$/,
  /PrivacyInfo\.xcprivacy$/,
  /(^|\/)Podfile$/,
  /AndroidManifest\.xml$/,
  /build\.gradle(\.kts)?$/,
  /(^|\/)app\.config\.(js|ts)$/,
  /(^|\/)app\.json$/,
];

const IGNORED_PATTERNS: RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  /(^|\/)node_modules\//,
  /(^|\/)Pods\//,
];

const isRelevant = (file: DiffFile): boolean =>
  RELEVANT_PATTERNS.some((pattern) => pattern.test(file.path)) &&
  !IGNORED_PATTERNS.some((pattern) => pattern.test(file.path));

export const selectFiles = (files: DiffFile[]): DiffFile[] => files.filter(isRelevant);

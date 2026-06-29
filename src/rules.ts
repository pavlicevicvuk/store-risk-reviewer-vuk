import type { Rule } from './types.ts';

export const RULES_VERSION = '2026-06-24.1';

export const RULES: Rule[] = [
  {
    id: 'ios-att-tracking',
    title: 'Tracking without App Tracking Transparency prompt',
    platform: 'ios',
    category: 'Compliance',
    defaultSeverity: 'high',
    guidelineRef: 'Apple App Store Review Guideline 5.1.2',
    signals:
      'Adds advertising/analytics SDKs, IDFA access, or cross-app tracking without requesting ATT authorization (NSUserTrackingUsageDescription + requestTrackingAuthorization).',
    remediation:
      'Add NSUserTrackingUsageDescription and call ATTrackingManager.requestTrackingAuthorization before any tracking. Confirm the Privacy nutrition label declares tracking.',
  },
  {
    id: 'ios-usage-descriptions',
    title: 'Permission used without a clear purpose string',
    platform: 'ios',
    category: 'Configuration',
    defaultSeverity: 'high',
    guidelineRef: 'Apple App Store Review Guideline 5.1.1',
    signals:
      'Uses camera, location, microphone, contacts, photos, calendar, Bluetooth, etc. without a corresponding NS*UsageDescription, or with a vague/empty purpose string.',
    remediation:
      'Add a specific, user-facing NS*UsageDescription in Info.plist explaining exactly why the data is needed.',
  },
  {
    id: 'ios-privacy-manifest',
    title: 'Missing or incomplete privacy manifest for required-reason APIs',
    platform: 'ios',
    category: 'Configuration',
    defaultSeverity: 'high',
    guidelineRef: 'Apple Privacy Manifest policy',
    signals:
      'Uses required-reason APIs (UserDefaults, file timestamps, disk space, system boot time) or adds SDKs requiring a manifest without updating PrivacyInfo.xcprivacy.',
    remediation:
      'Add or update PrivacyInfo.xcprivacy with the required reason codes and declared data collection for any new SDK or API.',
  },
  {
    id: 'payments-iap-bypass',
    title: 'Digital goods sold outside in-app purchase / Play Billing',
    platform: 'both',
    category: 'Compliance',
    defaultSeverity: 'critical',
    guidelineRef: 'Apple Guideline 3.1.1 / Google Play Payments policy',
    signals:
      'Adds external payment links, web checkout, or third-party billing for in-app digital content or subscriptions instead of StoreKit / Google Play Billing.',
    remediation:
      'Use StoreKit (iOS) and Google Play Billing (Android) for digital goods. Remove external purchase flows or links steering users off-platform.',
  },
  {
    id: 'account-deletion',
    title: 'Account creation without in-app account deletion',
    platform: 'both',
    category: 'Compliance',
    defaultSeverity: 'high',
    guidelineRef: 'Apple Guideline 5.1.1(v) / Google Play account deletion policy',
    signals:
      'Adds account creation/registration flows but no in-app path to delete the account and associated data.',
    remediation:
      'Provide an in-app account deletion flow that removes the account and personal data, reachable without contacting support.',
  },
  {
    id: 'ios-healthkit-misuse',
    title: 'Health / fitness data handling concerns',
    platform: 'ios',
    category: 'Compliance',
    defaultSeverity: 'high',
    guidelineRef: 'Apple Guideline 5.1.3 (Health and HealthKit)',
    signals:
      'Reads/writes HealthKit data, makes medical claims, or shares health data with third parties / advertising.',
    remediation:
      'Limit health data use to user benefit, never use it for advertising, and ensure usage descriptions and privacy policy cover it.',
  },
  {
    id: 'ios-background-modes',
    title: 'Background modes without a qualifying use case',
    platform: 'ios',
    category: 'Configuration',
    defaultSeverity: 'medium',
    guidelineRef: 'Apple Guideline 2.5.4',
    signals:
      'Enables UIBackgroundModes (location, audio, voip, fetch) without a feature that genuinely requires persistent background execution.',
    remediation:
      'Only declare background modes that the app actively uses; remove unused modes that trigger rejection.',
  },
  {
    id: 'android-sensitive-permissions',
    title: 'Sensitive Android permission added',
    platform: 'android',
    category: 'Configuration',
    defaultSeverity: 'high',
    guidelineRef: 'Google Play Permissions and sensitive data policy',
    signals:
      'Adds high-risk permissions in AndroidManifest such as ACCESS_BACKGROUND_LOCATION, READ_SMS, RECEIVE_SMS, QUERY_ALL_PACKAGES, MANAGE_EXTERNAL_STORAGE, or all-files access.',
    remediation:
      'Justify the permission with an approved core use case and Play Console declaration, or use a scoped alternative.',
  },
  {
    id: 'android-foreground-service',
    title: 'Foreground service without declared type / permission',
    platform: 'android',
    category: 'Configuration',
    defaultSeverity: 'medium',
    guidelineRef: 'Google Play Foreground services policy (Android 14+)',
    signals:
      'Declares a foreground service without an android:foregroundServiceType and matching FOREGROUND_SERVICE_* permission, or an unsupported type.',
    remediation:
      'Add the correct foregroundServiceType and FOREGROUND_SERVICE_* permission, and ensure the type is eligible for your use case.',
  },
  {
    id: 'data-safety-collection',
    title: 'New data collection not reflected in data safety / privacy labels',
    platform: 'both',
    category: 'Metadata',
    defaultSeverity: 'medium',
    guidelineRef: 'Google Play Data safety / Apple Privacy nutrition labels',
    signals:
      'Adds analytics, crash, advertising, or location SDKs, or sends new user data to a backend, without updating data safety / privacy declarations.',
    remediation:
      'Update the Play Data safety form and Apple privacy labels to reflect the new collected data types and purposes.',
  },
  {
    id: 'webview-minimum-functionality',
    title: 'WebView wrapper / minimum functionality risk',
    platform: 'both',
    category: 'Code',
    defaultSeverity: 'medium',
    guidelineRef: 'Apple Guideline 4.2 / Google Play minimum functionality',
    signals:
      'Adds a WebView that simply loads a remote website or repackages web content with little native functionality.',
    remediation:
      'Provide native functionality beyond a web wrapper; avoid shipping an app that is only a website in a WebView.',
  },
  {
    id: 'insecure-transport',
    title: 'Insecure network transport / ATS exception',
    platform: 'both',
    category: 'Configuration',
    defaultSeverity: 'medium',
    guidelineRef: 'Apple App Transport Security / Google Play security',
    signals:
      'Sets NSAllowsArbitraryLoads true, adds cleartext HTTP endpoints, or enables usesCleartextTraffic without justification.',
    remediation:
      'Use HTTPS for all endpoints; remove broad ATS exceptions and cleartext traffic, or scope exceptions narrowly.',
  },
  {
    id: 'hardcoded-secrets',
    title: 'Hardcoded secret or API key in source',
    platform: 'both',
    category: 'Code',
    defaultSeverity: 'high',
    guidelineRef: 'Apple Guideline 2.5.2 / general security review',
    signals:
      'Introduces literal API keys, tokens, passwords, or private keys committed in the diff.',
    remediation:
      'Move secrets to secure storage or build-time config; rotate any exposed credentials.',
  },
  {
    id: 'ugc-moderation',
    title: 'User-generated content without moderation controls',
    platform: 'both',
    category: 'Compliance',
    defaultSeverity: 'medium',
    guidelineRef: 'Apple Guideline 1.2 / Google Play UGC policy',
    signals:
      'Adds user-generated content (posts, comments, uploads, chat) without reporting, blocking, or content filtering.',
    remediation:
      'Add a way to report objectionable content, block abusive users, and filter content, plus a published moderation policy.',
  },
  {
    id: 'ios-sign-in-with-apple',
    title: 'Third-party login without Sign in with Apple',
    platform: 'ios',
    category: 'Compliance',
    defaultSeverity: 'medium',
    guidelineRef: 'Apple Guideline 4.8',
    signals:
      'Adds a third-party/social login (Google, Facebook, etc.) as the only or primary option without offering Sign in with Apple or an equivalent privacy-preserving option.',
    remediation:
      'Offer Sign in with Apple (or a qualifying alternative) alongside other third-party login options.',
  },
];

export const serializeRulesForPrompt = (): string =>
  RULES.map(
    (rule) =>
      `- [${rule.id}] (${rule.platform}, ${rule.category}, default severity ${rule.defaultSeverity}) ${rule.title}\n` +
      `  Reference: ${rule.guidelineRef}\n` +
      `  Signals: ${rule.signals}\n` +
      `  Remediation: ${rule.remediation}`,
  ).join('\n');

/**
 * Ids of the methods this service implements (docs/PLATFORM_SPEC.md §17).
 * Keep it in sync with the `@method` TSDoc tags of the implementing functions
 * and with the README section "Methodology & references".
 *
 * The notification service implements no formula of the methodology catalog:
 * the alerts it stores carry the `methodId` of the detector rule that raised
 * them. Its own rules (inbox merge, rule matching, quiet period, delivery
 * retries) are listed under proposed ids that are not yet in
 * docs/references/methods.json; the endpoint lists them without catalog
 * details until they are catalogued.
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  'notify.alert_dedup_merge',
  'notify.alert_rule_matching',
  'notify.rule_quiet_period',
  'notify.delivery_retry_backoff',
];

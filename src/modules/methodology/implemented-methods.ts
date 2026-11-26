/**
 * Ids of the methods this service implements (docs/PLATFORM_SPEC.md §17).
 * Keep it in sync with the `@method` TSDoc tags of the implementing functions
 * and with the README section "Methodology & references".
 *
 * The notification service implements no formula of the methodology catalog:
 * the alerts it stores carry the `methodId` of the detector rule that raised
 * them. Its own rules (inbox merge and lifecycle, rule matching, quiet period,
 * delivery retries, webhook signature, realtime rooms and batching) are the
 * `notify.*` methods of the catalog (domain `notification`, contracts 0.4.0).
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  'notify.alert_dedup_merge',
  'notify.alert_lifecycle',
  'notify.alert_rule_matching',
  'notify.rule_quiet_period',
  'notify.delivery_retry_backoff',
  'notify.webhook_signature',
  'notify.realtime_viewport_rooms',
  'notify.realtime_batching',
];

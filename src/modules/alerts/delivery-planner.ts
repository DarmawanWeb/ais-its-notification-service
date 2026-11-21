import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable } from '@nestjs/common';

import type { Config } from '../../config.js';
import { alertLink } from '../../domain/alert-message.js';
import {
  type AlertFacts,
  isWithinQuietPeriod,
  ruleMatchesAlert,
} from '../../domain/alert-rules.js';
import {
  DeliveriesRepository,
  type Executor,
  type NewDelivery,
} from '../deliveries/deliveries.repository.js';
import type { DeliveryPayload, DeliveryReason } from '../deliveries/delivery.js';
import { AlertRulesRepository } from '../rules/alert-rules.repository.js';
import { type InboxAlert, toRealtimeAlert } from './alert.js';

/** Owners and name of the vessels of an alert (FLEET projection). */
export interface AlertVessels {
  readonly vesselOrgId: string | null;
  readonly relatedVesselOrgId: string | null;
  readonly vesselName: string | null;
}

/**
 * Plans the deliveries of a stored or merged alert, inside the alert's
 * transaction (so an alert is never stored without its deliveries): the
 * enabled rules that may concern its vessels are matched
 * (`ruleMatchesAlert`), rules within their quiet period for this alert are
 * skipped (`isWithinQuietPeriod`), and every channel of every remaining rule
 * gets a `pending` delivery for the delivery worker.
 */
@Injectable()
export class DeliveryPlanner {
  constructor(
    private readonly rules: AlertRulesRepository,
    private readonly deliveries: DeliveriesRepository,
    @InjectConfig() private readonly config: Config,
  ) {}

  /** @returns the number of planned deliveries */
  async plan(
    executor: Executor,
    alert: InboxAlert,
    vessels: AlertVessels,
    reason: DeliveryReason,
    now: Date,
  ): Promise<number> {
    const owners = [vessels.vesselOrgId, vessels.relatedVesselOrgId].filter(
      (orgId): orgId is string => orgId !== null,
    );
    const facts: AlertFacts = {
      type: alert.type,
      domain: alert.domain,
      severity: alert.severity,
      mmsi: alert.mmsi,
      relatedMmsi: alert.relatedMmsi,
      zoneId: alert.zoneId,
      vesselOrgId: vessels.vesselOrgId,
      relatedVesselOrgId: vessels.relatedVesselOrgId,
    };
    const matching = (await this.rules.candidates(executor, owners)).filter((rule) =>
      ruleMatchesAlert(rule, facts),
    );
    if (matching.length === 0) return 0;
    const last = await this.deliveries.lastNotifications(
      executor,
      alert.id,
      matching.map((rule) => rule.id),
    );
    const realtime = toRealtimeAlert(alert);
    const link = alertLink(this.config.PUBLIC_BASE_URL, alert.id);
    const rows: NewDelivery[] = [];
    for (const rule of matching) {
      if (isWithinQuietPeriod(rule.quietMinutes, last.get(rule.id), alert.severity, now)) {
        continue;
      }
      const payload: DeliveryPayload = {
        reason,
        alert: realtime,
        ruleName: rule.name,
        vesselName: vessels.vesselName,
        locale: rule.locale,
        link,
      };
      const seen = new Set<string>();
      for (const channel of rule.channels) {
        const key = `${channel.type}:${channel.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          id: newId(),
          alertId: alert.id,
          ruleId: rule.id,
          channel: channel.type,
          target: channel.target,
          severity: alert.severity,
          payload,
        });
      }
    }
    await this.deliveries.insertMany(executor, rows);
    return rows.length;
  }
}

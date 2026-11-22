import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import { RealtimeAlertSchema } from '@darmawanweb/ais-its-contracts/realtime';
import { UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { describe, expect, it } from 'vitest';

import {
  alertRooms,
  alertScopeOf,
  type InboxAlert,
  newInboxAlert,
  toRealtimeAlert,
} from './alert.js';

const ORG = '0193a3c0-0000-7000-8000-00000000000a';

function user(roles: Role[], orgId: string | null = ORG): UserPrincipal {
  return new UserPrincipal({
    id: '0193a3c0-0000-7000-8000-0000000000aa',
    sessionId: '0193a3c0-0000-7000-8000-0000000000ab',
    orgId,
    roles,
    email: 'user@example.com',
    name: 'User',
  });
}

const RAISED: AlertRaisedV1 = {
  id: '0193a3c0-0000-7000-8000-000000000001',
  type: 'geofence',
  domain: 'surveillance',
  severity: 'warning',
  mmsi: 525005223,
  relatedMmsi: null,
  title: 'Entered Restricted area',
  message: 'Vessel 525005223 entered Restricted area',
  lat: 1.05,
  lon: 104.05,
  occurredAt: '2026-11-21T08:00:00.000Z',
  dedupKey: 'geofence:525005223:0193a3c0-0000-7000-8000-0000000000e1',
  zoneId: '0193a3c0-0000-7000-8000-0000000000e1',
  methodId: 'geo.geofence_enter',
  data: { zoneKind: 'restricted' },
};

describe('alertScopeOf (spec §8.5)', () => {
  it('lets authority and super_admin see every alert', () => {
    expect(alertScopeOf(user(['authority']))).toEqual({ kind: 'all' });
    expect(alertScopeOf(user(['super_admin'], null))).toEqual({ kind: 'all' });
  });

  it('limits other roles to the vessels of their organization', () => {
    for (const role of ['org_admin', 'fleet_manager', 'viewer'] as const) {
      expect(alertScopeOf(user([role]))).toEqual({ kind: 'org', orgId: ORG });
    }
    expect(alertScopeOf(user(['viewer'], null))).toEqual({ kind: 'none' });
  });
});

describe('inbox alerts', () => {
  it('starts an open alert with one occurrence from the first raise', () => {
    expect(newInboxAlert(RAISED, 'surveillance', ORG)).toMatchObject({
      id: RAISED.id,
      orgId: ORG,
      source: 'surveillance',
      status: 'open',
      occurrences: 1,
      occurredAt: new Date(RAISED.occurredAt),
      lastOccurredAt: new Date(RAISED.occurredAt),
    });
  });

  it('pushes the contracts RealtimeAlert shape', () => {
    const stored: InboxAlert = {
      ...newInboxAlert(RAISED, 'surveillance', ORG),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const realtime = toRealtimeAlert(stored);

    expect(RealtimeAlertSchema.parse(realtime)).toEqual(realtime);
    expect(realtime).not.toHaveProperty('dedupKey');
    expect(realtime).not.toHaveProperty('orgId');
  });

  it('goes to the authority room and the owner organizations once each', () => {
    expect(alertRooms([ORG, null, ORG])).toEqual(['authority', `org:${ORG}`]);
    expect(alertRooms([null])).toEqual(['authority']);
  });
});

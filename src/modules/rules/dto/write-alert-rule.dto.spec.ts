import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  CreateAlertRuleDto,
  UpdateAlertRuleDto,
} from './write-alert-rule.dto.js';

/** Validates like the global ValidationPipe (whitelist, forbidNonWhitelisted). */
async function invalidFields(
  type: typeof CreateAlertRuleDto | typeof UpdateAlertRuleDto,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(type, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

const CHANNELS = [{ type: 'email', target: 'ops@example.com' }];

describe('alert rule bodies', () => {
  it.each([
    'name',
    'scope',
    'types',
    'domains',
    'minSeverity',
    'mmsi',
    'zoneIds',
    'channels',
    'locale',
    'quietMinutes',
    'enabled',
  ])('refuses %s: null in a PATCH', async (field) => {
    expect(await invalidFields(UpdateAlertRuleDto, { [field]: null })).toEqual([
      field,
    ]);
  });

  it('accepts a PATCH that omits fields', async () => {
    expect(await invalidFields(UpdateAlertRuleDto, {})).toEqual([]);
    expect(
      await invalidFields(UpdateAlertRuleDto, {
        enabled: false,
        quietMinutes: 5,
      }),
    ).toEqual([]);
  });

  it('refuses null for optional fields of a new rule', async () => {
    expect(
      await invalidFields(CreateAlertRuleDto, {
        name: 'Rule',
        channels: CHANNELS,
        types: null,
        orgId: null,
      }),
    ).toEqual(['types', 'orgId']);
    expect(
      await invalidFields(CreateAlertRuleDto, {
        name: 'Rule',
        channels: CHANNELS,
      }),
    ).toEqual([]);
  });

  it('refuses a change of the organization', async () => {
    expect(
      await invalidFields(UpdateAlertRuleDto, {
        orgId: '0193a3c0-0000-7000-8000-00000000000a',
      }),
    ).toEqual(['orgId']);
  });
});

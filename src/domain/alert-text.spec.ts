import { describe, expect, it } from 'vitest';

import {
  localizableTextOf,
  MESSAGE_KEY_MAX_LENGTH,
  NO_LOCALIZABLE_TEXT,
} from './alert-text.js';

describe('localizableTextOf', () => {
  it('reads a valid key with flat params from the data', () => {
    expect(
      localizableTextOf({
        distanceM: 840,
        messageKey: 'safety.ews.anchored_near_pipeline',
        messageParams: {
          vessel: 'KM Bahari Satu (MMSI 525005223)',
          distanceM: 840,
          predicted: true,
        },
      }),
    ).toEqual({
      messageKey: 'safety.ews.anchored_near_pipeline',
      messageParams: {
        vessel: 'KM Bahari Satu (MMSI 525005223)',
        distanceM: 840,
        predicted: true,
      },
    });
  });

  it('accepts empty params (texts without values)', () => {
    expect(
      localizableTextOf({
        messageKey: 'safety.ews.resolved_safe',
        messageParams: {},
      }),
    ).toEqual({ messageKey: 'safety.ews.resolved_safe', messageParams: {} });
  });

  it.each([
    ['no key (older detectors)', { distanceM: 840 }],
    ['a single segment', { messageKey: 'ews', messageParams: {} }],
    ['upper case', { messageKey: 'Safety.ews.risk', messageParams: {} }],
    ['an empty segment', { messageKey: 'safety..risk', messageParams: {} }],
    ['a non-string key', { messageKey: 42, messageParams: {} }],
    [
      'a key that is too long',
      {
        messageKey: `a.${'b'.repeat(MESSAGE_KEY_MAX_LENGTH)}`,
        messageParams: {},
      },
    ],
    ['missing params', { messageKey: 'safety.ews.risk' }],
    ['null params', { messageKey: 'safety.ews.risk', messageParams: null }],
    ['array params', { messageKey: 'safety.ews.risk', messageParams: [1] }],
    [
      'nested params',
      { messageKey: 'safety.ews.risk', messageParams: { zone: { id: 1 } } },
    ],
    [
      'a null param',
      { messageKey: 'safety.ews.risk', messageParams: { zone: null } },
    ],
    [
      'a non-finite number',
      {
        messageKey: 'safety.ews.risk',
        messageParams: { distanceM: Number.NaN },
      },
    ],
  ])('returns no text for %s', (_case, data) => {
    expect(localizableTextOf(data)).toEqual(NO_LOCALIZABLE_TEXT);
  });

  it('returns no text without data (unresolved alert)', () => {
    expect(localizableTextOf(null)).toEqual(NO_LOCALIZABLE_TEXT);
  });
});

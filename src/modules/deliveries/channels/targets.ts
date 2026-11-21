import { BlockList, isIP } from 'node:net';

import type { NotificationChannel } from '@darmawanweb/ais-its-contracts/domain';
import * as z from 'zod';

/**
 * Addresses a webhook must not reach unless private targets are allowed
 * (SSRF guard): loopback, private, carrier-grade NAT, link-local (cloud
 * metadata endpoints), multicast and reserved ranges (RFC 6890).
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/**
 * `true` for an address a webhook may not reach by default (loopback,
 * private, link-local, …); anything that is not an IP literal counts as
 * blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
    if (mapped?.[1] !== undefined) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(bare, 'ipv6');
  }
  return true;
}

/** Telegram chat ids: numeric ids (groups are negative) or `@channelusername`. */
export const TELEGRAM_CHAT_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** Longest accepted target. */
export const MAX_TARGET_LENGTH = 2_048;

const EmailSchema = z.email();

/** Options of {@link channelTargetIssue}. */
export interface TargetOptions {
  /** `WEBHOOK_ALLOW_PRIVATE_TARGETS`. */
  readonly allowPrivateWebhooks: boolean;
}

/**
 * Checks the target of a channel: an e-mail address, a Telegram chat, or an
 * absolute http(s) webhook URL without credentials whose host is not a
 * loopback / private literal (resolved names are checked again when
 * sending).
 *
 * @returns a problem description, or `null` when the target is valid
 */
export function channelTargetIssue(
  type: NotificationChannel,
  target: string,
  options: TargetOptions,
): string | null {
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) {
    return `target must have 1 to ${MAX_TARGET_LENGTH} characters`;
  }
  switch (type) {
    case 'email':
      return EmailSchema.safeParse(target).success ? null : 'target must be an e-mail address';
    case 'telegram':
      return TELEGRAM_CHAT_PATTERN.test(target)
        ? null
        : 'target must be a Telegram chat id or @channel';
    case 'webhook':
      return webhookIssue(target, options);
  }
}

function webhookIssue(target: string, options: TargetOptions): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'target must be an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'target must be an http(s) URL';
  }
  if (url.username !== '' || url.password !== '') {
    return 'target must not contain credentials';
  }
  if (options.allowPrivateWebhooks) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'target must not be a loopback or private address';
  }
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 && isBlockedAddress(host)) {
    return 'target must not be a loopback or private address';
  }
  return null;
}

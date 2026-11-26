import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable } from '@nestjs/common';

import type { Config } from '../../../config.js';
import {
  DEPLOYMENT_KEY_ID,
  signWebhookPayload,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_KEY_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookSigningKey,
  webhookTimestamp,
} from '../../../domain/webhook-signature.js';
import {
  type ChannelResult,
  failed,
  parseRetryAfter,
} from './channel-result.js';
import { isBlockedAddress } from './targets.js';

/** A webhook host resolved to a blocked (loopback, private, …) address. */
class BlockedTargetError extends Error {
  override readonly name = 'BlockedTargetError';
}

/**
 * DNS lookup that refuses blocked addresses. The connection uses exactly the
 * checked addresses, so a DNS rebinding between check and connect is not
 * possible.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(
    hostname,
    { ...options, all: true },
    (error, addresses: LookupAddress[]) => {
      if (error !== null) {
        callback(error, '', 0);
        return;
      }
      if (
        addresses.length === 0 ||
        addresses.some((entry) => isBlockedAddress(entry.address))
      ) {
        callback(
          Object.assign(
            new BlockedTargetError(`${hostname} resolves to a blocked address`),
            {
              code: 'EBLOCKED',
            },
          ),
          '',
          0,
        );
        return;
      }
      if (options.all === true) {
        // Node's `all: true` form of the callback (happy eyeballs).
        (
          callback as unknown as (
            error: null,
            addresses: LookupAddress[],
          ) => void
        )(null, addresses);
        return;
      }
      const [first] = addresses;
      if (first !== undefined) callback(null, first.address, first.family);
    },
  );
};

/** Outcome of one HTTP exchange. */
interface HttpOutcome {
  readonly status: number;
  readonly retryAfter: string | undefined;
}

/**
 * Webhook channel: `POST` of a JSON body signed with
 * `X-AIS-ITS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`
 * and `X-AIS-ITS-Timestamp` (spec §13.9) with the channel's own key, named
 * by `X-AIS-ITS-Key-Id`, plus `X-AIS-ITS-Delivery` for receiver-side
 * deduplication. Each attempt has a total deadline (`WEBHOOK_TIMEOUT_MS`);
 * redirects are not followed; loopback and private targets are refused
 * unless `WEBHOOK_ALLOW_PRIVATE_TARGETS`.
 */
@Injectable()
export class WebhookChannel {
  constructor(@InjectConfig() private readonly config: Config) {}

  /**
   * Posts `body` signed with `key`: 2xx = `sent`; 408, 429 and 5xx (and
   * network errors) are retried (honouring `Retry-After`); other statuses
   * are permanent.
   *
   * @param key - the channel's key; `undefined` for a channel from before
   *   0.2.0, signed with the deployment secret (`WEBHOOK_SIGNING_SECRET`,
   *   key id `deployment`) — permanently failed while that is unset
   */
  async post(
    url: string,
    body: unknown,
    deliveryId: string,
    key: WebhookSigningKey | undefined,
  ): Promise<ChannelResult> {
    const signing = key ?? this.deploymentKey();
    if (signing === undefined) {
      return failed(
        'The webhook channel has no signing key: rotate its secret (or set WEBHOOK_SIGNING_SECRET)',
        true,
      );
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return failed('Invalid webhook URL', true);
    }
    const allowPrivate = this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    if (!allowPrivate && isBlockedHostLiteral(target.hostname)) {
      return failed('Webhook target is a loopback or private address', true);
    }
    const raw = JSON.stringify(body);
    const timestamp = webhookTimestamp(new Date());
    try {
      const outcome = await this.exchange(
        target,
        raw,
        {
          'content-type': 'application/json',
          'user-agent': `ais-its-notification/${this.config.SERVICE_VERSION}`,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(
            signing.secret,
            timestamp,
            raw,
          ),
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_KEY_ID_HEADER]: signing.id,
          [WEBHOOK_DELIVERY_HEADER]: deliveryId,
        },
        allowPrivate,
      );
      if (outcome.status >= 200 && outcome.status < 300)
        return { outcome: 'sent' };
      const transient =
        outcome.status === 408 ||
        outcome.status === 429 ||
        outcome.status >= 500;
      return failed(
        `Webhook answered HTTP ${outcome.status}`,
        !transient,
        transient ? parseRetryAfter(outcome.retryAfter, new Date()) : undefined,
      );
    } catch (error) {
      if (error instanceof BlockedTargetError)
        return failed(error.message, true);
      const code =
        error instanceof Error && 'code' in error
          ? String(error.code)
          : undefined;
      return failed(
        `Webhook unreachable: ${code ?? (error instanceof Error ? error.message : 'unknown error')}`,
        false,
      );
    }
  }

  /** Whether channels from before 0.2.0 can be signed (`WEBHOOK_SIGNING_SECRET`). */
  hasDeploymentKey(): boolean {
    return this.config.WEBHOOK_SIGNING_SECRET !== undefined;
  }

  /** The deployment secret of channels created before 0.2.0, if configured. */
  private deploymentKey(): WebhookSigningKey | undefined {
    const secret = this.config.WEBHOOK_SIGNING_SECRET;
    return secret === undefined ? undefined : { id: DEPLOYMENT_KEY_ID, secret };
  }

  /**
   * One POST under a total deadline of `WEBHOOK_TIMEOUT_MS` covering DNS,
   * connect, TLS, the request and the response head. The outcome is the
   * status line: the response body is never read (the socket is destroyed
   * at once), so a receiver that answers slowly or drips its body cannot
   * hold the attempt — and with it a worker slot — beyond the deadline.
   */
  private exchange(
    target: URL,
    raw: string,
    headers: Record<string, string>,
    allowPrivate: boolean,
  ): Promise<HttpOutcome> {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<HttpOutcome>((resolve, reject) => {
      const request = send(
        target,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-length': String(Buffer.byteLength(raw)),
          },
          ...(allowPrivate ? {} : { lookup: guardedLookup }),
        },
        (response: IncomingMessage) => {
          clearTimeout(deadline);
          const retryAfter = response.headers['retry-after'];
          resolve({ status: response.statusCode ?? 0, retryAfter });
          response.destroy();
        },
      );
      const deadline = setTimeout(() => {
        request.destroy(
          Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        );
      }, this.config.WEBHOOK_TIMEOUT_MS);
      request.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      request.end(raw);
    });
  }
}

/** A URL host that is a blocked IP literal or `localhost`. */
function isBlockedHostLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return /^[\d.]+$/.test(host) || host.includes(':')
    ? isBlockedAddress(host)
    : false;
}

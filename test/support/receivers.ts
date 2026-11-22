import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import * as z from 'zod';

/** A request received by a local fake server. */
export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** The exact body bytes (signatures are computed over them). */
  readonly rawBody: string;
}

/** A local HTTP server recording requests and answering from a script. */
export interface FakeServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly requests: readonly ReceivedRequest[];
  close(): Promise<void>;
}

/** Answer of a fake server: status and JSON body. */
export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/**
 * Starts a fake HTTP server on 127.0.0.1. `answer` decides the response of
 * the n-th request (0-based); every request is recorded.
 */
export async function startFakeServer(
  answer: (index: number, request: ReceivedRequest) => FakeAnswer,
): Promise<FakeServer> {
  const requests: ReceivedRequest[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void readBody(request).then((rawBody) => {
        const received: ReceivedRequest = {
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          headers: request.headers,
          rawBody,
        };
        const reply = answer(requests.length, received);
        requests.push(received);
        response.writeHead(reply.status, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(reply.body ?? {}));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

/** A `sendMessage` call received by the fake Telegram Bot API. */
export interface TelegramMessage {
  readonly token: string;
  readonly chatId: string;
  readonly text: string;
  readonly parseMode: string | undefined;
}

const SendMessageSchema = z.object({
  chat_id: z.union([z.string(), z.number()]),
  text: z.string(),
  parse_mode: z.string().optional(),
});

/** The `sendMessage` calls among the requests of a fake Telegram API. */
export function telegramMessages(server: FakeServer): TelegramMessage[] {
  return server.requests.flatMap((request) => {
    const match = /^\/bot([^/]+)\/sendMessage$/.exec(request.path);
    const body = SendMessageSchema.safeParse(JSON.parse(request.rawBody));
    if (match?.[1] === undefined || !body.success) return [];
    return [
      {
        token: match[1],
        chatId: String(body.data.chat_id),
        text: body.data.text,
        parseMode: body.data.parse_mode,
      },
    ];
  });
}

/** Telegram Bot API answer to a successful `sendMessage`. */
export const TELEGRAM_OK: FakeAnswer = {
  status: 200,
  body: { ok: true, result: { message_id: 1 } },
};

const MailpitListSchema = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
});

const MailpitMessageSchema = z.object({
  Subject: z.string(),
  From: z.object({ Address: z.string(), Name: z.string() }),
  Text: z.string(),
  HTML: z.string(),
});

/** A message stored by Mailpit. */
export type MailpitMessage = z.output<typeof MailpitMessageSchema>;

/** Reads the Mailpit HTTP API (`/api/v1`). */
export class MailpitClient {
  constructor(private readonly baseUrl: string) {}

  /** Messages to `address`, newest first. */
  async messagesTo(address: string): Promise<MailpitMessage[]> {
    const query = new URLSearchParams({ query: `to:"${address}"` });
    const list = MailpitListSchema.parse(
      await this.get(`/api/v1/search?${query.toString()}`),
    );
    return Promise.all(
      list.messages.map(async (message) =>
        MailpitMessageSchema.parse(
          await this.get(`/api/v1/message/${message.ID}`),
        ),
      ),
    );
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok)
      throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
    return response.json();
  }
}

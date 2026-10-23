import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { IncomingHttpHeaders } from "node:http";

import Client from "../index.ts";
import { getPayload } from "./helpers/get-payload.ts";
import { SmeeServer } from "./helpers/smee-server.ts";
import { VoidLogger } from "./helpers/void-logger.ts";
import { WebhookServer } from "./helpers/webhook-server.ts";

describe("fork body forwarding", () => {
  let smeeServer: SmeeServer;
  let webhookServer: WebhookServer;
  let client: Client;
  let logger: VoidLogger;
  let requests: { body: string; headers: IncomingHttpHeaders }[];

  beforeEach(async () => {
    requests = [];
    logger = new VoidLogger();
    webhookServer = new WebhookServer({
      handler: async (req, res) => {
        requests.push({ body: await getPayload(req), headers: req.headers });
        res.writeHead(200).end();
      },
    });
    smeeServer = new SmeeServer();
    await webhookServer.start();
    await smeeServer.start();
    client = new Client({
      source: smeeServer.channelUrl,
      target: webhookServer.url,
      logger,
    });
    await client.start();
  });

  afterEach(async () => {
    await client.stop();
    await smeeServer.stop();
    await webhookServer.stop();
  });

  test.each([
    {
      body: '{\n  "hello": "世界 🌍", "amount": 1.00\n}\n',
      contentType: "application/json; charset=utf-8",
    },
    {
      body: "payload=hello+world&signature=a%2Bb",
      contentType: "application/x-www-form-urlencoded",
    },
    { body: "Hello 🌍\n", contentType: "text/plain; charset=utf-8" },
    { body: "", contentType: "text/plain" },
  ])("preserves the raw $contentType body", async ({ body, contentType }) => {
    smeeServer.emit(
      {
        body: Buffer.from(body).toString("base64"),
        bodyEncoding: "base64",
        "content-type": contentType,
        "content-length": "9999",
        "x-signature": "original-signature",
      },
      "message",
    );

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].body).toBe(body);
    expect(requests[0].headers["content-type"]).toBe(contentType);
    expect(requests[0].headers["content-length"]).toBe(
      String(Buffer.byteLength(body)),
    );
    expect(requests[0].headers["x-signature"]).toBe("original-signature");
    expect(requests[0].headers).not.toHaveProperty("body");
    expect(requests[0].headers).not.toHaveProperty("bodyencoding");
    expect(logger.errorCalls).toHaveLength(0);
  });

  test.each([
    { body: "e30=" },
    { body: { hello: "world" } },
    { body: "{}", bodyEncoding: "utf8" },
    { body: {}, bodyEncoding: "base64" },
    { body: 123, bodyEncoding: "base64" },
    { bodyEncoding: "base64" },
  ])("rejects incompatible envelope %# and keeps forwarding", async (data) => {
    smeeServer.emit(data, "message");

    await expect.poll(() => logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]).toEqual([
      `[smee] Incompatible server: expected base64-encoded body but received bodyEncoding=${JSON.stringify(data.bodyEncoding)}, body type=${typeof data.body}. Upgrade the smee server.`,
    ]);
    expect(requests).toHaveLength(0);

    smeeServer.emit(
      {
        body: Buffer.from("still forwarding").toString("base64"),
        bodyEncoding: "base64",
        "content-type": "text/plain",
      },
      "message",
    );
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].body).toBe("still forwarding");
    expect(logger.errorCalls).toHaveLength(1);
  });
});

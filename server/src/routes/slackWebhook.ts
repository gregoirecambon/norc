// Slack Events API ingress (POST /webhooks/slack) — thin by design, mirroring
// notionWebhook.ts: challenge echo, signature check, immediate ack, dedup,
// then hand the inner event to the Slack orchestrator out of band. A future
// Socket Mode transport would call the same handleSlackEvent().

import { Router, type Router as ExpressRouter } from 'express';
import { emitLog } from '../lib/logger.js';
import { verifySlackSignature } from '../lib/slack-verify.js';
import { getSlack } from '../lib/slack-integration.js';
import { alreadyProcessed, markProcessed } from '../lib/processed-triggers.js';
import { createSemaphore } from '../lib/semaphore.js';
import { handleSlackEvent, type SlackEventEnvelope } from '../lib/slack-orchestrator.js';

const router: ExpressRouter = Router();

// Bound concurrent event processing (busy channels can burst); ack happens
// before this, so Slack never retries while we queue.
const slackGate = createSemaphore(4);

// POST /webhooks/slack
router.post('/', (req, res) => {
  const body = req.body as Record<string, unknown>;

  // One-time URL verification handshake when saving the Request URL in Slack.
  if (body['type'] === 'url_verification' && typeof body['challenge'] === 'string') {
    res.json({ challenge: body['challenge'] });
    return;
  }

  const { signingSecret } = getSlack();
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!verifySlackSignature(
    rawBody,
    req.header('X-Slack-Request-Timestamp'),
    req.header('X-Slack-Signature'),
    signingSecret,
  )) {
    emitLog(`webhook rejected: ${!signingSecret ? 'no Slack signing secret configured' : 'invalid or missing signature'}`, 'Slack');
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  // Ack within Slack's 3-second window, then process out of band. Slack
  // redelivers on perceived failure (X-Slack-Retry-Num) — the event_id
  // idempotency key below makes redeliveries no-ops.
  res.status(200).send();

  if (body['type'] !== 'event_callback') return;
  const eventId = typeof body['event_id'] === 'string' ? body['event_id'] : null;
  const event = body['event'] as Record<string, unknown> | undefined;
  if (!event || typeof event['type'] !== 'string') return;

  if (eventId) {
    const key = `slack:evt:${eventId}`;
    if (alreadyProcessed(key)) return;
    markProcessed(key);
  }

  const envelope: SlackEventEnvelope = {
    teamId: typeof body['team_id'] === 'string' ? body['team_id'] : null,
    event: event as unknown as SlackEventEnvelope['event'],
  };
  void slackGate.run(() => handleSlackEvent(envelope)).catch(err =>
    emitLog(`slack event error: ${err instanceof Error ? err.message : 'unknown'}`, 'Slack'));
});

export { router as slackWebhookRouter };

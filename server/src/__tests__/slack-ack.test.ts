import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Slack transport so the ack lifecycle is observable without network.
vi.mock('../lib/slack-client.js', () => ({
  addReaction: vi.fn(async () => {}),
  removeReaction: vi.fn(async () => {}),
}));

import { addReaction, removeReaction } from '../lib/slack-client.js';
import { ackReceived, ackResolved, _resetAcks } from '../lib/slack-ack.js';

const add = vi.mocked(addReaction);
const remove = vi.mocked(removeReaction);
const TOKEN = 'xoxb-test';
const PENDING = 'hourglass_flowing_sand';
const DONE = 'white_check_mark';

beforeEach(() => {
  _resetAcks();
  add.mockClear();
  remove.mockClear();
});

describe('slack ack lifecycle', () => {
  it('⏳ on receipt then ✅ on resolve, against the triggering message', async () => {
    ackReceived(TOKEN, 'C1', '111.0001', '111.0001');
    expect(add).toHaveBeenCalledWith(TOKEN, 'C1', '111.0001', PENDING);

    await ackResolved(TOKEN, 'C1', '111.0001');
    expect(remove).toHaveBeenCalledWith(TOKEN, 'C1', '111.0001', PENDING);
    expect(add).toHaveBeenLastCalledWith(TOKEN, 'C1', '111.0001', DONE);
  });

  it('removes the ⏳ only after it has actually landed', async () => {
    let landed: () => void = () => {};
    add.mockImplementationOnce(() => new Promise<void>(r => { landed = r; }));

    ackReceived(TOKEN, 'C1', '222.0001', '222.0001');
    const resolving = ackResolved(TOKEN, 'C1', '222.0001');
    // ⏳ hasn't resolved yet → no removal attempted (would race to a stuck ⏳).
    expect(remove).not.toHaveBeenCalled();

    landed();
    await resolving;
    expect(remove).toHaveBeenCalledWith(TOKEN, 'C1', '222.0001', PENDING);
    expect(add).toHaveBeenLastCalledWith(TOKEN, 'C1', '222.0001', DONE);
  });

  it('keys resolution by thread but reacts on the precise reply ts', async () => {
    // A thread reply: root 333.0001, the reply itself is 333.0009.
    ackReceived(TOKEN, 'C1', '333.0001', '333.0009');
    await ackResolved(TOKEN, 'C1', '333.0001');
    expect(remove).toHaveBeenCalledWith(TOKEN, 'C1', '333.0009', PENDING);
    expect(add).toHaveBeenLastCalledWith(TOKEN, 'C1', '333.0009', DONE);
  });

  it('is a no-op when nothing is pending for the thread', async () => {
    await ackResolved(TOKEN, 'C1', 'nope.0001');
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('does not double-resolve the same thread', async () => {
    ackReceived(TOKEN, 'C1', '444.0001', '444.0001');
    await ackResolved(TOKEN, 'C1', '444.0001');
    add.mockClear();
    remove.mockClear();
    await ackResolved(TOKEN, 'C1', '444.0001');
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('flips a stale ⏳ to ✅ when a new message arrives in the same thread', async () => {
    ackReceived(TOKEN, 'C1', '555.0001', '555.0001');
    add.mockClear();
    // New message in the same thread before the first flipped.
    ackReceived(TOKEN, 'C1', '555.0001', '555.0002');
    await new Promise(r => setTimeout(r, 0)); // drain the async tidy-up
    // The prior message got tidied to ✅, its ⏳ removed...
    expect(remove).toHaveBeenCalledWith(TOKEN, 'C1', '555.0001', PENDING);
    expect(add).toHaveBeenCalledWith(TOKEN, 'C1', '555.0001', DONE);
    // ...and the new one is now the pending ⏳.
    expect(add).toHaveBeenCalledWith(TOKEN, 'C1', '555.0002', PENDING);
  });

  it('skips entirely without a bot token', () => {
    ackReceived('', 'C1', '666.0001', '666.0001');
    expect(add).not.toHaveBeenCalled();
  });
});

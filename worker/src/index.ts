import { loadConfig } from './config.js';
import { Dispatcher } from './dispatch.js';
import { createWorkerServer } from './server.js';
import { resolveIdentity } from './register.js';
import { startSelfUninstall } from './uninstall.js';
import { log } from './log.js';

const config = loadConfig();
const dispatcher = new Dispatcher(config);

// Resolve identity FIRST (load creds / generate secret) so the server starts with
// the right shared secret, then self-register over Tailscale if this is a fresh box.
const { sharedSecret, selfRegistered } = await resolveIdentity(config);

const server = createWorkerServer({
  port: config.port,
  sharedSecret,
  dispatcher,
  onUninstall: () => startSelfUninstall(config),
});
server.listen(config.port, () => {
  log(`listening on :${config.port} (claudeBin=${config.claudeBin}, maxConcurrency=${config.maxConcurrency}, workDir=${config.workDir})`);
  if (selfRegistered) log('self-registered with NORC — should appear connected in the dashboard shortly');
});

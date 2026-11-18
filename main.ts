// The lifecycle of this entry, as the trial environment expects it: take an ephemeral port,
// tell the environment which port it is, then keep polling until the environment says the trial
// is finished and exit 0. The scoring suite talks to the server in app.ts; this file only runs
// the handshake around it, so its behaviour is the harness's contract, not something to invent.
//
//   1. MAKEFUN_ENV_URL is the environment's origin (http://store:8080 inside a trial container).
//      With no URL there is nothing to register with, so the process stops with exit 1 at once.
//   2. Start the server on port 0 and let the kernel choose a free port. Never take 8080: the
//      environment itself listens there.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The environment remembers the address the
//      request came from together with N as this entry's base URL and calls it from then on. The
//      first registration wins; a 409 means another entry registered first, and this process just
//      keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}. The environment answers
//      immediately ({"done": false} while the suite is still running), so this is a poll, not a
//      request held open. A failed or slow poll is retried with a short exponential backoff; the
//      process never leaves before the environment reports done.
//   5. Close the server and exit 0. The harness then stops the environment, which writes the
//      export the scorer reads.
//
// main.ts imports only its own server: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long a single register or done request may run before it is dropped and retried. */
const REQ_TIMEOUT = 30_000;
/** The first pause between retries, and the longest pause. */
const BACKOFF_FIRST = 250;
const BACKOFF_MAX = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pause after `attempt` failed requests: exponential from BACKOFF_FIRST, capped. */
function backoff(attempt: number): number {
  return Math.min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the environment accepts it. 200 is the usual answer; 409 means a first
 * registration already won, which is not this process's problem to fix. 400 and 405 are contract
 * errors and stop the program; a network error or any other status is retried, since the
 * environment may still be starting up.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQ_TIMEOUT),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(backoff(attempt));
  }
}

/** Bind the port, announce it, then wait for the environment: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announcePort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

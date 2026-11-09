// Private line-delimited IPC tool. The Rust controller owns the HTTP interface.
import { createInterface } from 'node:readline';
import { Infra } from './infra.mjs';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const infra = new Infra(process.cwd(), (service, message) => emit({ log: { service, message } }));
await infra.init();
emit({ ready: true, snapshot: infra.snapshot() });
const timer = setInterval(() => emit({ snapshot: infra.snapshot() }), 1000);
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    const { action, data } = request;
    if (action === 'prepare') await infra.prepare(data);
    else if (action === 'start') {
      await infra.prepare(data);
      infra.startOperation(['up', '-d', '--build', '--remove-orphans'], 'Starting stack');
    } else if (action === 'stop') infra.startOperation(['stop'], 'Stopping stack');
    else if (action === 'service') {
      if (!Object.hasOwn(infra.config.resources, data.service) || !['stop', 'start', 'pause', 'unpause', 'restart'].includes(data.action)) throw new Error('Invalid service action.');
      infra.startOperation([data.action, data.service], `${data.action} ${data.service}`);
    } else throw new Error('Unknown infrastructure action');
    emit({ id: request.id, ok: true, snapshot: infra.snapshot() });
  } catch (error) { emit({ id: request?.id, error: error.message, snapshot: infra.snapshot() }); }
}
clearInterval(timer);
clearInterval(infra.timer);
// Docker containers intentionally retain their independent lifecycle.
infra.operation?.kill('SIGTERM');

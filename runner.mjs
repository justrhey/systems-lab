import http from 'node:http';
import { pathToFileURL } from 'node:url';
const [name, file, port, controller] = process.argv.slice(2);
const { default: handler } = await import(pathToFileURL(file));
http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)));
    const ctx = {
      name,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      reply: (status, data) => ({ __labResponse: true, status, data }),
      call: async (target, path = '/', options = {}) => {
        const response = await fetch(`${controller}/network/${name}/${target}${path}`, {
          ...options, headers: { ...headers, ...options.headers },
          body: ['GET', 'HEAD'].includes(options.method || 'GET') ? undefined : options.body,
          signal: AbortSignal.timeout(5000),
        });
        return { __labResponse: true, status: response.status, data: await response.json() };
      },
    };
    const result = await handler({ method: req.method, path: req.url, body, headers: req.headers }, ctx);
    const wrapped = result?.__labResponse === true;
    res.writeHead(wrapped ? result.status : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(wrapped ? result.data : (result ?? null)));
    console.log(`${req.method} ${req.url} → ${res.statusCode}`);
  } catch (error) {
    console.error(error.stack);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}).listen(Number(port), '127.0.0.1', () => console.log(`${name} listening on ${port}`));

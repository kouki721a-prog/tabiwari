/* A stand-in for the Anthropic Messages API: records what the Worker sends and answers with a tool_use we choose. */
import http from 'node:http';
export function startFakeAi(port = 9914) {
  const calls = []; let mode = { status: 200, input: null };
  const server = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
    let body = null; try { body = JSON.parse(Buffer.concat(c).toString()); } catch (e) {}
    calls.push({ url: req.url, headers: req.headers, body });
    if (mode.status !== 200) { res.writeHead(mode.status, { 'Content-Type': 'application/json' }); res.end('{"error":"x"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: mode.input ? [{ type: 'tool_use', id: 't1', name: 'record_expense', input: mode.input }] : [{ type: 'text', text: 'hi' }], stop_reason: 'tool_use' }));
  }); });
  server.listen(port);
  return { base: 'http://localhost:' + port, calls, answer(input) { mode = { status: 200, input }; }, fail(status) { mode = { status, input: null }; }, stop() { server.close(); } };
}

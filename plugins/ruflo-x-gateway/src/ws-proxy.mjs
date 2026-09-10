import WebSocket, { WebSocketServer } from 'ws';
const MAX_CONN = 500; let active = 0;
// Transparent WebSocket proxy: client <-> this gateway <-> Nostr relay.
export function attachWsProxy(server, relayUrl, paths = ['/', '/relay']) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (!paths.includes(path)) { socket.destroy(); return; }
    if (active >= MAX_CONN) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    const up = new WebSocket(relayUrl, { perMessageDeflate: false });
    up.once('open', () => wss.handleUpgrade(req, socket, head, (client) => {
      active++;
      client.on('message', (d) => { if (up.readyState === WebSocket.OPEN) up.send(d.toString()); });
      up.on('message', (d) => { if (client.readyState === WebSocket.OPEN) client.send(d.toString()); });
      const closeBoth = () => { active--; try { client.close(); } catch {} try { up.close(); } catch {} };
      client.once('close', closeBoth); up.once('close', closeBoth);
      client.once('error', closeBoth); up.once('error', closeBoth);
    }));
    up.once('error', () => { socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.destroy(); });
  });
  return wss;
}

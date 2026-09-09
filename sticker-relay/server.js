// Sticker printer WiFi relay
//
// The XB330B (Xprinter 330B-style) label printer sits on your WiFi network,
// but a browser can't open a raw TCP socket to it directly — and Safari/iOS
// has no Web Bluetooth support either. This tiny helper bridges the gap: it
// runs on a PC on the same WiFi network, and any device's browser (phone
// included) can reach it over plain HTTP and hand it a label to print. It
// then opens a raw socket to the printer (default port 9100) and streams
// the TSPL commands.
//
// Run it with Node.js (no install needed, only built-in modules):
//   node server.js
// Optionally choose a different port:
//   PORT=9000 node server.js
//
// Then, on the Label Printer page's "WiFi Sticker Printer" panel, set the
// relay address to whichever LAN address this prints on startup, and the
// printer's own IP address (check the XB330B's network/WLAN settings menu
// or print its self-test/config label to find it).

const http = require('http');
const net = require('net');
const os = require('os');

const PORT = Number(process.env.PORT) || 8787;
const GAP_MM = 2; // gap between die-cut labels; use 0 for continuous/black-mark stock

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

function buildTsplBuffer(job) {
  const { widthMm, heightMm, bytesPerRow, heightPx, rasterBase64, copies } = job;
  if (!widthMm || !heightMm || !bytesPerRow || !heightPx || !rasterBase64) {
    throw new Error('Malformed label job');
  }
  const raster = Buffer.from(rasterBase64, 'base64');
  const header = Buffer.from(
    `SIZE ${widthMm} mm,${heightMm} mm\r\n` +
    `GAP ${GAP_MM} mm,0 mm\r\n` +
    `DIRECTION 1\r\n` +
    `CLS\r\n` +
    `BITMAP 0,0,${bytesPerRow},${heightPx},0,`,
    'ascii'
  );
  const footer = Buffer.from(`\r\nPRINT 1,${Math.max(1, Number(copies) || 1)}\r\n`, 'ascii');
  return Buffer.concat([header, raster, footer]);
}

function sendToPrinter(ip, port, buffers) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to printer at ${ip}:${port}`));
    }, 5000);
    socket.connect(port, ip, () => {
      clearTimeout(timeout);
      for (const buf of buffers) socket.write(buf);
      socket.end();
    });
    socket.on('close', () => resolve());
    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parsePayload(req, rawBody) {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    return JSON.parse(rawBody);
  }
  const params = new URLSearchParams(rawBody);
  const payload = params.get('payload');
  if (!payload) throw new Error('Missing payload field');
  return JSON.parse(payload);
}

function statusPage() {
  const addresses = lanAddresses();
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sticker Printer Relay</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;background:#0b1220;color:#e2e8f0}
code{background:#1e293b;padding:2px 6px;border-radius:4px}
li{margin:4px 0}
</style></head>
<body>
<h2>🖨️ Sticker Printer Relay</h2>
<p>Running on port <code>${PORT}</code>.</p>
<p>On your phone or PC, open the Label Printer page's WiFi Sticker Printer panel and set the <b>relay address</b> to one of:</p>
<ul>${addresses.length ? addresses.map((ip) => `<li><code>${ip}:${PORT}</code></li>`).join('') : '<li>(no LAN address detected — check this PC is on WiFi/ethernet)</li>'}</ul>
<p>Set <b>printer IP</b> to the sticker printer's own WiFi address (check its network/WLAN settings menu), port <code>9100</code> unless changed.</p>
</body></html>`;
}

function resultPage(ok, message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? 'Sent' : 'Print failed'}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 16px;text-align:center;background:#0b1220;color:#e2e8f0}
.icon{font-size:48px}
button{margin-top:24px;padding:10px 20px;border-radius:10px;border:0;background:#38bdf8;color:#0b1220;font-weight:700;font-size:14px}
</style></head>
<body>
<div class="icon">${ok ? '✅' : '⚠️'}</div>
<h2>${ok ? 'Sent to printer' : 'Could not print'}</h2>
<p>${message}</p>
<button onclick="history.back()">← Back</button>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(statusPage());
      return;
    }

    if (req.method === 'POST' && req.url === '/print') {
      const rawBody = await readBody(req);
      const payload = parsePayload(req, rawBody);
      const { printerIp, printerPort, jobs } = payload;
      if (!printerIp || !Array.isArray(jobs) || jobs.length === 0) {
        throw new Error('Missing printer IP or label jobs');
      }
      const buffers = jobs.map(buildTsplBuffer);
      await sendToPrinter(printerIp, Number(printerPort) || 9100, buffers);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(true, `${jobs.length} label${jobs.length === 1 ? '' : 's'} sent to ${printerIp}:${Number(printerPort) || 9100}.`));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(resultPage(false, (err && err.message) || 'Unknown error'));
  }
});

server.listen(PORT, () => {
  console.log(`Sticker printer relay listening on port ${PORT}`);
  const addresses = lanAddresses();
  if (addresses.length === 0) {
    console.log('  (no LAN address detected — connect this PC to WiFi/ethernet)');
  }
  for (const ip of addresses) console.log(`  -> http://${ip}:${PORT}`);
});

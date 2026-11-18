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
//
// USB instead of WiFi: run this on the PC the printer is plugged into, set the
// relay address to localhost:8787 and the printer IP to "usb". Needs a print
// queue named "XPrinter Label" (Generic / Text Only driver) on the printer's
// USB port — override the name with USB_QUEUE=... if yours differs.
//
// ONLINE QUEUE (print from any device, phone included): the Labels page puts
// the job in the Supabase table print_jobs; this helper checks it every two
// seconds, prints what's waiting and marks it done. It proves itself with the
// secret in relay-secret.txt (made on first run; register its hash once — see
// supabase/18_print_queue.sql). Supabase URL + public key come from
// ../.env.local (or SUPABASE_URL / SUPABASE_ANON_KEY).
//
// CENTERING: relay-config.json holds offsetXmm / offsetYmm, applied to every
// single-label job. The XB-370B prints ~1.5 mm right of centre on a 40 mm
// label, so offsetXmm is -1.5 (negative = left / up).

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;

// ── Print position correction ──
const CONFIG_FILE = path.join(__dirname, 'relay-config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
const DOTS_PER_MM = 8; // 203 dpi

// Moves a 1-bit raster (1 = black, MSB first) by dx / dy dots; what slides
// off the edge is dropped. Negative dx = left, negative dy = up.
function shiftRaster(raster, bytesPerRow, heightPx, dx, dy) {
  if (!dx && !dy) return raster;
  const widthPx = bytesPerRow * 8;
  const out = Buffer.alloc(raster.length);
  for (let y = 0; y < heightPx; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= heightPx) continue;
    for (let x = 0; x < widthPx; x++) {
      if (!(raster[y * bytesPerRow + (x >> 3)] & (0x80 >> (x & 7)))) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= widthPx) continue;
      out[ny * bytesPerRow + (nx >> 3)] |= 0x80 >> (nx & 7);
    }
  }
  return out;
}
const GAP_MM = 2; // gap between die-cut labels; use 0 for continuous/black-mark stock

// USB mode: set the printer IP on the Label Printer page to "usb" and the job
// is spooled RAW to this Windows print queue (see raw-print.ps1), which sits
// on the printer's USB port with the "Generic / Text Only" driver.
// The Windows print queue for the USB sticker printer: USB_QUEUE env, else
// relay-config.json "usbQueue", else 'XPrinter Label' (what setup.ps1 makes).
const USB_QUEUE = process.env.USB_QUEUE || readConfig().usbQueue || 'XPrinter Label';

// Is the USB sticker printer plugged in and its queue ready? The queue stays
// even when the cable is out, so we look for the printer's own USB device
// (a USB\ or USBPRINT\ device named after it, e.g. "XprinterXP-330B" — not
// the "XPrinter Label" queue, which is a software device). Checked every 15 s and reported to
// the website so the Labels page can say "printer connected". Override the
// name pattern with relay-config.json "usbDeviceMatch" if yours differs.
const PRINTER_MATCH = readConfig().usbDeviceMatch || 'xprinter|xp-?3[0-9]0';
let printerState = { queueFound: false, connected: false, checkedAt: null };
function checkUsbPrinter() {
  // Queue present? Then is the printer's USB device actually plugged in?
  const ps = `$q = Get-Printer -Name '${USB_QUEUE.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; ` +
             `if (-not $q) { 'missing' } else { ` +
             `$d = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' -and $_.InstanceId -match '^USB' -and $_.FriendlyName -match '${PRINTER_MATCH}' }; ` +
             `if ($d) { 'ready' } else { 'offline' } }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      const s = String(stdout || '').trim();
      printerState = {
        queueFound: s === 'ready' || s === 'offline',
        connected: s === 'ready',
        checkedAt: new Date().toISOString(),
      };
      resolve(printerState);
    });
  });
}

// 2-up rolls: 25 x 25 mm labels come two per row, so pairs of labels are
// stitched side by side into one row-wide bitmap. Offsets are whole bytes
// (8 dots = 1 mm at 203 dpi) so the raster can be copied row by row; they
// were measured off a test print on the XB-370B, whose print origin is the
// printhead's left edge rather than the roll's. shiftDots < 0 moves the print
// up the label (TSPL SHIFT).
const TWO_UP = {
  widthMm: 25, heightMm: 25,
  leftOffsetBytes: 6, rightOffsetBytes: 37, rowBytes: 63,
  gapMm: 3, shiftDots: -32,
};

function expandTwoUp(jobs) {
  const out = [];
  const pending = [];
  for (const job of jobs) {
    if (job.widthMm !== TWO_UP.widthMm || job.heightMm !== TWO_UP.heightMm) { out.push(job); continue; }
    for (let i = 0; i < Math.max(1, Number(job.copies) || 1); i++) pending.push(job);
  }
  for (let i = 0; i < pending.length; i += 2) {
    const left = pending[i];
    const right = pending[i + 1];
    const { bytesPerRow, heightPx } = left;
    const rowBytes = TWO_UP.rowBytes;
    const row = Buffer.alloc(rowBytes * heightPx);
    const leftRaster = Buffer.from(left.rasterBase64, 'base64');
    const rightRaster = right ? Buffer.from(right.rasterBase64, 'base64') : null;
    const rightOffset = TWO_UP.rightOffsetBytes;
    for (let y = 0; y < heightPx; y++) {
      leftRaster.copy(row, y * rowBytes + TWO_UP.leftOffsetBytes, y * bytesPerRow, (y + 1) * bytesPerRow);
      if (rightRaster) rightRaster.copy(row, y * rowBytes + rightOffset, y * bytesPerRow, (y + 1) * bytesPerRow);
    }
    out.push({
      widthMm: rowBytes, // 8 dots per mm at 203 dpi, so bytes == mm
      heightMm: TWO_UP.heightMm,
      bytesPerRow: rowBytes,
      heightPx,
      rasterBase64: row.toString('base64'),
      copies: 1,
      gapMm: TWO_UP.gapMm,
      shiftDots: TWO_UP.shiftDots,
      stitched: true, // positioned by TWO_UP already
    });
  }
  return out;
}

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
  let source = Buffer.from(rasterBase64, 'base64');
  if (!job.stitched) {
    const cfg = readConfig();
    const dx = Math.round((Number(cfg.offsetXmm) || 0) * DOTS_PER_MM);
    const dy = Math.round((Number(cfg.offsetYmm) || 0) * DOTS_PER_MM);
    source = shiftRaster(source, bytesPerRow, heightPx, dx, dy);
  }
  // The page sets bit 1 for black; TSPL BITMAP prints 0 bits as black.
  const raster = source.map((b) => ~b & 0xff);
  const header = Buffer.from(
    `SIZE ${widthMm} mm,${heightMm} mm\r\n` +
    `GAP ${job.gapMm ?? GAP_MM} mm,0 mm\r\n` +
    (job.shiftDots ? `SHIFT ${job.shiftDots}\r\n` : '') +
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

function sendToUsb(buffers) {
  const file = path.join(os.tmpdir(), `sticker-job-${Date.now()}.bin`);
  fs.writeFileSync(file, Buffer.concat(buffers));
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'raw-print.ps1'),
      '-Printer', USB_QUEUE, '-Path', file,
    ], { windowsHide: true }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

// Prints one payload ({ printerIp, printerPort, jobs }) and says where it went.
async function printPayload(payload) {
  const { printerIp, printerPort, jobs } = payload || {};
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('No label jobs');
  const buffers = expandTwoUp(jobs).map(buildTsplBuffer);
  const ip = String(printerIp || 'usb').trim();
  const usb = ip.toLowerCase() === 'usb';
  if (usb) {
    // Don't hand the job to Windows while the printer is unplugged: it would
    // sit in the queue and print by surprise whenever the cable goes back in.
    const st = await checkUsbPrinter();
    if (!st.queueFound) throw new Error(`Print queue "${USB_QUEUE}" not found on the laptop — run setup.ps1 in the sticker-relay folder`);
    if (!st.connected) throw new Error('Sticker printer is not connected to the laptop — plug in its USB cable and print again');
    await sendToUsb(buffers);
  } else await sendToPrinter(ip, Number(printerPort) || 9100, buffers);
  return usb ? `USB printer "${USB_QUEUE}"` : `${ip}:${Number(printerPort) || 9100}`;
}

// ── Online queue ──
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no file */ }
  return out;
}
const envLocal = readEnvFile(path.join(__dirname, '..', '.env.local'));
const SUPABASE_URL = process.env.SUPABASE_URL || envLocal.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || envLocal.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_FILE = path.join(__dirname, 'relay-secret.txt');

function relaySecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) return s;
  } catch { /* first run */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s + '\n');
  return s;
}

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function startQueue() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('Online queue OFF: no Supabase URL/key (.env.local not found).');
    return;
  }
  const secret = relaySecret();
  const hash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  console.log('Online queue ON. Helper id (sha256) for print_relays: ' + hash);

  // Tell the website whether the sticker printer is plugged in (every 15 s,
  // and right away on start), so the Labels page can show it on any device.
  let lastReported = '';
  async function report() {
    const st = await checkUsbPrinter();
    const info = { queue: USB_QUEUE, queueFound: st.queueFound, printerConnected: st.connected, host: os.hostname() };
    try {
      await rpc('relay_report', { p_secret: secret, p_info: info });
      const line = st.connected ? 'Sticker printer connected.' : st.queueFound ? 'Sticker printer NOT connected (plug in the USB cable).' : `Print queue "${USB_QUEUE}" not found — run setup.ps1.`;
      if (line !== lastReported) { console.log(line); lastReported = line; }
    } catch (err) { /* the claim loop logs connection problems */ }
  }
  report();
  setInterval(report, 15000);

  let busy = false;
  let lastError = '';
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const jobs = await rpc('relay_claim_print_jobs', { p_secret: secret });
      if (lastError) { console.log('Online queue reconnected.'); lastError = ''; }
      for (const job of jobs || []) {
        try {
          const target = await printPayload(job.payload);
          await rpc('relay_finish_print_job', { p_secret: secret, p_job_id: job.job_id, p_ok: true, p_message: `Printed on ${target}` });
          console.log(`${new Date().toLocaleTimeString()}  job #${job.job_id}: ${job.label_count} label(s) printed`);
        } catch (err) {
          const msg = (err && err.message) || 'Unknown error';
          console.log(`job #${job.job_id} failed: ${msg}`);
          await rpc('relay_finish_print_job', { p_secret: secret, p_job_id: job.job_id, p_ok: false, p_message: msg }).catch(() => {});
        }
      }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (msg !== lastError) { console.log('Online queue: ' + msg); lastError = msg; }
    } finally {
      busy = false;
    }
  }, 2000);
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
      const { jobs } = payload;
      const target = await printPayload(payload);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage(true, `${jobs.length} label${jobs.length === 1 ? '' : 's'} sent to ${target}.`));
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
  startQueue();
});

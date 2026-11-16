'use client';

import { useState } from 'react';

// ── Web Bluetooth feasibility probe for the sticker printer ──────────────────
// Decides whether the XB-370B (or any label printer) can be driven DIRECTLY
// from the phone's browser — no PC relay, no laptop. That is only possible on
// Android Chrome AND only if the printer exposes a BLE (GATT) service with a
// writable characteristic. iPhone/Safari has no Web Bluetooth at all.
//
// This button lets the user pick the printer from the system chooser, connects
// over GATT, and reports every service + characteristic it finds, flagging any
// that is writable (the channel raw TSPL/ESC bytes would be sent on). If the
// printer never appears in the chooser, its Bluetooth is "Classic" (SPP) and
// browser printing is not possible.

// Candidate serial-over-BLE service UUIDs used by common thermal/label
// printers. Listed so GATT lets us read their characteristics once connected.
const KNOWN_SERVICES: string[] = [
  0x18f0, 0xff00, 0xffe0, 0xfee7, 0xff12, 0xfff0, 0xae30, 0x180a,
].map((n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`)
 .concat([
   '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip transparent UART
   '0000ff00-0000-1000-8000-00805f9b34fb',
 ]);

type Line = { text: string; kind?: 'ok' | 'warn' | 'err' | 'muted' };

interface BluetoothLike {
  requestDevice(opts: unknown): Promise<{
    name?: string | null;
    id?: string;
    gatt?: {
      connect(): Promise<{
        getPrimaryServices(): Promise<Array<{
          uuid: string;
          getCharacteristics(): Promise<Array<{ uuid: string; properties: Record<string, boolean> }>>;
        }>>;
      }>;
      disconnect?(): void;
    };
  }>;
}

export default function BluetoothPrinterTest() {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy]   = useState(false);
  const [done, setDone]   = useState<null | 'ble' | 'none'>(null);

  const log = (text: string, kind?: Line['kind']) => setLines((l) => [...l, { text, kind }]);

  async function run() {
    setLines([]);
    setDone(null);

    const bt = (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;
    if (!bt) {
      log('This browser has no Web Bluetooth.', 'err');
      log('That means an iPhone, or a browser other than Chrome. Use Android Chrome to test.', 'muted');
      return;
    }

    setBusy(true);
    try {
      log('Opening the device chooser… pick your printer (XB-370B / Xprinter).', 'muted');
      const device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: KNOWN_SERVICES });

      log(`Selected: ${device.name || '(unnamed device)'}`, 'ok');
      log('→ It appeared in the chooser, so it advertises BLE. Good sign.', 'ok');

      if (!device.gatt) { log('No GATT server on this device — cannot print over BLE.', 'err'); setDone('none'); return; }

      log('Connecting (GATT)…', 'muted');
      const server = await device.gatt.connect();
      const services = await server.getPrimaryServices();
      log(`Connected. Found ${services.length} service(s).`, 'ok');

      let writable = 0;
      for (const svc of services) {
        log(`• service ${svc.uuid}`, 'muted');
        let chars: Array<{ uuid: string; properties: Record<string, boolean> }> = [];
        try { chars = await svc.getCharacteristics(); } catch { /* some services block enumeration */ }
        for (const c of chars) {
          const props = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join(', ');
          const canWrite = c.properties.write || c.properties.writeWithoutResponse;
          if (canWrite) writable++;
          log(`    ↳ char ${c.uuid} [${props}]`, canWrite ? 'ok' : 'muted');
        }
      }

      try { device.gatt.disconnect?.(); } catch { /* ignore */ }

      if (writable > 0) {
        log(`✅ Found ${writable} writable characteristic(s) — this printer CAN be printed to directly from Android. Send me this report.`, 'ok');
        setDone('ble');
      } else {
        log('⚠️ Connected, but no writable characteristic was found. Send me this report so I can check.', 'warn');
        setDone('none');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancelled|User cancelled|chooser/i.test(msg)) {
        log('Chooser closed. If your printer was NOT in the list, its Bluetooth is "Classic" (not BLE) — browser printing is not possible.', 'warn');
        setDone('none');
      } else {
        log(`Error: ${msg}`, 'err');
      }
    } finally {
      setBusy(false);
    }
  }

  const color = (k?: Line['kind']) =>
    k === 'ok' ? 'text-success' : k === 'warn' ? 'text-gold' : k === 'err' ? 'text-danger' : 'text-muted';

  return (
    <div className="mb-4 rounded-xl border border-white/8 bg-surface2 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12px] font-bold text-slate-100">🔵 Bluetooth test (Android)</span>
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold border border-teal/40 bg-teal/10 text-teal disabled:opacity-50"
        >
          {busy ? 'Scanning…' : 'Test Bluetooth printer'}
        </button>
      </div>
      <p className="text-[10px] text-muted mb-2 leading-relaxed">
        Checks whether this printer can be printed to directly from an Android phone — no PC/relay.
        Run it on Android Chrome with the printer powered on.
      </p>
      {lines.length > 0 && (
        <div className="rounded-lg bg-navy/60 border border-white/6 p-2 max-h-56 overflow-y-auto font-mono text-[10px] leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className={color(l.kind)}>{l.text}</div>
          ))}
        </div>
      )}
      {done === 'ble' && (
        <p className="text-[10px] text-success mt-2">Result: BLE-capable. Tell me and I&apos;ll build direct Android printing.</p>
      )}
      {done === 'none' && (
        <p className="text-[10px] text-gold mt-2">Result: no usable BLE write channel found — likely Classic Bluetooth.</p>
      )}
    </div>
  );
}

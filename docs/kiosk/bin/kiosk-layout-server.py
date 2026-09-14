#!/usr/bin/env python3
"""Byt-knappens modtager på køkkenskærmen.

Lytter KUN på 127.0.0.1, så den er usynlig for resten af netværket. Knappen i
Bon og Whiteboard spørger her først — svarer ingen, vises knappen ikke. Derfor
findes byt-knappen kun på Pi'en.

  GET  /layout        → {"primary": "bon" | "whiteboard"}
  POST /layout/swap   → bytter, skriver labwc-reglerne om og genstarter begge
                        vinduer (kiosk-chromium.sh starter dem igen på ~5 sek.)

Kun Bons og Whiteboards egne adresser (fra kiosk.env) må kalde den.
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kiosk_layout  # noqa: E402

PORT = int(os.environ.get('KIOSK_LAYOUT_PORT', '8765'))
RC = Path(os.environ.get('KIOSK_LABWC_RC') or Path.home() / '.config' / 'labwc' / 'rc.xml')
_swap_lock = threading.Lock()


def _restart_windows():
    subprocess.run(['pkill', '-HUP', '-x', 'labwc'], check=False)
    for cls in ('bon-kiosk-main', 'bon-kiosk-side'):
        subprocess.run(['pkill', '-f', '--', f'--class={cls}'], check=False)


class Handler(BaseHTTPRequestHandler):
    server_version = 'bon-kiosk-layout'

    def _cors(self):
        origin = self.headers.get('Origin', '')
        if origin in kiosk_layout.allowed_origins():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            # Chromiums "Private Network Access": en https-side der kalder
            # 127.0.0.1 skal have lov af modtageren i preflight-svaret.
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        return origin in kiosk_layout.allowed_origins()

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path.split('?')[0] != '/layout':
            return self._json(404, {'error': 'ukendt'})
        self._json(200, {'primary': kiosk_layout.read_primary()})

    def do_POST(self):
        if self.path.split('?')[0] != '/layout/swap':
            return self._json(404, {'error': 'ukendt'})
        # Et POST fra en fremmed side må aldrig kunne genstarte kiosken.
        if self.headers.get('Origin', '') not in kiosk_layout.allowed_origins():
            return self._json(403, {'error': 'ikke tilladt'})
        if not _swap_lock.acquire(blocking=False):
            return self._json(409, {'error': 'bytter allerede'})
        try:
            new = 'whiteboard' if kiosk_layout.read_primary() == 'bon' else 'bon'
            kiosk_layout.write_rules(RC, new)
            kiosk_layout.write_primary(new)
        except Exception as exc:  # svar ærligt i stedet for at lade som om
            _swap_lock.release()
            return self._json(500, {'error': str(exc)})
        self._json(200, {'primary': new, 'restarting': True})
        # Svar først — det er et af de vinduer vi genstarter, der spurgte.
        def later():
            try:
                _restart_windows()
            finally:
                threading.Timer(8, _swap_lock.release).start()
        threading.Timer(0.4, later).start()

    def log_message(self, fmt, *args):
        sys.stderr.write('[kiosk-layout] ' + (fmt % args) + '\n')


if __name__ == '__main__':
    print(f'[kiosk-layout] lytter på 127.0.0.1:{PORT} · stor: {kiosk_layout.read_primary()}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()

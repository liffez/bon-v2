"""Fælles regler for den opdelte kioskskærm (Bon + Whiteboard).

Bruges af både installeren og byt-knappens lille server, så de to aldrig kan
være uenige om hvor et vindue skal stå.

Konfigurationen kommer fra kiosk.env (miljøvariabler). Hvilken app der har den
store del ("primary") står i ~/.config/bon-kiosk/primary: "bon" eller "whiteboard".

Kør som script:  python3 kiosk_layout.py rules <rc.xml> [bon|whiteboard]
"""
import os
import pathlib
import re
import sys
from urllib.parse import urlsplit

STATE_FILE = pathlib.Path.home() / '.config' / 'bon-kiosk' / 'primary'
APPS = ('bon', 'whiteboard')
START, END = '<!-- bon-v2 kiosk: start -->', '<!-- bon-v2 kiosk: slut -->'


def _env(name, default=''):
    return os.environ.get(name, default) or default


def geometry():
    """(stor bredde, lille bredde, højde) i fysiske pixels."""
    w = int(_env('KIOSK_SCREEN_WIDTH', '1920'))
    h = int(_env('KIOSK_SCREEN_HEIGHT', '1080'))
    frac = _env('KIOSK_MAIN_FRACTION', '2/3')
    try:
        num, den = (int(x) for x in frac.split('/'))
        if den <= 0:
            raise ValueError
    except ValueError:
        num, den = 2, 3
    big = w * num // den
    return big, w - big, h


def host(url):
    return urlsplit(url).hostname or ''


def origin(url):
    parts = urlsplit(url)
    return f'{parts.scheme}://{parts.netloc}' if parts.scheme and parts.netloc else ''


def identifiers():
    """labwc-identifiers pr. app.

    Chromium på Wayland ignorerer --class: et --app-vindue hedder
    "chrome-<vært>__<sti>-<profil>" (målt på Pi'en 14/9-2026). Den gamle
    --class står med, så XWayland/X11 også rammes. Nødsiden hører til Bon.
    """
    return {
        'bon': [f"chrome-{host(_env('KIOSK_URL'))}__*", 'chrome-*offline.html*', 'bon-kiosk-main'],
        'whiteboard': [f"chrome-{host(_env('KIOSK_SIDE_URL'))}__*", 'bon-kiosk-side'],
    }


def allowed_origins():
    return {o for o in (origin(_env('KIOSK_URL')), origin(_env('KIOSK_SIDE_URL'))) if o}


def read_primary():
    try:
        value = STATE_FILE.read_text().strip()
    except OSError:
        return 'bon'
    return value if value in APPS else 'bon'


def write_primary(value):
    if value not in APPS:
        raise ValueError(value)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix('.tmp')
    tmp.write_text(value + '\n')
    tmp.replace(STATE_FILE)


def rules_block(primary):
    big, small, h = geometry()
    ids = identifiers()
    other = 'whiteboard' if primary == 'bon' else 'bon'
    lines = [START, '  <windowRules>']
    for app, x, w in ((primary, 0, big), (other, big, small)):
        for ident in ids[app]:
            lines.append(f'    <windowRule identifier="{ident}" serverDecoration="no" skipTaskbar="yes" skipWindowSwitcher="yes" />')
            lines.append(f'    <windowRule identifier="{ident}">')
            lines.append(f'      <action name="MoveTo" x="{x}" y="0" />')
            lines.append(f'      <action name="ResizeTo" width="{w}" height="{h}" />')
            lines.append('    </windowRule>')
    lines.append('  </windowRules>')
    lines.append('  ' + END)
    return '\n'.join(lines)


def write_rules(rc_path, primary):
    """Skriv (eller erstat) vores blok i rc.xml. Idempotent."""
    p = pathlib.Path(rc_path)
    s = p.read_text()
    s = re.sub(r'[ \t]*' + re.escape(START) + r'.*?' + re.escape(END) + r'[ \t]*\n?', '', s, flags=re.S)
    idx = -1
    for root in ('</labwc_config>', '</openbox_config>'):
        idx = s.rfind(root)
        if idx != -1:
            break
    if idx == -1:
        raise SystemExit('rc.xml har hverken </labwc_config> eller </openbox_config> — rører den ikke')
    s = s[:idx] + '  ' + rules_block(primary) + '\n' + s[idx:]
    tmp = p.with_suffix('.xml.tmp')
    tmp.write_text(s)
    tmp.replace(p)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'rules':
        primary = sys.argv[3] if len(sys.argv) > 3 else read_primary()
        if '<windowRules>' in re.sub(re.escape(START) + r'.*?' + re.escape(END), '',
                                     pathlib.Path(sys.argv[2]).read_text(), flags=re.S):
            print('  ! rc.xml har allerede egne <windowRules> — vores blok lægges ved siden af.')
        write_rules(sys.argv[2], primary)
        ids = identifiers()
        print(f'  → {sys.argv[2]} (stor: {primary}; Bon = {ids["bon"][0]}, Whiteboard = {ids["whiteboard"][0]})')
    else:
        sys.exit(__doc__)

#!/usr/bin/env python3
"""Sort skærm efter lukketid — forsvinder ved berøring.

iiyama ProLite T2752MSC slukker sin berøringsskærm når panelet går i standby
(målt på Pi'en 14/9-2026: ingen TOUCH_DOWN mens panelet er slukket). Et
slukket panel kan derfor ikke vækkes med et tryk. I stedet lægges et sort
vindue i fuld skærm over Bon og Whiteboard: berøringen virker hele tiden, og
et helt sort billede brænder ikke ind.

Lukker ved slip (ikke ved tryk), så trykket ikke falder igennem til siden
nedenunder. Kører kun i ét eksemplar (kiosk-display.sh sørger for det).
"""
import os
import signal
import subprocess
import sys
import warnings

os.environ.setdefault('GDK_BACKEND', 'wayland')
# override_background_color er forældet i GTK 3, men virker og er det simpleste.
warnings.filterwarnings('ignore', category=DeprecationWarning)

import gi  # noqa: E402
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

PROG = 'bon-kiosk-blank'


def main():
    GLib.set_prgname(PROG)          # bliver til app_id på Wayland
    win = Gtk.Window(title='Bon kiosk — tryk for at tænde')
    win.set_decorated(False)
    win.set_keep_above(True)
    win.override_background_color(Gtk.StateFlags.NORMAL, Gdk.RGBA(0, 0, 0, 1))
    win.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK
                   | Gdk.EventMask.TOUCH_MASK | Gdk.EventMask.KEY_PRESS_MASK)

    def close(*_):
        Gtk.main_quit()
        return True

    def on_touch(_w, event):
        if event.type in (Gdk.EventType.TOUCH_END, Gdk.EventType.TOUCH_CANCEL):
            close()
        return True                 # sluk hele sekvensen — intet falder igennem

    win.connect('button-release-event', close)
    win.connect('touch-event', on_touch)
    win.connect('key-press-event', close)
    win.connect('delete-event', close)

    def hide_cursor(w):
        gw = w.get_window()
        if gw:
            gw.set_cursor(Gdk.Cursor.new_from_name(gw.get_display(), 'none'))
    win.connect('realize', hide_cursor)

    win.fullscreen()
    win.show_all()
    win.present()

    # kiosk-display.sh on (kl. 06:30) sender SIGTERM.
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, close)
    try:
        Gtk.main()
    finally:
        # Lysstyrken blev skruet ned da vinduet kom op — sæt den tilbage.
        display_sh = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'kiosk-display.sh')
        subprocess.run([display_sh, 'restore'], check=False)
    return 0


if __name__ == '__main__':
    sys.exit(main())

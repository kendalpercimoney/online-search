# Static server for the web app (web/) during development. Like `python3 -m http.server`,
# but tells the browser to revalidate every file so edits show up on a normal reload.
import functools
import http.server
import os
import sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
handler = functools.partial(NoCacheHandler, directory=web)
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()

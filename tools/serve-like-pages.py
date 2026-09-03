"""Serve the site the way GitHub Pages does.

Pages resolves /foo to foo.html BEFORE foo/index.html — that ordering is not a
detail, it is what broke sign-in on this project once, and python's own
http.server does not do it at all. Testing a redirect to a clean URL against a
plain static server measures the server, not the site.
"""
import http.server, functools, os, sys
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = super().translate_path(path)
        if not os.path.exists(p) and not p.endswith(".html"):
            cand = p.rstrip("/") + ".html"
            if os.path.exists(cand):
                return cand
        return p
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer.allow_reuse_address = True
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])),
    functools.partial(H, directory=sys.argv[2])).serve_forever()

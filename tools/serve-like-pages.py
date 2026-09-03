"""Serve the site the way GitHub Pages does.

Pages resolves /foo to foo.html BEFORE foo/index.html — that ordering is not a
detail, it is what broke sign-in on this project once, and python's own
http.server does not do it at all. Testing a redirect to a clean URL against a
plain static server measures the server, not the site.
"""
import http.server, functools, os, sys
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Strip the query and fragment before resolving. SimpleHTTPRequestHandler
        # already does this for a path that exists, but the /foo -> foo.html
        # fallback below was seeing "read?s=44" as a filename and 404ing, which
        # made a working page look broken for a whole agent run. Pages resolves
        # the path and hands the query to the page; so does this now.
        path = path.split("?", 1)[0].split("#", 1)[0]
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

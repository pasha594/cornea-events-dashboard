#!/usr/bin/env python3
"""Private copy of the dashboard, run on Cloud Run behind IAP.

- /private/whoami, /private/users and /private/users/<uid> answer from the admin
  API, called as this service's own identity (it runs as fire-api-prod-admin-api,
  the account the admin API's IAP accepts). Nothing is stored.
- Every other GET is fetched from the public GitHub Pages site and passed through,
  so dashboard changes show up here without redeploying.

IAP in front of this service decides who may open it; this code never sees a
request IAP has not already let through.

Standard library only. For a local test, set IMPERSONATE to the service account
so tokens come from your own `gcloud` login instead of the metadata server.
"""

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PUBLIC_SITE = os.environ.get("PUBLIC_SITE", "https://pasha594.github.io/cornea-events-dashboard/")
ADMIN_API = os.environ.get("ADMIN_API", "https://fire-api-prod-admin-2ydhqyokxa-uc.a.run.app")
SCOPES = "openid,https://www.googleapis.com/auth/userinfo.email"
METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=" + SCOPES
)
IMPERSONATE = os.environ.get("IMPERSONATE")  # local testing only
STATIC_TOKEN = os.environ.get("ADMIN_TOKEN")  # local testing against a stand-in API only


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """IAP answers a bad token with a redirect to Google sign-in; surface it as an error."""

    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)

_token = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()
_admin_lock = threading.Lock()  # the admin API serves only a few requests at a time; send ours one by one


def access_token(force=False):
    with _token_lock:
        if not force and _token["value"] and time.time() < _token["expires"] - 120:
            return _token["value"]
        if STATIC_TOKEN:
            return STATIC_TOKEN
        if IMPERSONATE:
            value = subprocess.run(
                ["gcloud", "auth", "print-access-token", f"--impersonate-service-account={IMPERSONATE}", f"--scopes={SCOPES}"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            expires_in = 3000
        else:
            request = urllib.request.Request(METADATA_TOKEN_URL, headers={"Metadata-Flavor": "Google"})
            with urllib.request.urlopen(request, timeout=10) as response:
                data = json.load(response)
            value, expires_in = data["access_token"], data.get("expires_in", 3000)
        _token.update(value=value, expires=time.time() + expires_in)
        return value


def admin_get(path, query=None):
    url = ADMIN_API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    for attempt in (1, 2):
        try:
            token = access_token(force=attempt == 2)
        except Exception as error:  # metadata server or gcloud unavailable
            return 502, json.dumps({"detail": f"Could not get a token for the admin API: {error}"}).encode(), {}
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        try:
            with _admin_lock, opener.open(request, timeout=60) as response:
                return response.status, response.read(), {}
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 401) and attempt == 1:
                continue  # token expired or was refused: mint a fresh one once
            extra = {"Retry-After": error.headers.get("Retry-After")} if error.code == 429 else {}
            body = error.read() if error.code not in (301, 302) else b""
            if not body.lstrip().startswith((b"{", b"[")):
                body = json.dumps({"detail": f"Admin API answered {error.code}"}).encode()
            return (502 if error.code in (301, 302) else error.code), body, extra
        except (urllib.error.URLError, TimeoutError) as error:
            return 502, json.dumps({"detail": f"Admin API unreachable: {error}"}).encode(), {}


def public_get(path, query):
    url = urllib.parse.urljoin(PUBLIC_SITE, path.lstrip("/")) + ("?" + query if query else "")
    request = urllib.request.Request(url, headers={"User-Agent": "cornea-events-dashboard-private"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "application/octet-stream")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("Content-Type", "text/plain")
    except (urllib.error.URLError, TimeoutError):
        return 502, b"Public site unreachable", "text/plain"


class Handler(BaseHTTPRequestHandler):
    server_version = "dashboard-private"

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        path, params = parts.path, urllib.parse.parse_qs(parts.query)

        if path == "/private/whoami":
            email = self.headers.get("X-Goog-Authenticated-User-Email", "").split(":", 1)[-1]
            return self.reply(200, json.dumps({"email": email or None}).encode(), "application/json", private=True)

        if path == "/private/users":
            query = {}
            for key, limit in (("q", 200), ("page", 2000)):
                value = (params.get(key) or [""])[0]
                if len(value) > limit:
                    return self.reply(400, b'{"detail":"Parameter too long"}', "application/json", private=True)
                if value:
                    query[key] = value
            status, body, extra = admin_get("/api/users", query)
            return self.reply(status, body, "application/json", extra, private=True)

        if path.startswith("/private/users/"):
            uid = urllib.parse.unquote(path[len("/private/users/"):])
            if not uid or len(uid) > 128 or "/" in uid:
                return self.reply(400, b'{"detail":"Bad uid"}', "application/json", private=True)
            status, body, extra = admin_get("/api/users/" + urllib.parse.quote(uid, safe=""))
            return self.reply(status, body, "application/json", extra, private=True)

        if path.startswith("/private/") or ".." in path:
            return self.reply(404, b'{"detail":"Not found"}', "application/json", private=True)

        status, body, content_type = public_get(path, parts.query)
        self.reply(status, body, content_type)

    def reply(self, status, body, content_type, extra=None, private=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if private else "no-cache")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_header("Referrer-Policy", "same-origin")
        for key, value in (extra or {}).items():
            if value:
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Log the path only: a users search query can contain an email address.
        print(f"{self.command} {urllib.parse.urlsplit(self.path).path} -> {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"Serving on :{port}, proxying {PUBLIC_SITE}", flush=True)
    ThreadingHTTPServer(("", port), Handler).serve_forever()

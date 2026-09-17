"""
RE Report Assistant — Desktop Application

A native Windows wrapper around the cloud web app.
Opens the Railway-hosted React app in a fullscreen native window.
Auto-saves a Word .docx to a local work folder when a report is submitted.

Architecture:
  - PyWebView opens a native Edge WebView2 window pointing to the Railway URL
  - A Python-JS bridge (Api class) is exposed as window.pywebview.api
  - When the frontend calls window.pywebview.api.auto_save_word(id, date),
    Python downloads the .docx from the Railway API and saves it locally
  - Config (work folder path + saved report IDs) stored in
    %APPDATA%/RE Report Assistant/config.json

DATA SAFETY:
  - This app NEVER writes to the cloud database. It only READS.
  - The auto_save_word function downloads a READ-ONLY copy of the Word doc.
  - De-duplication: each report ID is tracked in config. If the same report
    is submitted multiple times, only the FIRST submission triggers a download.
  - No file overwriting: if a file already exists (edge case), a counter
    suffix is added (e.g. DailyReport_2026-07-19 (1).docx).
"""

import os
import re
import sys
import json
import socket
import logging
import threading
import functools
import http.server
import webview
import httpx
from urllib.parse import unquote

# --- Logging ---
LOG_DIR = os.path.join(
    os.environ.get('APPDATA', os.path.expanduser('~')),
    'RE Report Assistant'
)
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "desktop.log")),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("desktop")

# --- Constants ---
RAILWAY_URL = "https://residentengineerassistant-production.up.railway.app"
CONFIG_DIR = os.path.join(
    os.environ.get('APPDATA', os.path.expanduser('~')),
    'RE Report Assistant'
)
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')


class _SpaHandler(http.server.SimpleHTTPRequestHandler):
    """
    Serves the bundled front end, and serves index.html for anything it does
    not recognise.

    WHY THE FALLBACK: the app routes on the client with real paths (/report/42).
    A plain file server 404s those, so the app works until the moment someone
    refreshes, which is the worst possible time to find out.
    """

    def log_message(self, fmt, *args):
        logger.debug("[web] " + fmt, *args)

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not self.path.startswith('/assets/'):
            self.path = '/index.html'
        return super().send_head()


def _bundled_web_root():
    """
    Where the built front end lives, frozen or not.

    PyInstaller unpacks data to _MEIPASS when frozen; running from source it is
    simply the sibling of this file. Returns None when there is no bundle,
    which is what makes the cloud fallback below possible.
    """
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    root = os.path.join(base, 'web')
    return root if os.path.isfile(os.path.join(root, 'index.html')) else None


# The port the bundled front end is served on, and why it is not just "any
# free port".
#
# The browser keys localStorage by ORIGIN, and the port is part of the origin.
# Asking the OS for a free port gave a different one every launch
# (51314, then 56554, then 61467), so every launch was a brand new origin with
# an empty localStorage - no signed-in token. The app then failed its first
# save with 401 and showed "Save failed", which is what sent Terry looking.
#
# A fixed port makes the origin the same every time, so the session survives a
# restart. The alternates are for the rare case where something else already
# holds the first one; they are tried in order so the origin is at least
# predictable rather than random.
STABLE_PORTS = (17851, 17852, 17853, 17854)


def _serve(root):
    """
    Start a local server for `root` on a stable port. Returns its URL.

    Falls back to any free port only if every stable port is taken - the app
    still works, but the sign-in will not carry over from the last launch, so
    that case is logged as a warning rather than passing silently.
    """
    handler = functools.partial(_SpaHandler, directory=root)

    for port in STABLE_PORTS:
        try:
            httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
        except OSError as exc:
            logger.info("Port %d is taken (%s) - trying the next one", port, exc)
            continue
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        logger.info("Serving bundled front end from %s on port %d", root, port)
        return f'http://127.0.0.1:{port}'

    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    logger.warning(
        "Every stable port was taken - serving on %d instead. The sign-in from "
        "the last launch will not be recognised on this one.", port,
    )
    return f'http://127.0.0.1:{port}'


class Api:
    """
    Python-JS bridge exposed to the frontend as window.pywebview.api.

    Methods:
      - auto_save_word(report_id, report_date) — called by frontend on submit
      - pick_work_folder() — opens native folder picker, saves to config
      - get_work_folder() — returns the current work folder path
      - set_work_folder() — alias for pick_work_folder
    """

    def _load_config(self) -> dict:
        """Load config from disk. Returns empty dict if no config file exists."""
        os.makedirs(CONFIG_DIR, exist_ok=True)
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError) as exc:
                logger.warning(f"Failed to read config: {exc}")
        return {}

    def _save_config(self, config: dict) -> None:
        """Save config to disk."""
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        logger.info(f"Config saved: {config}")

    @staticmethod
    def _filename_from_response(response, report_date: str) -> str:
        """
        Pull the filename out of Content-Disposition, falling back to the old
        pattern if the header is missing or unreadable.

        Keeping one source of truth for the name means the work-folder copy, the
        browser download and the backfill export always agree.
        """
        disposition = response.headers.get("content-disposition", "")
        match = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', disposition, re.IGNORECASE)
        if match:
            name = unquote(match.group(1).strip())
            # Never let a server value escape the work folder.
            name = os.path.basename(name)
            if name.lower().endswith(".docx"):
                return name
        logger.warning("No usable filename in Content-Disposition — using fallback")
        return f"DailyReport_{report_date}.docx"

    def auto_save_word(self, report_id: str, report_date: str,
                       auth_token: str = "") -> dict:
        """
        Download the Word .docx for a submitted report and save it
        to the configured work folder on the local hard drive.

        Called automatically by the frontend JS bridge when a report
        is submitted.

        DE-DUPLICATION: Each report_id is tracked in config. If the same
        report is submitted again (e.g. user clicks Submit twice), this
        function returns early without downloading or saving anything.
        This prevents duplicate Word files.

        Args:
            report_id: The UUID of the submitted report.
            report_date: The report date string (e.g. "2026-07-19").
            auth_token: The signed-in user's bearer token, handed over by the
                page. Reports are per-user now, so the export endpoint refuses
                an unauthenticated request. Defaults to empty so an older
                frontend bundle still calls this without a TypeError — it will
                get a clear "not signed in" error instead of a crash.

        Returns:
            dict with 'success' (bool), 'path' or 'error' (str),
            and optionally 'skipped' (bool) if already saved.
        """
        logger.info(f"auto_save_word called: report_id={report_id}, date={report_date}")

        config = self._load_config()

        # --- DE-DUPLICATION CHECK ---
        # Prevent saving the same report multiple times
        saved_report_ids = config.get('saved_report_ids', [])
        if report_id in saved_report_ids:
            logger.info(f"Report {report_id} was already auto-saved — skipping to prevent duplicate")
            return {
                'success': True,
                'skipped': True,
                'error': 'Already saved — no duplicate created',
            }

        # --- WORK FOLDER CHECK ---
        work_folder = config.get('work_folder')

        # If no work folder configured, prompt user to pick one
        if not work_folder or not os.path.isdir(work_folder):
            logger.info("No work folder configured — prompting user")
            work_folder = self.pick_work_folder()
            if not work_folder:
                logger.warning("User cancelled folder selection")
                return {
                    'success': False,
                    'error': 'No work folder selected. Please set one and try again.',
                }

        try:
            # --- DOWNLOAD WORD FILE FROM RAILWAY CLOUD ---
            # This is a READ-ONLY operation. It calls GET /api/export/{id}/word
            # which generates a .docx from the report data without modifying anything.
            url = f"{RAILWAY_URL}/api/export/{report_id}/word"
            logger.info(f"Downloading Word file from: {url}")

            # The export endpoint requires a signed-in user now that reports are
            # per-user — without the token the server cannot tell whose report
            # this is, and would have no safe answer even if it could.
            #
            # The token comes from the page rather than being stored here: the
            # webview is already signed in, and keeping a second copy of a
            # credential on disk to go stale is worse than passing the live one
            # across the bridge that already exists.
            headers = {}
            if auth_token:
                headers['Authorization'] = f'Bearer {auth_token}'
            else:
                logger.warning("No auth token supplied — the download will be refused")

            response = httpx.get(url, timeout=60.0, follow_redirects=True, headers=headers)
            if response.status_code in (401, 403):
                logger.error(f"Word download refused ({response.status_code}) — not signed in")
                return {
                    'success': False,
                    'error': 'Not signed in. Sign in again in the app and re-submit.',
                }
            response.raise_for_status()

            # --- SAVE TO DISK ---
            # Take the filename from the server's Content-Disposition rather
            # than building one here. The backend owns the naming convention
            # ("Morena Conveyance North - Daily-TW-MM-DD-YYYY.docx", matching the
            # existing reports in Daily Reports/), and it is configurable in
            # Settings. Building it independently here is exactly how the
            # work-folder copy ended up named differently from the browser
            # download and the backfill export.
            filename = self._filename_from_response(response, report_date)
            filepath = os.path.join(work_folder, filename)

            # Safety: if file already exists, add a counter suffix
            # This should almost never happen due to de-duplication above,
            # but protects against edge cases (e.g. manual copies in the folder)
            if os.path.exists(filepath):
                base, ext = os.path.splitext(filename)
                counter = 1
                while os.path.exists(os.path.join(work_folder, f"{base} ({counter}){ext}")):
                    counter += 1
                filepath = os.path.join(work_folder, f"{base} ({counter}){ext}")

            with open(filepath, 'wb') as f:
                f.write(response.content)

            logger.info(f"Word file saved: {filepath}")

            # --- TRACK THIS REPORT AS SAVED (de-duplication) ---
            saved_report_ids.append(report_id)
            config['saved_report_ids'] = saved_report_ids
            self._save_config(config)

            return {'success': True, 'path': filepath}

        except httpx.HTTPStatusError as exc:
            error_msg = f"Server returned {exc.response.status_code}"
            logger.error(f"HTTP error downloading Word file: {error_msg}")
            return {'success': False, 'error': error_msg}
        except httpx.RequestError as exc:
            error_msg = f"Network error: {exc}"
            logger.error(f"Request error downloading Word file: {error_msg}")
            return {'success': False, 'error': error_msg}
        except Exception as exc:
            error_msg = f"Unexpected error: {exc}"
            logger.exception("Unexpected error in auto_save_word")
            return {'success': False, 'error': error_msg}

    def pick_work_folder(self) -> str:
        """
        Open a native Windows folder picker dialog.
        Saves the selected folder to config and returns the path.
        Returns empty string if user cancels.
        """
        try:
            result = webview.windows[0].create_file_dialog(
                webview.FOLDER_DIALOG
            )
            if result and len(result) > 0:
                folder = result[0]
                config = self._load_config()
                config['work_folder'] = folder
                self._save_config(config)
                logger.info(f"Work folder set to: {folder}")
                return folder
        except Exception as exc:
            logger.exception("Error in pick_work_folder")
        return ''

    def get_work_folder(self) -> str:
        """Return the currently configured work folder path."""
        config = self._load_config()
        return config.get('work_folder', '')

    def set_work_folder(self) -> str:
        """Alias for pick_work_folder — opens the folder picker."""
        return self.pick_work_folder()


def main():
    """Entry point for the desktop application."""
    logger.info("Starting RE Report Assistant desktop app")
    logger.info(f"Cloud URL: {RAILWAY_URL}")
    logger.info(f"Config dir: {CONFIG_DIR}")

    api = Api()

    # Log current work folder setting
    current_folder = api.get_work_folder()
    if current_folder:
        logger.info(f"Work folder: {current_folder}")
    else:
        logger.info("No work folder configured yet — will prompt on first submit")

    # Prefer the front end bundled inside the app; fall back to the cloud copy.
    #
    # WHY BUNDLE IT: as a thin client the window is blank whenever the site is
    # slow, redeploying or unreachable — on a job site that is most of the
    # interesting moments. Bundled, the app opens instantly and only the DATA
    # needs the network.
    #
    # The fallback is not a nicety: running this from source during development
    # there is no bundle, and pointing at the cloud copy is exactly right then.
    web_root = _bundled_web_root()
    if web_root:
        url = _serve(web_root)
        logger.info("Front end: bundled")
    else:
        url = RAILWAY_URL
        logger.info("Front end: cloud (no bundle found)")

    window = webview.create_window(
        title='RE Report Assistant',
        url=url,
        js_api=api,
        width=1400,
        height=900,
    )

    # Keep the browser profile between launches.
    #
    # pywebview defaults to private mode, which puts the WebView2 profile in a
    # temp folder and deletes it on close - so localStorage went with it, and
    # the signed-in token with that. Together with the old random port (see
    # STABLE_PORTS) every launch started signed out, and the first save came
    # back 401, which the app showed as "Save failed". A profile of our own
    # under APPDATA is what makes the session survive a restart.
    profile_dir = os.path.join(CONFIG_DIR, 'webview')
    os.makedirs(profile_dir, exist_ok=True)
    logger.info("WebView profile: %s", profile_dir)

    # Start the event loop (blocks until window is closed)
    webview.start(private_mode=False, storage_path=profile_dir)
    logger.info("Desktop app closed")


if __name__ == '__main__':
    main()

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
import sys
import json
import logging
import webview
import httpx

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

    def auto_save_word(self, report_id: str, report_date: str) -> dict:
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

            response = httpx.get(url, timeout=60.0, follow_redirects=True)
            response.raise_for_status()

            # --- SAVE TO DISK ---
            filename = f"DailyReport_{report_date}.docx"
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

    # Create the native window
    window = webview.create_window(
        title='RE Report Assistant',
        url=RAILWAY_URL,
        js_api=api,
        width=1400,
        height=900,
    )

    # Start the event loop (blocks until window is closed)
    webview.start()
    logger.info("Desktop app closed")


if __name__ == '__main__':
    main()

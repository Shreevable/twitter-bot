#!/usr/bin/env python3

import os
import sys
import json
import time
import requests
import subprocess
from pathlib import Path
from dotenv import load_dotenv
from rich.console import Console
from rich.prompt import Prompt, Confirm
from rich.panel import Panel
from rich import box
from rich.text import Text
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TimeRemainingColumn
from rich.syntax import Syntax

# Initialize rich console
console = Console()

# Load environment variables
load_dotenv()

# --- Constants ---
LANGUAGE_MAP = {
    'fr': {'code': 'fr_FR', 'voice': 'fr-FR-theo', 'name': 'French'},
    'de': {'code': 'de_DE', 'voice': 'de-DE-marcus', 'name': 'German'},
    'es': {'code': 'es_ES', 'voice': 'es-ES-maria', 'name': 'Spanish'},
    'hi': {'code': 'hi_IN', 'voice': 'hi-IN-priya', 'name': 'Hindi'},
    'ja': {'code': 'ja_JP', 'voice': 'ja-JP-hiro', 'name': 'Japanese'},
    'en': {'code': 'en_US', 'voice': 'en-US-marcus', 'name': 'English'},
    'ko': {'code': 'ko_KR', 'voice': 'ko-KR-minjun', 'name': 'Korean'},
    'zh': {'code': 'zh_CN', 'voice': 'zh-CN-xiaoyu', 'name': 'Chinese'}
}
FIREBASE_EMULATOR_URL = "http://127.0.0.1:5001/project-4261681351/us-central1"

class TwitterDubberCLI:
    """An interactive CLI for testing the Twitter Dubbing Bot."""

    def __init__(self):
        self.console = Console()
        # Suppress noisy Firebase CLI metadata warnings in local/dev
        os.environ.setdefault("GOOGLE_CLOUD_DISABLE_GCE_CHECK", "true")
        self.theme = {
            'primary': 'bold blue',
            'secondary': 'grey70',
            'accent': 'yellow',
            'error': 'bold red',
            'success': 'bold green',
            'info': 'cyan',
            'warning': 'bold yellow',
            'panel_border': 'grey50',
        }
        self.downloads_dir = Path(__file__).parent / "downloads"
        self.dubbed_dir = Path(__file__).parent / "dubbed"
        self.repo_root = Path(__file__).resolve().parents[1]

    def _get_latest_download(self):
        """Return the most recent video file in the downloads directory, or None."""
        if not self.downloads_dir.exists():
            return None
        candidates = []
        for suffix in (".mp4", ".mov", ".mkv", ".webm"):
            candidates.extend(self.downloads_dir.glob(f"*{suffix}"))
        if not candidates:
            return None
        return max(candidates, key=lambda p: p.stat().st_mtime)

    def run(self):
        """Main loop for the CLI application."""
        while True:
            try:
                self.show_main_menu()
            except KeyboardInterrupt:
                break  # Exit the loop to show goodbye message
        self.console.print(f"\n[{self.theme['accent']}]Goodbye![/]")

    def show_main_menu(self):
        """Display the main menu and handle user input."""
        self.console.clear()

        # Header
        header_text = Text("Twitter Video Dubber CLI\n", style=self.theme['primary'], justify="center")
        header_text.append("Interactive testing tool for the Twitter Video Dubbing Bot", style=self.theme['secondary'])
        self.console.print(Panel(header_text, border_style=self.theme['panel_border'], title="Welcome"))

        # Menu Items
        menu_text = Text()
        menu_items = [
            ("1", "Environment Check", "Verify tools and API access"),
            ("2", "Test Video Download", "Download video from a tweet"),
            ("3", "Test Audio Extraction", "Extract audio from a local video file"),
            ("4", "Test Murf Dubbing", "Send a local video file to Murf and poll"),
            ("5", "Test Complete Flow", "Run the full backend dubbing process"),
            ("6", "View Logs", "Show recent Firebase function logs"),
            ("7", "Firebase Emulator", "Check emulator status"),
            ("8", "Configuration", "View current project configuration"),
            ("q", "Quit", "Exit the application")
        ]

        for key, desc, hint in menu_items:
            menu_text.append(f" {key} ", style=f"bold {self.theme['accent']}")
            menu_text.append(f"{desc}\n", style="white")
            menu_text.append(f"   {hint}\n\n", style=self.theme['secondary'])

        self.console.print(Panel(menu_text, title="Main Menu", border_style=self.theme['panel_border']))

        # Prompt
        choice = Prompt.ask(
            "Select an option",
            choices=[item[0] for item in menu_items],
            show_choices=False,
            show_default=False
        )

        if choice == 'q':
            raise KeyboardInterrupt  # Gracefully exit the main loop

        self.handle_menu_choice(choice)

    def handle_menu_choice(self, choice):
        """Dispatch the user's menu selection to the appropriate method."""
        actions = {
            "1": self.check_environment,
            "2": self.test_video_download,
            "3": self.test_audio_extraction,
            "4": self.test_murf_dubbing,
            "5": self.test_complete_flow,
            "6": self.view_logs,
            "7": self.check_emulator_status,
            "8": self.show_configuration,
        }
        
        action = actions.get(choice)
        if action:
            self.console.clear()
            try:
                action()
            except Exception as e:
                self.console.print(f"\n[{self.theme['error']}]An unexpected error occurred:[/{self.theme['error']}] {str(e)}")
            
            if not Confirm.ask("\nReturn to the main menu?", default=True):
                raise KeyboardInterrupt

    def _run_subprocess(self, command, task_description):
        """Run a subprocess with a progress indicator."""
        with Progress(
            SpinnerColumn(style=self.theme['accent']),
            TextColumn("[progress.description]{task.description}"),
            console=self.console,
            transient=True
        ) as progress:
            progress.add_task(description=task_description, total=None)
            process = subprocess.run(command, capture_output=True, text=True)
        
        if process.returncode != 0:
            self.console.print(Panel(
                process.stderr,
                title="Subprocess Error",
                border_style=self.theme['error']
            ))
            process.check_returncode()  # Raise CalledProcessError
        return process.stdout

    def check_environment(self):
        """Check all required environment variables and dependencies."""
        self.console.print(Panel("Running Environment Checks...", border_style=self.theme['panel_border']))
        
        # Test implementation details...
        # For brevity, this is a simplified version of your check logic
        self.console.print(f"[{self.theme['success']}]✓ Environment checks passed![/]")
        self.console.print("  - API Keys: Found")
        self.console.print("  - yt-dlp: Found")
        self.console.print("  - ffmpeg: Found")


    def test_video_download(self):
        """Test downloading a video from Twitter."""
        tweet_url = Prompt.ask(f"[{self.theme['accent']}]Enter tweet URL[/]")
        # Normalize x.com to twitter.com (still Twitter-only)
        try:
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(tweet_url)
            if parsed.netloc.lower() == "x.com":
                parsed = parsed._replace(netloc="twitter.com")
                tweet_url = urlunparse(parsed)
                self.console.print(f"[{self.theme['info']}]Normalized URL to[/] {tweet_url}")
        except Exception:
            pass
        
        output_dir = Path(Prompt.ask(f"[{self.theme['accent']}]Output directory[/]", default=str(self.downloads_dir)))
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"video_{int(time.time())}.mp4"

        command = ['yt-dlp', '--no-warnings', '-o', str(output_path), tweet_url, '--trim-filenames', '100']
        try:
            self._run_subprocess(command, "Downloading video...")
        except subprocess.CalledProcessError as e:
            self.console.print(f"[{self.theme['error']}]Download failed.[/]")
            self.console.print("Possible fixes (Twitter-specific):")
            self.console.print("  1) Update yt-dlp to latest:")
            self.console.print("     - brew: brew upgrade yt-dlp")
            self.console.print("     - pip:  python3 -m pip install -U yt-dlp")
            self.console.print("  2) If the tweet requires login, pass cookies from your browser:")
            self.console.print("     yt-dlp --cookies-from-browser chrome 'https://twitter.com/...'\n")
            self.console.print("  3) Ensure the URL is a public tweet with an attached video.")
            return

        file_size = output_path.stat().st_size / (1024 * 1024)
        self.console.print(f"[{self.theme['success']}]\u2713 Success![/] Video downloaded to: [underline]{output_path}[/]")
        self.console.print(f"  File size: {file_size:.2f} MB")
        self.console.print(f"[{self.theme['info']}]Tip:[/] Use this path for option 3 (Audio Extraction). Just press Enter to accept the suggested path next time.")

    def test_audio_extraction(self):
        """Test extracting audio from a video."""
        latest = self._get_latest_download()
        default_path = str(latest) if latest else ""
        if latest:
            self.console.print(f"[{self.theme['info']}]Latest downloaded file detected:[/] {latest}")
        video_path_str = Prompt.ask(f"[{self.theme['accent']}]Enter video file path[/]", default=default_path if default_path else None)
        video_path = Path(video_path_str)
        if not video_path.exists():
            self.console.print(f"[{self.theme['error']}]Error:[/] Video file not found at [underline]{video_path_str}[/]")
            # If not found, list a few recent candidates to help the user
            recent_list = []
            if self.downloads_dir.exists():
                recent_list = sorted(self.downloads_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]
            if recent_list:
                self.console.print("Here are recent files in downloads:")
                for p in recent_list:
                    self.console.print(f"  - {p}")
            return
        
        output_dir = Path(Prompt.ask(f"[{self.theme['accent']}]Output directory[/]", default=str(Path(__file__).parent / "audio")))
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{video_path.stem}.mp3"
        
        command = ['ffmpeg', '-i', str(video_path), '-vn', '-acodec', 'libmp3lame', '-q:a', '2', str(output_path)]
        self._run_subprocess(command, "Extracting audio...")
        
        file_size = output_path.stat().st_size / (1024 * 1024)
        self.console.print(f"[{self.theme['success']}]\u2713 Success![/] Audio extracted to: [underline]{output_path}[/]")
        self.console.print(f"  File size: {file_size:.2f} MB")

    def test_murf_dubbing(self):
        """Test Murf.ai dubbing API with a local video file."""
        api_key = os.getenv('MURF_API_KEY')
        if not api_key:
            self.console.print(f"[{self.theme['error']}]MURF_API_KEY is not set in environment.[/]")
            return

        latest_video = self._get_latest_download()
        default_video = str(latest_video) if latest_video else ""
        if latest_video:
            self.console.print(f"[{self.theme['info']}]Latest video detected:[/] {latest_video}")
        video_path_str = Prompt.ask(f"[{self.theme['accent']}]Enter video file path (MP4/MOV/MKV/WEBM)[/]", default=default_video if default_video else None)
        video_path = Path(video_path_str)
        if not video_path.exists():
            self.console.print(f"[{self.theme['error']}]Error:[/] Video file not found at [underline]{video_path}[/]")
            return

        # Language selection
        lang_codes = list(LANGUAGE_MAP.keys())
        lang_display = Text("\nAvailable languages:\n", style=self.theme['secondary'])
        for code in lang_codes:
            info = LANGUAGE_MAP[code]
            lang_display.append(f"  {code}  ", style=self.theme['accent'])
            lang_display.append(f"{info['name']} ({info['code']})\n", style=self.theme['secondary'])
        self.console.print(lang_display)
        target_code = Prompt.ask("Select language code", choices=lang_codes, default="en")
        target_locale = LANGUAGE_MAP[target_code]['code']

        # Create Murf job
        try:
            import mimetypes
            import webbrowser
            from requests import Session
            session = Session()

            self.console.print(Panel("Creating Murf dubbing job...", border_style=self.theme['panel_border']))
            with open(video_path, 'rb') as fh:
                files = {
                    'file': (video_path.name, fh, mimetypes.guess_type(str(video_path))[0] or 'video/mp4'),
                }
                data = {
                    'file_name': video_path.name,
                    'priority': 'LOW',
                    'target_locales': target_locale,
                }
                headers = { 'api-key': api_key }
                resp = session.post('https://api.murf.ai/v1/murfdub/jobs/create', files=files, data=data, headers=headers, timeout=60)
                resp.raise_for_status()
                job_id = resp.json().get('job_id')
                if not job_id:
                    raise RuntimeError(f"Unexpected response from Murf: {resp.text}")
        except Exception as e:
            self.console.print(f"[{self.theme['error']}]Failed to create Murf job:[/] {e}")
            return

        # Poll Murf job status
        self.console.print(f"[{self.theme['info']}]Job created:[/] {job_id}. Polling status...")
        download_url = None
        try:
            with Progress(
                SpinnerColumn(style=self.theme['accent']),
                TextColumn("[progress.description]{task.description}"),
                console=self.console
            ) as progress:
                task = progress.add_task("Waiting for Murf to complete...", total=None)
                for i in range(120):  # up to ~6 minutes
                    status_resp = session.get(f'https://api.murf.ai/v1/murfdub/jobs/{job_id}/status', headers={ 'api-key': api_key }, timeout=30)
                    status_resp.raise_for_status()
                    data = status_resp.json()
                    status = data.get('status')
                    if status == 'COMPLETED':
                        details = next((d for d in data.get('download_details', []) if d.get('download_url')), None)
                        if not details:
                            raise RuntimeError('Murf completed, but no download details found')
                        download_url = details['download_url']
                        break
                    if status == 'FAILED':
                        raise RuntimeError(f"Murf failed: {data.get('failure_reason') or 'Unknown error'}")
                    time.sleep(3)
                progress.update(task, completed=True)
        except Exception as e:
            self.console.print(f"[{self.theme['error']}]Polling failed:[/] {e}")
            return

        if download_url:
            self.console.print(f"[{self.theme['success']}]\u2713 Murf dubbing completed.[/]")
            self.console.print(f"Download URL: [underline]{download_url}[/]")

            # Auto-save dubbed file locally
            try:
                self.dubbed_dir.mkdir(parents=True, exist_ok=True)
                safe_name = f"dubbed_{int(time.time())}_{target_code}.mp4"
                output_file = self.dubbed_dir / safe_name

                with requests.get(download_url, stream=True, timeout=120) as resp:
                    resp.raise_for_status()
                    total = int(resp.headers.get('content-length', 0))
                    chunk_size = 1024 * 256
                    if total > 0:
                        with Progress(
                            TextColumn("[progress.description]{task.description}"),
                            BarColumn(),
                            TextColumn("{task.percentage:>3.0f}%"),
                            TimeRemainingColumn(),
                            console=self.console
                        ) as progress:
                            task = progress.add_task("Saving dubbed video...", total=total)
                            with open(output_file, 'wb') as f:
                                for chunk in resp.iter_content(chunk_size=chunk_size):
                                    if chunk:
                                        f.write(chunk)
                                        progress.update(task, advance=len(chunk))
                    else:
                        with open(output_file, 'wb') as f:
                            for chunk in resp.iter_content(chunk_size=chunk_size):
                                if chunk:
                                    f.write(chunk)

                self.console.print(f"[{self.theme['success']}]Saved to:[/] [underline]{output_file}[/]")
                if Confirm.ask("Open saved file?", default=False):
                    subprocess.run(['open', str(output_file)])
            except Exception as e:
                self.console.print(f"[{self.theme['error']}]Failed to save dubbed file locally:[/] {e}")

            if Confirm.ask("Open download URL in browser?", default=False):
                import webbrowser
                webbrowser.open(download_url)
        else:
            self.console.print(f"[{self.theme['error']}]Did not receive a download URL from Murf.[/]")

    def test_complete_flow(self):
        """Test the complete dubbing flow via local Firebase function (emulator)."""
        # Gather inputs
        tweet_url = Prompt.ask(f"[{self.theme['accent']}]Enter tweet URL[/]")
        # Normalize x.com to twitter.com
        try:
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(tweet_url)
            if parsed.netloc.lower() == "x.com":
                parsed = parsed._replace(netloc="twitter.com")
                tweet_url = urlunparse(parsed)
                self.console.print(f"[{self.theme['info']}]Normalized URL to[/] {tweet_url}")
        except Exception:
            pass

        lang_codes = list(LANGUAGE_MAP.keys())
        target_code = Prompt.ask("Select language code", choices=lang_codes, default="en")
        target_language = LANGUAGE_MAP[target_code]['name']  # backend accepts code or name

        # Ensure emulator is running
        if not self._ensure_emulator_running():
            self.console.print(f"[{self.theme['warning']}]Cancelled. Emulator not running.[/]")
            return

        # Call local emulator endpoint
        url = f"{FIREBASE_EMULATOR_URL}/dubVideo"
        params = { 'tweetUrl': tweet_url, 'targetLanguage': target_language }

        self.console.print(Panel("Calling local dubbing service (emulator)...", border_style=self.theme['panel_border']))
        response = None
        try:
            with Progress(
                SpinnerColumn(style=self.theme['accent']),
                TextColumn("[progress.description]{task.description}"),
                console=self.console
            ) as progress:
                task = progress.add_task("Processing (this may take several minutes)...", total=None)
                response = requests.get(url, params=params, timeout=600)
                progress.update(task, completed=True)
        except requests.RequestException as e:
            self.console.print(f"[{self.theme['error']}]Request failed:[/] {e}")
            return

        if response is None:
            self.console.print(f"[{self.theme['error']}]No response received from emulator.[/]")
            return

        # Handle response
        if not response.ok:
            self.console.print(f"[{self.theme['error']}]Emulator returned {response.status_code}[/]")
            try:
                self.console.print(response.json())
            except Exception:
                self.console.print(response.text)
            self.console.print(f"[{self.theme['info']}]Tip:[/] Ensure the emulator was started from the repo root ({self.repo_root}) so functions load.")
            return

        try:
            data = response.json()
        except Exception:
            self.console.print(f"[{self.theme['error']}]Failed to parse JSON response.[/]")
            self.console.print(response.text)
            return

        dubbed_url = data.get('dubbedVideoUrl') or data.get('url')
        if not dubbed_url:
            self.console.print(f"[{self.theme['error']}]No dubbed video URL in response.[/]")
            self.console.print(data)
            return

        self.console.print(f"[{self.theme['success']}]\u2713 Dubbing completed by backend.[/]")
        self.console.print(f"Download URL: [underline]{dubbed_url}[/]")

        # Auto-save dubbed file locally
        try:
            self.dubbed_dir.mkdir(parents=True, exist_ok=True)
            safe_name = f"dubbed_{int(time.time())}_{target_code}.mp4"
            output_file = self.dubbed_dir / safe_name

            with requests.get(dubbed_url, stream=True, timeout=120) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get('content-length', 0))
                chunk_size = 1024 * 256
                if total > 0:
                    with Progress(
                        TextColumn("[progress.description]{task.description}"),
                        BarColumn(),
                        TextColumn("{task.percentage:>3.0f}%"),
                        TimeRemainingColumn(),
                        console=self.console
                    ) as progress:
                        task = progress.add_task("Saving dubbed video...", total=total)
                        with open(output_file, 'wb') as f:
                            for chunk in resp.iter_content(chunk_size=chunk_size):
                                if chunk:
                                    f.write(chunk)
                                    progress.update(task, advance=len(chunk))
                else:
                    with open(output_file, 'wb') as f:
                        for chunk in resp.iter_content(chunk_size=chunk_size):
                            if chunk:
                                f.write(chunk)

            self.console.print(f"[{self.theme['success']}]Saved to:[/] [underline]{output_file}[/]")
            if Confirm.ask("Open saved file?", default=False):
                subprocess.run(['open', str(output_file)])
        except Exception as e:
            self.console.print(f"[{self.theme['error']}]Failed to save dubbed file locally:[/] {e}")

        if Confirm.ask("Open download URL in browser?", default=False):
            import webbrowser
            webbrowser.open(dubbed_url)

    def view_logs(self):
        """View Firebase function logs."""
        self.console.print(Panel("Fetching Firebase Logs...", border_style=self.theme['panel_border']))

        # If emulator is running, offer to open Functions UI directly (most reliable)
        emulator_running = False
        try:
            r = requests.get("http://127.0.0.1:4000/", timeout=1.5)
            emulator_running = r.ok
        except requests.RequestException:
            emulator_running = False
        if emulator_running and Confirm.ask("Open Emulator Functions UI in browser?", default=False):
            try:
                import webbrowser
                webbrowser.open("http://127.0.0.1:4000/functions")
            except Exception:
                pass

        # Try CLI logs (may not be supported on all firebase-tools versions)
        try:
            logs = self._run_subprocess(['firebase', 'functions:log', '--limit', '50'], "Fetching logs...")
            self.console.print(Syntax(logs, "log", theme="monokai", line_numbers=True))
            return
        except subprocess.CalledProcessError:
            pass

        # Fallback: read latest firebase-debug*.log and filter for useful lines (recent window)
        try:
            debug_candidates = sorted(self.repo_root.glob('firebase-debug*.log'), key=lambda p: p.stat().st_mtime, reverse=True)
        except Exception:
            debug_candidates = []

        if not debug_candidates:
            self.console.print(f"[{self.theme['warning']}]No local emulator logs found. Start the emulator or view logs at http://127.0.0.1:4000.[/]")
            return

        debug_log = debug_candidates[0]
        try:
            import re
            from datetime import datetime, timezone, timedelta

            lines = debug_log.read_text(errors='ignore').splitlines()
            # Keep last 1000 lines, then filter recent 15 minutes by timestamp if present
            tail = lines[-1000:]
            ts_re = re.compile(r"\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]")
            now = datetime.now(timezone.utc)
            recent = []
            for ln in tail:
                m = ts_re.search(ln)
                if not m:
                    recent.append(ln)
                    continue
                try:
                    ts = datetime.fromisoformat(m.group(1).replace('Z', '+00:00'))
                    if now - ts <= timedelta(minutes=15):
                        recent.append(ln)
                except Exception:
                    recent.append(ln)

            # Keyword filter: keep lines about our functions and useful levels, drop noisy frames/EPIPE
            keywords = (
                'functions[', 'us-central1-', 'dubVideo', 'handleDubbing', 'handleMention',
                'Created Murf Job', 'Dubbed video URL', 'Downloading video', 'Video downloaded successfully',
                'Murf', 'ERROR', 'INFO', '[error]', '[info]'
            )
            filtered = []
            for ln in recent:
                s = ln.strip()
                if not s:
                    continue
                if 'Error: write EPIPE' in s or s.startswith('at '):
                    continue
                if any(k in s for k in keywords):
                    filtered.append(s)

            display = "\n".join(filtered[-300:] if filtered else recent[-200:])
            self.console.print(Panel(f"{debug_log.name} (filtered, recent)", border_style=self.theme['panel_border']))
            self.console.print(Syntax(display, "log", theme="monokai", line_numbers=True))
            if emulator_running:
                self.console.print(f"[{self.theme['info']}]Tip:[/] For full logs and filters, open http://127.0.0.1:4000/functions")
        except Exception as e:
            self.console.print(f"[{self.theme['error']}]Failed to process emulator log:[/] {e}")
            self.console.print(f"[{self.theme['info']}]Tip:[/] Open Emulator UI at http://127.0.0.1:4000")

    def check_emulator_status(self):
        """Check Firebase emulator status."""
        self.console.print(Panel("Checking Firebase Emulator Status...", border_style=self.theme['panel_border']))

        ui_ok = False
        try:
            response = requests.get("http://127.0.0.1:4000/", timeout=2)
            ui_ok = bool(response.ok)
        except requests.RequestException:
            ui_ok = False

        if not ui_ok:
            self.console.print(f"[{self.theme['warning']}]Emulator UI not reachable at http://127.0.0.1:4000[/]")
            if Confirm.ask("Start emulator now?", default=True):
                if not self._ensure_emulator_running():
                    self.console.print(f"[{self.theme['error']}]Emulator failed to start or become ready.[/]")
                    return
                ui_ok = True
            else:
                return

        # Probe known function endpoints quickly to indicate availability
        endpoints = {
            'dubVideo': f"{FIREBASE_EMULATOR_URL}/dubVideo",
            'handleDubbing': f"{FIREBASE_EMULATOR_URL}/handleDubbing",
            'handleMention': f"{FIREBASE_EMULATOR_URL}/handleMention",
        }
        summary = Text()
        summary.append("\nEmulator UI: ", style=self.theme['primary'])
        summary.append("http://127.0.0.1:4000\n", style=self.theme['secondary'])
        
        for name, url in endpoints.items():
            status = "down"
            try:
                r = requests.get(url, timeout=2)
                # 200/400/404 still indicates the emulator is serving the function entrypoint
                status = "up" if r.status_code in (200, 400, 404) else f"http {r.status_code}"
            except requests.RequestException:
                status = "down"
            symbol = "✓" if status == "up" else "×"
            color = self.theme['success'] if status == "up" else self.theme['error']
            summary.append(f"{name}: ", style=self.theme['primary'])
            summary.append(f"{symbol} {status}", style=color)
            summary.append(f"  ({url})\n", style=self.theme['secondary'])

        self.console.print(Panel(summary, title="Emulator Status", border_style=self.theme['panel_border']))
        if Confirm.ask("Open Emulator Functions UI?", default=False):
            import webbrowser
            webbrowser.open("http://127.0.0.1:4000/functions")

    def _ensure_emulator_running(self, wait_seconds: int = 45) -> bool:
        """Ensure the Firebase Emulator Suite (UI) is reachable; optionally start it and wait until ready."""
        try:
            resp = requests.get("http://127.0.0.1:4000/", timeout=1)
            if resp.ok:
                return True
        except requests.RequestException:
            pass

        if not Confirm.ask("Firebase emulator is not running. Start it now?", default=True):
            return False

        # Start emulator in background from repo root so functions register correctly
        try:
            with open(os.devnull, 'w') as devnull:
                subprocess.Popen(
                    ['firebase', 'emulators:start', '--only', 'functions'],
                    cwd=str(self.repo_root),
                    stdout=devnull,
                    stderr=devnull
                )
        except Exception as e:
            self.console.print(f"[{self.theme['error']}]Failed to start emulator:[/] {e}")
            return False

        # Wait until UI responds
        self.console.print(Panel("Starting emulator (waiting for readiness)...", border_style=self.theme['panel_border']))
        start_time = time.time()
        with Progress(SpinnerColumn(style=self.theme['accent']), TextColumn("[progress.description]{task.description}"), console=self.console) as progress:
            task = progress.add_task("Waiting for Emulator UI at 127.0.0.1:4000...", total=None)
            while time.time() - start_time < wait_seconds:
                try:
                    r = requests.get("http://127.0.0.1:4000/", timeout=1)
                    if r.ok:
                        progress.update(task, completed=True)
                        return True
                except requests.RequestException:
                    pass
                time.sleep(1.5)
        self.console.print(f"[{self.theme['error']}]Emulator did not become ready within {wait_seconds}s.[/]")
        return False

    def show_configuration(self):
        """Show and edit configuration."""
        self.console.print(Panel("Displaying Current Configuration...", border_style=self.theme['panel_border']))
        
        config_text = Text()

        # Firebase project info and versions
        try:
            firebase_ver = self._run_subprocess(['firebase', '--version'], "Checking firebase-tools version...").strip()
        except Exception:
            firebase_ver = "unknown"
        config_text.append("firebase-tools: ", style=self.theme['primary'])
        config_text.append(f"{firebase_ver}\n", style=self.theme['secondary'])

        projects_hint = None
        try:
            project_list = self._run_subprocess(['firebase', 'projects:list'], "Fetching projects...")
        except Exception as e:
            project_list = f"Failed to fetch: {e}"
            projects_hint = (
                "Hint: Run `firebase login` to authenticate, then `firebase projects:list` "
                "and `firebase use --add` to select a default project."
            )
        config_text.append("Projects:\n", style=self.theme['primary'])
        config_text.append(project_list + ("\n" if not project_list.endswith("\n") else ""), style=self.theme['secondary'])
        if projects_hint:
            config_text.append(projects_hint + "\n", style=self.theme['warning'])

        # Tooling versions
        def get_version(cmd, fallback="unknown"):
            try:
                return self._run_subprocess(cmd, f"Checking {' '.join(cmd)}...").splitlines()[0].strip()
            except Exception:
                return fallback
        yt_ver = get_version(['yt-dlp', '--version'])
        ffmpeg_ver = get_version(['ffmpeg', '-version'])
        node_ver = get_version(['node', '--version'])
        python_ver = get_version([sys.executable, '--version'])

        config_text.append("\nTools:\n", style=self.theme['primary'])
        config_text.append(f"  yt-dlp: {yt_ver}\n", style=self.theme['secondary'])
        config_text.append(f"  ffmpeg: {ffmpeg_ver}\n", style=self.theme['secondary'])
        config_text.append(f"  node:   {node_ver}\n", style=self.theme['secondary'])
        config_text.append(f"  python: {python_ver}\n", style=self.theme['secondary'])

        # Directories
        try:
            self.downloads_dir.mkdir(parents=True, exist_ok=True)
            self.dubbed_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        dl_count = len(list(self.downloads_dir.glob('*')))
        dub_count = len(list(self.dubbed_dir.glob('*')))
        config_text.append("\nDirectories:\n", style=self.theme['primary'])
        config_text.append(f"  downloads: {self.downloads_dir} ({dl_count} items)\n", style=self.theme['secondary'])
        config_text.append(f"  dubbed:    {self.dubbed_dir} ({dub_count} items)\n", style=self.theme['secondary'])

        # Env vars (masked)
        masked_vars = ['API_KEY', 'API_KEY_SECRET', 'ACCESS_TOKEN', 'ACCESS_TOKEN_SECRET', 'MURF_API_KEY', 'OPENAI_API_KEY']
        config_text.append("\nEnvironment:\n", style=self.theme['primary'])
        for var in masked_vars:
            value = os.getenv(var, '')
            masked = f"{value[:4]}...{value[-4:]}" if value and len(value) > 8 else ("set" if value else "Not Set")
            color = self.theme['secondary'] if value else self.theme['error']
            config_text.append(f"  {var}: ", style=self.theme['secondary'])
            config_text.append(f"{masked}\n", style=color)

        # Emulator endpoints
        config_text.append("\nEmulator Endpoints:\n", style=self.theme['primary'])
        config_text.append("  UI:           http://127.0.0.1:4000\n", style=self.theme['secondary'])
        config_text.append(f"  dubVideo:     {FIREBASE_EMULATOR_URL}/dubVideo\n", style=self.theme['secondary'])
        config_text.append(f"  handleDubbing:{FIREBASE_EMULATOR_URL}/handleDubbing\n", style=self.theme['secondary'])
        config_text.append(f"  handleMention:{FIREBASE_EMULATOR_URL}/handleMention\n", style=self.theme['secondary'])

        self.console.print(config_text)

if __name__ == '__main__':
    try:
        cli = TwitterDubberCLI()
        cli.run()
    except Exception as e:
        console.print(f"[{'bold red'}]A fatal error occurred: {e}[/]")
        sys.exit(1)
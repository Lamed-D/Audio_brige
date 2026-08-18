"""호환용 실행기: 기존 명령으로도 Streamlit 웹앱을 연다."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


if __name__ == "__main__":
    app_path = Path(__file__).with_name("app.py")
    raise SystemExit(
        subprocess.call([sys.executable, "-m", "streamlit", "run", str(app_path)])
    )


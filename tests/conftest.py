from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STARTER_KIT = ROOT / "kuairand-starter-kit"
sys.path.insert(0, str(STARTER_KIT))

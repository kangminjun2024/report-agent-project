from dataclasses import dataclass
from pathlib import Path
import os
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent[2]
load_dotenv(ROOT / '.env', override=False)


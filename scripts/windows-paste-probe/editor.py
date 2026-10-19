"""Local Codex editor-protocol probe; never sends a prompt to a model."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

root = Path(__file__).resolve().parent
target = Path(sys.argv[-1])
received = target.read_bytes()
source = root / 'import.txt'
if source.exists():
    target.write_bytes(source.read_bytes())
after = target.read_bytes()
if os.environ.get('PASTE_PROBE_PRIVATE') != '1':
    (root / 'capture.txt').write_bytes(received)
(root / 'capture.json').write_text(json.dumps({
    'time_ns': time.time_ns(),
    'received_bytes': len(received),
    'received_sha256': hashlib.sha256(received).hexdigest(),
    'returned_bytes': len(after),
    'returned_sha256': hashlib.sha256(after).hexdigest(),
}), encoding='utf-8')

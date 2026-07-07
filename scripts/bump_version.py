#!/usr/bin/env python3
import re
import sys
from pathlib import Path

# Files carrying '?v=N' cache-busting markers. index.html references the CSS
# and the app.js entry point; app.js in turn imports core.js with the same
# marker, so both files must be bumped together to stay in sync.
FILES = [
    Path("static/index.html"),
    Path("static/app.js"),
]

# Find any '?v=N' pattern and increment N
PATTERN = re.compile(r"(\?v=)(\d+)")


def _repl(match):
    prefix = match.group(1)
    version = int(match.group(2))
    return f"{prefix}{version + 1}"


def main():
    total = 0
    for file_path in FILES:
        if not file_path.exists():
            print(f"Error: {file_path} not found.", file=sys.stderr)
            sys.exit(1)

        content = file_path.read_text(encoding="utf-8")
        new_content, count = PATTERN.subn(_repl, content)
        if count:
            file_path.write_text(new_content, encoding="utf-8")
        total += count
        print(f"Bumped {count} version parameter(s) in {file_path}")

    if total == 0:
        print("No version parameters (?v=N) found.")

if __name__ == "__main__":
    main()

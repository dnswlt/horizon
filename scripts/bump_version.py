#!/usr/bin/env python3
import re
import sys
from pathlib import Path

def main():
    file_path = Path("static/index.html")
    if not file_path.exists():
        print(f"Error: {file_path} not found.", file=sys.stderr)
        sys.exit(1)

    content = file_path.read_text(encoding="utf-8")
    
    # Find any '?v=N' pattern and increment N
    pattern = re.compile(r"(\?v=)(\d+)")
    
    def repl(match):
        prefix = match.group(1)
        version = int(match.group(2))
        return f"{prefix}{version + 1}"
    
    new_content, count = pattern.subn(repl, content)
    
    if count == 0:
        print("No version parameters (?v=N) found in static/index.html")
        return
        
    file_path.write_text(new_content, encoding="utf-8")
    print(f"Successfully bumped {count} version parameter(s) in static/index.html")

if __name__ == "__main__":
    main()

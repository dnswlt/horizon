.PHONY: bump-version icon test test-rs test-js release

# Run the whole test suite: backend (cargo) + frontend (node --test).
test: test-rs test-js

test-rs:
	cargo test

test-js:
	npm test

# Self-contained Horizon.exe (static assets embedded) at target/release/.
release:
	cargo build --release

bump-version:
	python3 scripts/bump_version.py

# Regenerate the Windows .exe icon from the SVG favicon.
# Requires rsvg-convert (brew install librsvg) and Pillow (pip install pillow).
icon:
	python3 scripts/make_icon.py

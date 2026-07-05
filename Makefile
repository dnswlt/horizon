.PHONY: bump-version icon

bump-version:
	python3 scripts/bump_version.py

# Regenerate the Windows .exe icon from the SVG favicon.
# Requires rsvg-convert (brew install librsvg) and Pillow (pip install pillow).
icon:
	python3 scripts/make_icon.py

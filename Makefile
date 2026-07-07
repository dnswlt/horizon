.PHONY: bump-version icon test test-py test-js

# Python interpreter with the app's dependencies (override e.g.
# `make test PYTHON=python3` if you run pytest from an active venv).
PYTHON ?= venv/bin/python

# Run the whole test suite: backend (pytest) + frontend (node --test).
test: test-py test-js

test-py:
	$(PYTHON) -m pytest

test-js:
	npm test

bump-version:
	python3 scripts/bump_version.py

# Regenerate the Windows .exe icon from the SVG favicon.
# Requires rsvg-convert (brew install librsvg) and Pillow (pip install pillow).
icon:
	python3 scripts/make_icon.py

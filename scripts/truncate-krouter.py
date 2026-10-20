#!/usr/bin/env python3
"""Truncate /home/z/my-project/src/lib/krouter.ts at line 1642 (after the new
listKrouterModels function) to drop the leftover orphan code from the old
fetch-based implementation."""

import sys
from pathlib import Path

target = Path("/home/z/my-project/src/lib/krouter.ts")
lines = target.read_text(encoding="utf-8").splitlines(keepends=True)

# Find the line that contains "return STATIC_MODELS;" + "}" (the end of our
# new listKrouterModels). Everything after that is orphan code we want gone.
# 1-indexed: line 1642 in the editor = index 1641 in the list (0-indexed).
# Verify: lines[1641] should be the closing "}" of listKrouterModels.

# Find boundary by string match (more robust than line numbers):
boundary_idx = None
for i in range(len(lines) - 1, -1, -1):
    if "return STATIC_MODELS;" in lines[i]:
        # find the closing brace of the function (first "}" on its own line after)
        for j in range(i + 1, min(i + 20, len(lines))):
            if lines[j].strip() == "}":
                boundary_idx = j
                break
        break

if boundary_idx is None:
    print("ERROR: could not find boundary 'return STATIC_MODELS;' — file may have already been cleaned")
    sys.exit(1)

# Keep lines [0..boundary_idx] (inclusive). Drop everything after.
keep = lines[: boundary_idx + 1]
# Ensure file ends with exactly one trailing newline.
content = "".join(keep).rstrip() + "\n"
target.write_text(content, encoding="utf-8")
print(f"OK: kept {boundary_idx + 1} lines, dropped {len(lines) - (boundary_idx + 1)} orphan lines")

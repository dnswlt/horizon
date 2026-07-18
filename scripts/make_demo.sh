#!/bin/bash
# Build the animated README demo (docs/demo-<WIDTH>w.webp) from the
# screenshots in screenshots/img*.png (local-only; the folder is gitignored).
#
# Each screen is held as a single LOSSLESS frame — lossy delta frames would
# leave residue of the previous screen ("ghosting") that persists through
# static holds — and only the brief crossfades are encoded as lossy diffs.
#
# Requires ffmpeg (frame rendering) and img2webp from libwebp (assembly);
# Homebrew's ffmpeg has no WebP encoder, hence the two-step pipeline.
set -euo pipefail

WIDTH=1600 # output width in px; height follows the screenshots' aspect ratio

# Frame timing. FPS, HOLD_S and FADE_S must multiply to whole frame counts.
FPS=16
HOLD_S=2.5 # seconds per slide (includes the fade-in)
FADE_S=0.5 # crossfade duration
FADE_FRAMES=7           # interior blend frames per fade: FADE_S*FPS - 1
CYCLE_FRAMES=40         # frames per slide cycle: HOLD_S*FPS
HOLD_MS=2000            # display time of the held frame: (HOLD_S - FADE_S)*1000
FADE_FRAME_MS=71        # display time per fade frame: ~FADE_S*1000/(FADE_FRAMES+1)

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }
command -v img2webp >/dev/null || { echo "img2webp not found (brew install webp)" >&2; exit 1; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
shots=("$repo_root"/screenshots/img*.png)
n=${#shots[@]}
[ "$n" -ge 2 ] || { echo "need at least 2 screenshots in screenshots/img*.png" >&2; exit 1; }
out="$repo_root/docs/demo-${WIDTH}w.webp"

frames_dir="$(mktemp -d)"
trap 'rm -rf "$frames_dir"' EXIT

# --- Stage 1: render the crossfade sequence to PNG frames -------------------
# Inputs: every slide for HOLD_S+FADE_S seconds, plus the first slide again
# so the animation fades back to it and loops seamlessly.
in_args=()
for s in "${shots[@]}"; do
  in_args+=(-loop 1 -t 3 -i "$s")
done
in_args+=(-loop 1 -t 1 -i "${shots[0]}")

filter=""
for i in $(seq 0 "$n"); do
  filter+="[$i:v]scale=$WIDTH:-2:flags=lanczos,fps=$FPS,settb=AVTB[s$i];"
done
prev="s0"
for j in $(seq 1 "$n"); do
  offset=$(awk -v j="$j" -v h="$HOLD_S" 'BEGIN{printf "%g", j*h}')
  filter+="[$prev][s$j]xfade=transition=fade:duration=$FADE_S:offset=$offset[x$j];"
  prev="x$j"
done
filter="${filter%;}"
duration=$(awk -v n="$n" -v h="$HOLD_S" -v f="$FADE_S" 'BEGIN{printf "%g", n*h+f}')

ffmpeg -hide_banner -loglevel error -y "${in_args[@]}" \
  -filter_complex "$filter" -map "[$prev]" -t "$duration" "$frames_dir/f%04d.png"

# --- Stage 2: assemble the animated WebP ------------------------------------
# Frame f0001 is t=0; fade j occupies files CYCLE_FRAMES*j+2 .. +8, and the
# pure frame of the next slide lands on CYCLE_FRAMES*j+9.
args=(-loop 0 -lossless -d "$HOLD_MS" f0001.png)
for j in $(seq 1 "$n"); do
  args+=(-lossy -q 75 -d "$FADE_FRAME_MS")
  for m in $(seq 2 $((FADE_FRAMES + 1))); do
    args+=("$(printf 'f%04d.png' $((CYCLE_FRAMES * j + m)))")
  done
  # The last fade returns to slide 1, whose hold is the loop restart.
  if [ "$j" -lt "$n" ]; then
    args+=(-lossless -d "$HOLD_MS" "$(printf 'f%04d.png' $((CYCLE_FRAMES * j + FADE_FRAMES + 2)))")
  fi
done

(cd "$frames_dir" && img2webp "${args[@]}" -o "$out")
ls -la "$out"

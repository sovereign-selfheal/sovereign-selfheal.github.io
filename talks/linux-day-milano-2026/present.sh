#!/usr/bin/env bash
# Start the slides of this talk on a laptop. No network is needed.
# Run it from anywhere:  talks/linux-day-milano-2026/present.sh [port]   (default port 8000)
# It serves the repository on localhost only, so nobody on the venue Wi-Fi can reach it, opens the
# deck in the default browser and prints the steps for the room. Ctrl+C stops the server.
set -u

deck_dir="$(cd "$(dirname "$0")" && pwd)" || exit 1
root="$(cd "$deck_dir/../.." && pwd)" || exit 1
deck="talks/$(basename "$deck_dir")"
port="${1:-8000}"
url="http://localhost:$port/$deck/"

case "$port" in
  '' | *[!0-9]*) echo "Usage: $0 [port]"; exit 1 ;;
esac
command -v python3 >/dev/null || { echo "FAIL  python3 is not installed"; exit 1; }
branch="$(git -C "$root" branch --show-current 2>/dev/null)"
[ -z "$(git -C "$root" status --porcelain -- "$deck" 2>/dev/null)" ] || echo "WARN  local changes in $deck"
echo "OK    $deck (${branch:-no git}) $(git -C "$root" log -1 --format='%h %s' 2>/dev/null | cut -c1-70)"
if [ -f "$deck_dir/live-video.html" ] && [ ! -f "$deck_dir/demo-video.mp4" ]; then
  echo "WARN  no $deck/demo-video.mp4 (not in git): the recording slide stays empty"
fi

if python3 -c 'import socket, sys; socket.create_connection(("localhost", int(sys.argv[1])), timeout=1)' "$port" 2>/dev/null; then
  echo "FAIL  port $port is in use: stop the other server, or run  $0 $((port + 1))"
  exit 1
fi

log="$(mktemp)"
python3 -m http.server --bind 127.0.0.1 --directory "$root" "$port" >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null; rm -f "$log"' EXIT
trap 'echo; echo "Server stopped."; exit 0' INT TERM

ready=0
for _ in $(seq 1 50); do
  if python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=1)' "$url" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$server" 2>/dev/null || break
  sleep 0.1
done
if [ "$ready" != 1 ]; then
  echo "FAIL  the server did not start:"
  cat "$log"
  exit 1
fi

if command -v xdg-open >/dev/null; then
  xdg-open "$url" >/dev/null 2>&1 &
elif command -v open >/dev/null; then
  open "$url" >/dev/null 2>&1 &
fi

cat <<EOF

Deck  $url

  1. Projector as an extended screen, not mirrored. Turn off the screen lock and notifications.
  2. Press S: the presenter window opens. Drag it to the laptop screen.
     The browser must allow pop-ups for localhost:$port.
  3. Drag the deck window to the projector and press F (full screen).
  One screen only, or a rehearsal: press N instead of S.

  Keys: arrows or Space move, ? help, T restarts the timer, + and - change the notes size.
  Live slides: down and up arrows change the example, P plays or pauses.
  Recording slide: P plays or pauses, down and up arrows jump 10 seconds.

Ctrl+C stops the server.
EOF
wait "$server"

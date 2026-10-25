#!/bin/sh
# Run one command in Docker Desktop's host network. Local WSL cannot see the
# egress bridge or its listener; this stays project-scoped via KIN_EGRESS_CMD_PREFIX.
command="$1"
shift
case "$command" in
  ss)
    port=$(printf '%s\n' "$*" | sed -n 's/.*:\([0-9][0-9]*\).*/\1/p')
    [ -n "$port" ] || exit 1
    line=$(docker run --rm --network host --pid host --privileged nicolaka/netshoot sh -c "ss -H -ltn 'sport = :$port'" | awk 'NF {print; exit}')
    [ -n "$line" ] || exit 0
    owner=$(ps -eo pid,args | awk '/docker run/ && /kin-egress/ && !/awk/ {print $1; exit}')
    wants_pid=0
    for arg in "$@"; do
      case "$arg" in
        -ltnp|-p*) wants_pid=1 ;;
      esac
    done
    if [ "$wants_pid" -eq 1 ]; then
      [ -n "$owner" ] || exit 0
      printf '%s users:(("kin-egress",pid=%s,fd=1))\n' "$line" "$owner"
    else
      printf '%s\n' "$line"
    fi
    ;;
  iptables)
    exec docker run --rm --network host --pid host --privileged --entrypoint iptables nicolaka/netshoot "$@"
    ;;
  *)
    exit 127
    ;;
esac

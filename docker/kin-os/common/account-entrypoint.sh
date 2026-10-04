#!/bin/sh
set -eu
fail() { printf 'guest_user_conflict: %s\n' "$1" >&2; exit 64; }
name=${KIN_GUEST_USERNAME-}
uid=${KIN_GUEST_UID-}
gid=${KIN_GUEST_GID-}
home=${KIN_GUEST_HOME-}
case "$name" in ''|[!a-z]*|*[!a-z0-9_]*) fail 'invalid guest username';; esac
[ "${#name}" -ge 3 ] && [ "${#name}" -le 24 ] || fail 'invalid guest username length'
case "$uid:$gid" in *[!0-9:]*|:*|*:) fail 'invalid guest uid or gid';; esac
[ "$uid" -ge 10000 ] && [ "$uid" -le 60000 ] && [ "$gid" -ge 10000 ] && [ "$gid" -le 60000 ] || fail 'guest uid or gid out of range'
[ "$home" = "/home/$name" ] || fail 'guest home does not match username'
[ "$(id -u)" = 0 ] || fail 'account initialization must run as root'
[ ! -L "$home" ] && [ -d "$home" ] || fail 'guest home must be an instance-owned directory mount'
[ -d /run/kin-account ] && [ ! -L /run/kin-account ] || fail 'private account tmpfs missing'
chmod 700 /run/kin-account
umask 077
for file in passwd group shadow; do
  [ ! -L "/run/kin-account/$file" ] || fail 'unexpected account file symlink'
  cp "/usr/local/share/kin-account/$file" "/run/kin-account/$file"
done
chmod 644 /run/kin-account/passwd /run/kin-account/group
chmod 600 /run/kin-account/shadow
if getent passwd "$name" >/dev/null || getent passwd "$uid" >/dev/null || getent group "$name" >/dev/null || getent group "$gid" >/dev/null; then
  fail 'guest username or numeric identity conflicts with image account'
fi
printf '%s:x:%s:\n' "$name" "$gid" >> /run/kin-account/group
printf '%s:x:%s:%s::%s:/bin/bash\n' "$name" "$uid" "$gid" "$home" >> /run/kin-account/passwd
printf '%s:!:0:0:99999:7:::\n' "$name" >> /run/kin-account/shadow
[ "$(id -u "$name")" = "$uid" ] && [ "$(id -g "$name")" = "$gid" ] || fail 'guest account readback mismatch'
chown "$uid:$gid" "$home"
[ "$(stat -c %u "$home")" = "$uid" ] && [ "$(stat -c %g "$home")" = "$gid" ] || fail 'guest home ownership mismatch'
# NSS must traverse this instance-private directory; shadow remains root-only.
chmod 755 /run/kin-account
export HOME="$home" USER="$name" LOGNAME="$name"
unset KIN_GUEST_USERNAME KIN_GUEST_UID KIN_GUEST_GID KIN_GUEST_HOME
# Changing all real/effective IDs drops permitted/effective caps; no-new-privs prevents reacquisition.
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs /bin/sh -c 'cd "$HOME" && exec "$@"' kin-account "$@"

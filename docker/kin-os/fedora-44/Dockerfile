# Candidate Linux userland. A successful image build is not artifact support.
FROM fedora:44@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
ENV LANG=en_US.UTF-8
ENV PATH=/usr/local/lib/nodejs/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LABEL org.vm2api.artifact="linux-userland-image" \
      org.vm2api.support="candidate" \
      org.vm2api.base-digest="sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80"
RUN dnf upgrade -y --refresh \
 && dnf install -y --setopt=install_weak_deps=False \
      ca-certificates curl git tzdata python3 bash procps-ng shadow-utils util-linux glibc-langpack-en glibc-locale-source \
 && localedef -c -i en_US -f UTF-8 en_US.UTF-8 \
 && dnf clean all \
 && rm -rf /var/cache/dnf \
 && groupadd -g 987 kincli \
 && useradd -u 999 -g 987 -d /home/kincli -m -s /bin/bash kincli \
 && echo "fedora-44" > /etc/kin-os \
 && echo "claude-code=2.1.284" > /etc/kin-claude
COPY --chmod=0755 common/account-entrypoint.sh /usr/local/bin/kin-account-entrypoint
RUN mkdir -p /usr/local/share/kin-account \
 && cp /etc/passwd /etc/group /etc/shadow /usr/local/share/kin-account/ \
 && chmod 600 /usr/local/share/kin-account/shadow \
 && ln -sf /run/kin-account/passwd /etc/passwd \
 && ln -sf /run/kin-account/group /etc/group \
 && ln -sf /run/kin-account/shadow /etc/shadow
LABEL org.vm2api.account-contract="linux-account-v2"
WORKDIR /home/kincli
ENTRYPOINT ["/usr/local/bin/kin-account-entrypoint"]
CMD ["sleep", "infinity"]

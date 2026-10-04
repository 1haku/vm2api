# Candidate Linux userland. A successful image build is not artifact support.
FROM debian:13@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c
ENV DEBIAN_FRONTEND=noninteractive LANG=en_US.UTF-8
ENV PATH=/usr/local/lib/nodejs/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LABEL org.vm2api.artifact="linux-userland-image" \
      org.vm2api.support="candidate" \
      org.vm2api.base-digest="sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tzdata python3 bash procps passwd util-linux locales \
 && sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
 && locale-gen en_US.UTF-8 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && groupadd -g 987 kincli \
 && useradd -u 999 -g 987 -d /home/kincli -m -s /bin/bash kincli \
 && echo "debian-13" > /etc/kin-os \
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

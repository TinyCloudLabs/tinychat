FROM dstacktee/dstack-ingress:20250924@sha256:40429d78060ef3066b5f93676bf3ba7c2e9ac47d4648440febfdda558aed4b32

RUN mv /scripts/entrypoint.sh /scripts/entrypoint-original.sh

# The base entrypoint generates the nginx server block with
# `ssl_ecdh_curve secp384r1;`, so X25519-first clients (browsers, curl, Bun)
# pay a HelloRetryRequest round trip on every new connection. Offer X25519 and
# P-256 first; P-384 stays allowed, so this is not a security downgrade. The
# checks fail the build if the base image changes this line.
RUN test "$(grep -cF 'ssl_ecdh_curve secp384r1;' /scripts/entrypoint-original.sh)" = 1 \
    && sed -i 's#ssl_ecdh_curve secp384r1;#ssl_ecdh_curve X25519:prime256v1:secp384r1;#' /scripts/entrypoint-original.sh \
    && test "$(grep -cF 'ssl_ecdh_curve X25519:prime256v1:secp384r1;' /scripts/entrypoint-original.sh)" = 1 \
    && ! grep -qF 'ssl_ecdh_curve secp384r1;' /scripts/entrypoint-original.sh

COPY entrypoint.sh /scripts/entrypoint.sh
RUN chmod +x /scripts/entrypoint.sh /scripts/entrypoint-original.sh

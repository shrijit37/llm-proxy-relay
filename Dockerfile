FROM oven/bun:1.4

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*

# Static aarch64 build of the rotating CONNECT egress daemon.
ARG UC_VERSION=0.3.6
ARG UC_ARCH=arm64
RUN curl -fsSL "https://github.com/0xdfuzz/unlimitedcode/releases/download/v${UC_VERSION}/unlimitedcode_${UC_VERSION}_linux_${UC_ARCH}" \
      -o /usr/local/bin/unlimitedcode \
 && chmod +x /usr/local/bin/unlimitedcode

# Zen Proxy upstream (public repo used by its own installer).
RUN mkdir -p /app/zen-proxy \
 && curl -fsSL "https://codeload.github.com/12errh/zen-proxy/tar.gz/refs/heads/main" -o /tmp/zen.tar.gz \
 && tar -xzf /tmp/zen.tar.gz -C /app/zen-proxy --strip-components=1 \
 && rm /tmp/zen.tar.gz

COPY entrypoint.sh /entrypoint.sh
COPY run.mjs /app/run.mjs
RUN chmod +x /entrypoint.sh

ENV HOST=0.0.0.0 \
    PORT=8787 \
    HTTPS_PROXY=http://127.0.0.1:42987 \
    HTTP_PROXY=http://127.0.0.1:42987 \
    https_proxy=http://127.0.0.1:42987 \
    http_proxy=http://127.0.0.1:42987 \
    NO_PROXY=localhost,127.0.0.1,::1 \
    no_proxy=localhost,127.0.0.1,::1 \
    UNLIMITEDCODE_HOME=/app/.state/unlimitedcode

WORKDIR /app/zen-proxy
EXPOSE 8787
ENTRYPOINT ["/entrypoint.sh"]

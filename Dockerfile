FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/github/package.json ./packages/github/
COPY packages/github-action/package.json ./packages/github-action/
COPY packages/azure-devops/package.json ./packages/azure-devops/
COPY packages/gitlab/package.json ./packages/gitlab/
COPY packages/dashboard/package.json ./packages/dashboard/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm -r build


FROM node:22-slim AS runtime

WORKDIR /app

ARG OPENGREP_VERSION=v1.19.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git python3 python3-pip \
    && curl -fsSL -o /usr/local/bin/opengrep \
       "https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/opengrep_manylinux_x86" \
    && chmod +x /usr/local/bin/opengrep \
    && opengrep --version \
    && pip3 install --target="/root/.cache/opengrep/${OPENGREP_VERSION}" \
       charset-normalizer==3.4.1 chardet==5.2.0 \
    && apt-get purge -y curl python3-pip \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/github/package.json ./packages/github/
COPY packages/github-action/package.json ./packages/github-action/
COPY packages/azure-devops/package.json ./packages/azure-devops/
COPY packages/gitlab/package.json ./packages/gitlab/
COPY packages/dashboard/package.json ./packages/dashboard/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/github/dist ./packages/github/dist
COPY --from=build /app/packages/github-action/dist ./packages/github-action/dist
COPY --from=build /app/packages/azure-devops/dist ./packages/azure-devops/dist
COPY --from=build /app/packages/gitlab/dist ./packages/gitlab/dist
COPY --from=build /app/packages/dashboard/dist ./packages/dashboard/dist

# copy prompt files that are bundled alongside dist
COPY --from=build /app/packages/core/src/prompts ./packages/core/dist/prompts

RUN mkdir -p /app/data /home/rusty \
    && groupadd --system --gid 1001 rusty \
    && useradd --system --uid 1001 --gid rusty --home-dir /home/rusty --shell /usr/sbin/nologin rusty \
    && chown -R rusty:rusty /app /home/rusty

VOLUME /app/data

ENV PORT=3000
ENV RUSTY_DB_URL=file:/app/data/rusty.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

COPY <<'EOF' /app/entrypoint.sh
#!/bin/sh
set -e
case "$RUSTY_MODE" in
  pipeline)
    exec node /app/packages/azure-devops/dist/index.js
    ;;
  github-action)
    exec node /app/packages/github-action/dist/cli.js
    ;;
  gitlab)
    exec node /app/packages/gitlab/dist/cli.js
    ;;
  *)
    exec node /app/packages/github/dist/server-main.js
    ;;
esac
EOF

RUN chmod +x /app/entrypoint.sh

# Default to root so CI container handlers (GitHub Actions, Azure Pipelines)
# can run their in-container agent setup (groupadd, sudo provisioning) on
# `docker exec`. Long-lived webhook deployments should drop privileges by
# passing `--user rusty` (or `user: rusty` in compose) — the rusty user
# is already created above with /app chowned to it.
ENTRYPOINT ["/app/entrypoint.sh"]

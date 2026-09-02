#!/usr/bin/env node

import fs from "node:fs";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error("usage: render-stable-runtime-dockerfile.mjs SOURCE OUTPUT");
}

const source = fs.readFileSync(sourcePath === "-" ? 0 : sourcePath, "utf8");
const marker = /^FROM base-runtime\s*$/gmu;
const matches = [...source.matchAll(marker)];
if (matches.length !== 1) {
  throw new Error(`expected one final base-runtime stage, found ${matches.length}`);
}
if (source.includes("/opt/openclaw-plugin-runtime")) {
  throw new Error("upstream Dockerfile unexpectedly owns the downstream plugin runtime path");
}

const upstream = source.replace(marker, "FROM base-runtime AS upstream-runtime");
const runtimeLayer = String.raw`

# Package exact source-matched runtime dependencies without changing upstream source.
# The compatibility prefix is retained only for the 14-day rollback window.
FROM upstream-runtime AS production
ARG OPENCLAW_VERSION
USER root
RUN set -eu; \
    test "$(node -p "require('/app/package.json').version")" = "$OPENCLAW_VERSION"; \
    install -d -m 0755 /opt/openclaw-plugin-runtime /tmp/openclaw-plugin-packs; \
    codex_pack="$(npm pack /app/extensions/codex --pack-destination /tmp/openclaw-plugin-packs --silent)"; \
    discord_pack="$(npm pack /app/extensions/discord --pack-destination /tmp/openclaw-plugin-packs --silent)"; \
    llama_pack="$(npm pack /app/extensions/llama-cpp --pack-destination /tmp/openclaw-plugin-packs --silent)"; \
    node -e 'require("node:fs").writeFileSync("/opt/openclaw-plugin-runtime/package.json", JSON.stringify({name:"openclaw-source-matched-plugin-runtime",private:true})+"\n")'; \
    npm install --prefix /opt/openclaw-plugin-runtime \
      --install-strategy=nested --omit=dev --ignore-scripts=false --no-audit --no-fund \
      "/tmp/openclaw-plugin-packs/$codex_pack" \
      "/tmp/openclaw-plugin-packs/$discord_pack" \
      "/tmp/openclaw-plugin-packs/$llama_pack"; \
    install -d -m 0700 /tmp/codex-runtime-lock; \
    node -e 'const fs=require("node:fs"); const source="/opt/openclaw-plugin-runtime/node_modules/@openclaw/codex/package.json"; const manifest=JSON.parse(fs.readFileSync(source,"utf8")); fs.writeFileSync("/tmp/codex-runtime-lock/package.json",JSON.stringify({name:manifest.name,version:manifest.version,dependencies:manifest.dependencies})+"\n",{mode:0o600});'; \
    npm --prefix /tmp/codex-runtime-lock install \
      --package-lock-only --ignore-scripts --offline --omit=dev --no-audit --no-fund; \
    mv /tmp/codex-runtime-lock/package-lock.json \
      /opt/openclaw-plugin-runtime/node_modules/@openclaw/codex/npm-shrinkwrap.json; \
    rm -rf /tmp/codex-runtime-lock; \
    node -e 'const fs=require("node:fs"),path=require("node:path"); const root="/opt/openclaw-plugin-runtime/node_modules"; const expected=[["@openclaw/codex","@openai/codex","0.151.0"],["@openclaw/discord","@discordjs/voice","0.19.2"],["@openclaw/discord","discord-api-types","0.38.53"],["@openclaw/discord","libopus-wasm","0.2.0"],["@openclaw/llama-cpp-provider","jszip","3.10.1"],["@openclaw/llama-cpp-provider","tar","7.5.22"]]; for(const plugin of ["@openclaw/codex","@openclaw/discord","@openclaw/llama-cpp-provider"]){const manifest=JSON.parse(fs.readFileSync(path.join(root,plugin,"package.json"),"utf8")); if(manifest.version!==process.env.OPENCLAW_VERSION)throw new Error(plugin+" version "+manifest.version);} for(const [plugin,name,version] of expected){const actual=JSON.parse(fs.readFileSync(path.join(root,plugin,"node_modules",name,"package.json"),"utf8")).version; if(actual!==version)throw new Error(name+" version "+actual);}' ; \
    for plugin in @openclaw/codex @openclaw/discord @openclaw/llama-cpp-provider; do \
      ln -s /app "/opt/openclaw-plugin-runtime/node_modules/$plugin/node_modules/openclaw"; \
    done; \
    chmod -R go-w /opt/openclaw-plugin-runtime; \
    rm -rf /tmp/openclaw-plugin-packs /root/.npm
USER node
`;

const rendered = `${upstream.trimEnd()}${runtimeLayer}`;
if (outputPath === "-") {
  process.stdout.write(rendered);
} else {
  fs.writeFileSync(outputPath, rendered);
}

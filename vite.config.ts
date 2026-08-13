import { readFile } from "node:fs/promises";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const teleprotoBrowserSources = /teleproto[\\/](?:Helpers|client[\\/](?:downloads|uploads)|tl[\\/]custom[\\/]file)\.js$/;
const unsafeWriteStreamCheck = "writer instanceof fs.WriteStream";
const safeWriteStreamCheck =
  'typeof fs.WriteStream === "function" && writer instanceof fs.WriteStream';

function replaceExpected(source: string, unsafe: string, safe: string, expected: number, label: string) {
  if (source.includes(safe)) return source;
  const matches = source.split(unsafe).length - 1;
  if (matches !== expected) {
    throw new Error(`Expected ${expected} ${label} match${expected === 1 ? "" : "es"}, found ${matches}. Recheck the browser fixes after upgrading Teleproto.`);
  }
  return source.replaceAll(unsafe, safe);
}

function patchTeleprotoSource(source: string, path: string) {
  if (/[\\/]client[\\/]downloads\.js$/.test(path)) {
    return replaceExpected(source, unsafeWriteStreamCheck, safeWriteStreamCheck, 2, "download WriteStream");
  }

  if (/[\\/]Helpers\.js$/.test(path)) {
    return replaceExpected(
      source,
      "setTimeout(resolve, ms).unref()",
      "setTimeout(resolve, ms).unref?.()",
      1,
      "timer unref",
    );
  }

  if (/[\\/]tl[\\/]custom[\\/]file\.js$/.test(path)) {
    return replaceExpected(
      source,
      "if (attr instanceof cls) {",
      'if ((Array.isArray(cls) ? cls : [cls]).some((candidate) => typeof candidate === "function" && attr instanceof candidate)) {',
      1,
      "custom file attribute",
    );
  }

  if (/[\\/]client[\\/]uploads\.js$/.test(path)) {
    let patched = replaceExpected(
      source,
      "const { buffer, filePath } = this.options;\n        if (buffer) {",
      "const { buffer, filePath, browserFile } = this.options;\n        if (browserFile) {\n            return Buffer.from(await browserFile.slice(begin, end).arrayBuffer());\n        }\n        else if (buffer) {",
      1,
      "browser upload buffer",
    );
    patched = replaceExpected(
      patched,
      "const options = {};\n    if (fileSize > maxBufferSize && file instanceof CustomFile) {",
      'const options = {};\n    if (typeof File !== "undefined" && file instanceof File) {\n        options.browserFile = file;\n    }\n    else if (fileSize > maxBufferSize && file instanceof CustomFile) {',
      1,
      "browser upload source",
    );
    return replaceExpected(
      patched,
      "let res = utils.getAttributes(file, {\n            mimeType: mimeType,",
      'if (!mimeType && typeof file === "object" && typeof file.type === "string" && file.type) {\n            mimeType = file.type;\n        }\n        let res = utils.getAttributes(file, {\n            mimeType: mimeType,',
      1,
      "browser upload MIME",
    );
  }

  return source;
}

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    {
      name: "teleproto-browser-fixes",
      enforce: "pre",
      transform(source, id) {
        if (id.startsWith("\0")) return null;
        const file = id.split("?", 1)[0];
        if (!teleprotoBrowserSources.test(file)) return null;
        return { code: patchTeleprotoSource(source, file), map: null };
      },
    },
    react(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
    {
      name: "development-csp",
      transformIndexHtml(html) {
        if (command !== "serve") return html;
        return html
          .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
          .replace("connect-src 'self' wss://*.web.telegram.org;", "connect-src 'self' ws: wss://*.web.telegram.org;");
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: "teleproto-browser-fixes",
          setup(build) {
            build.onLoad({ filter: teleprotoBrowserSources }, async ({ path }) => ({
              contents: patchTeleprotoSource(await readFile(path, "utf8"), path),
              loader: "js",
            }));
          },
        },
      ],
    },
  },
}));

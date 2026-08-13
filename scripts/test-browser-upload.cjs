const assert = require("node:assert/strict");
const path = require("node:path");
const { File } = require("node:buffer");

globalThis.File = File;

const { uploadFile } = require(path.join(__dirname, "..", "node_modules", "teleproto", "client", "uploads.js"));

async function main() {
  const expected = Buffer.from("real browser file bytes: desktop ios android");
  const saved = [];
  const progress = [];
  const client = {
    session: { dcId: 2 },
    _media: {
      opts: { upload: { maxSessions: 1, maxWindow: 512 * 1024 } },
      savePart: async (dcId, request, signal) => {
        assert.equal(dcId, 2);
        assert.equal(signal.aborted, false);
        saved[request.filePart] = Buffer.from(request.bytes);
      },
    },
  };
  const file = new File([expected], "Screenshot From Desktop.png", { type: "image/png" });
  const handle = await uploadFile(client, {
    file,
    workers: 1,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(handle.name, file.name);
  assert.deepEqual(Buffer.concat(saved), expected);
  assert.equal(progress.at(0), 0);
  assert.ok(progress.at(-1) >= 1);
  process.stdout.write(`Browser upload passed: ${saved.length} part, ${expected.length} exact bytes, ${handle.name}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

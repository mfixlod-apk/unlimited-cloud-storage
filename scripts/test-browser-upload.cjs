const assert = require("node:assert/strict");
const path = require("node:path");
const { File } = require("node:buffer");

globalThis.File = File;

const { uploadFile } = require(path.join(__dirname, "..", "node_modules", "teleproto", "client", "uploads.js"));

async function main() {
  const expected = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
  const saved = [];
  const progress = [];
  let activeParts = 0;
  let maximumActiveParts = 0;
  const client = {
    session: { dcId: 2 },
    _media: {
      opts: { upload: { maxSessions: 1, maxWindow: 512 * 1024 } },
      savePart: async (dcId, request, signal) => {
        assert.equal(dcId, 2);
        assert.equal(signal.aborted, false);
        activeParts += 1;
        maximumActiveParts = Math.max(maximumActiveParts, activeParts);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          saved[request.filePart] = Buffer.from(request.bytes);
        } finally {
          activeParts -= 1;
        }
      },
    },
  };
  const file = new File([expected], "Screenshot From Desktop.png", { type: "image/png" });
  const handle = await uploadFile(client, {
    file,
    workers: 3,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(handle.name, file.name);
  assert.deepEqual(Buffer.concat(saved), expected);
  assert.equal(progress.at(0), 0);
  assert.ok(progress.at(-1) >= 1);
  assert.ok(maximumActiveParts > 1);
  assert.ok(maximumActiveParts <= 3);
  process.stdout.write(`Browser upload passed: ${saved.length} exact parts, ${maximumActiveParts} concurrent, ${expected.length} bytes, ${handle.name}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

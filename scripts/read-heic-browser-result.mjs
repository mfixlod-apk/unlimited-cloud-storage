const targetUrl = process.argv[2];
if (!targetUrl) throw new Error("Pass the HEIC smoke-test URL.");

const target = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" }).then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
let requestId = 0;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++requestId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const deadline = Date.now() + 30_000;
let text = "RUNNING";
while (text === "RUNNING" && Date.now() < deadline) {
  const response = await send("Runtime.evaluate", {
    expression: 'document.querySelector("#result")?.textContent || "RUNNING"',
    returnByValue: true,
  });
  text = response.result?.value || "RUNNING";
  if (text === "RUNNING") await new Promise((resolve) => setTimeout(resolve, 100));
}
socket.close();
console.log(text);
if (!text.startsWith("PASS image/jpeg ")) process.exitCode = 1;

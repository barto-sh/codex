// Real composer runs through native ConPTY. Only synthetic text reaches the local HTTP receiver.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {
  Probe,
  payload,
  ROOT,
  sleep,
  sha,
  terminalPaste,
} = require("./probe.cjs");
async function main() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.includes("/responses")) {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: {
              id: "resp_local_paste",
              object: "response",
              status: "in_progress",
              output: [],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_local_paste",
              object: "response",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          },
        ])
          res.write("data: " + JSON.stringify(event) + "\n\n");
        res.end();
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const t = new Probe(process.argv[2], [
    "-c",
    `model_providers.paste_diagnostic.base_url="http://127.0.0.1:${server.address().port}/v1"`,
  ]);
  const rows = [];
  const save = () =>
    fs.writeFileSync(
      path.join(ROOT, "node-functional-results.json"),
      JSON.stringify(rows, null, 2),
    );
  async function expect(label, expected) {
    const meta = await t.capture();
    const row = {
      case: label,
      exact: meta.received_sha256 === sha(expected),
      received_bytes: meta.received_bytes,
    };
    rows.push(row);
    save();
    console.log(JSON.stringify(row));
    if (!row.exact) throw Error("Full text mismatch: " + label);
  }
  async function paste(text) {
    t.write("\x1b[200~" + terminalPaste(text) + "\x1b[201~");
    await sleep(250);
  }
  async function markedPaste(text, marker) {
    const start = performance.now();
    t.write("\x1b[200~" + terminalPaste(text) + "\x1b[201~");
    t.write("\x05" + marker);
    await t.wait(() => t.visible().includes(marker), 30000);
    return performance.now() - start;
  }
  try {
    await t.start();
    await t.clear();
    const unicode = "Zażółć gęślą jaźń 🦀🥚\nDruga linia\tTAB|END";
    await paste(unicode);
    await expect("Unicode, emoji, LF and tab", unicode);
    await t.clear();
    const boundaryText = "\n\nZażółć 界 🦀\r\n\t\nEND\n\n",
      boundaryMarker = "BOUNDARY_READY_9d7";
    for (const part of ["\x1b", "[2", "00~"]) {
      t.write(part);
      await sleep(3);
    }
    t.write(terminalPaste(boundaryText));
    // A gap exceeding the legacy burst timer must not terminate a framed paste.
    await sleep(200);
    for (const part of ["\x1b[", "20", "1~"]) {
      t.write(part);
      await sleep(3);
    }
    t.write("\x05" + boundaryMarker);
    await t.wait(() => t.visible().includes(boundaryMarker), 30000);
    await expect(
      "Fragmented boundaries, delayed close, leading and trailing empty lines",
      boundaryText.replaceAll("\r\n", "\n") + boundaryMarker,
    );
    await t.clear();
    const crlf = "Pierwsza\r\nDruga\r\n\r\nTrzecia\nLF\tEND",
      crlfMarker = "CRLF_READY_9d7";
    await markedPaste(crlf, crlfMarker);
    await expect(
      "CRLF and LF normalize without losing lines",
      crlf.replaceAll("\r\n", "\n") + crlfMarker,
    );
    await t.clear();
    const repeated = "aaaa     bbbb\n\n\t".repeat(1000) + "END";
    await paste(repeated);
    await expect("Repeated spaces, empty lines and indentation", repeated);
    await t.clear();
    await markedPaste("X".repeat(65536) + "END", "PURE_READY_9d7");
    await expect(
      "Identical character run",
      "X".repeat(65536) + "ENDPURE_READY_9d7",
    );
    await t.clear();
    await paste("left|right");
    t.write("\x1b[D".repeat(5));
    await sleep(100);
    await paste("ŚRODEK");
    await expect(
      "Paste at middle cursor preserves both sides",
      "left|ŚRODEKright",
    );
    await t.clear();
    const unwrapped = payload(65536, true),
      rawMarker = "RAW_READY_9d7";
    t.write(terminalPaste(unwrapped));
    t.write("\x05" + rawMarker);
    await t.wait(() => t.visible().includes(rawMarker), 30000);
    await expect(
      "Unbracketed Windows character-stream paste",
      unwrapped + rawMarker,
    );
    await t.clear();
    let accumulated = "";
    for (let i = 0; i < 3; i++) {
      const text = payload(i === 0 ? 262144 : 65536, true),
        marker = "FOLLOW_" + i + "_9d7";
      const ready_ms = await markedPaste(text, marker);
      accumulated += text + marker;
      await expect("Large paste " + (i + 1) + " in one draft", accumulated);
      rows[rows.length - 1].ready_ms = ready_ms;
      save();
    }
    t.proc.resize(48, 16);
    t.term.resize(48, 16);
    await sleep(200);
    await expect(
      "Narrow resize preserves the complete large draft",
      accumulated,
    );
    t.proc.resize(100, 32);
    t.term.resize(100, 32);
    await sleep(200);
    t.write("Z");
    await sleep(200);
    t.write("\x7f");
    await sleep(200);
    await expect(
      "Typing and Backspace after largest and repeated pastes",
      accumulated,
    );
    await paste("");
    await expect("Empty terminal paste preserves existing draft", accumulated);
    await t.clear();
    await paste("cancel this draft");
    t.write("\x03");
    await sleep(300);
    await expect("Ctrl+C clears draft without closing CLI", "");
    await paste("READY");
    await expect("Editing after cancellation", "READY");
    await t.clear();
    const leadingCommand = "/quit\n!echo NEVER_EXECUTED\nEND";
    await paste(leadingCommand);
    await expect(
      "Leading slash-command multiline paste does not execute on paste",
      leadingCommand,
    );
    await t.clear();
    const submitted =
      "synthetic command-like lines\n/quit\n!echo NEVER_EXECUTED\nEND";
    await paste(submitted);
    await expect(
      "Multiline command-like paste remains literal before Enter",
      submitted,
    );
    await sleep(300);
    const no_auto_submit = requests.length === 0;
    rows.push({
      case: "No automatic model submission",
      verified: no_auto_submit,
      post_requests: requests.length,
    });
    save();
    if (!no_auto_submit) throw Error("Paste submitted without Enter");
    t.write("\r");
    await t.wait(() => requests.length > 0, 30000);
    const strings = [];
    function collect(value) {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object")
        Object.values(value).forEach(collect);
    }
    // Examine input only, never instructions or runtime environment metadata.
    collect(requests[0].input);
    const exact = strings.includes(submitted);
    rows.push({
      case: "Explicit Enter sends complete synthetic prompt to local receiver",
      exact,
      post_requests: requests.length,
    });
    save();
    if (!exact) throw Error("Submitted prompt mismatch");
    console.log(JSON.stringify(rows.slice(-2)));
  } finally {
    await t.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.stack);
    process.exit(1);
  },
);

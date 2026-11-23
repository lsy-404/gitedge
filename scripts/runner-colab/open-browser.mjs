import { spawn } from "node:child_process";

// colab-mcp opens its page through Python's webbrowser, which runs this via BROWSER; the marker lets the
// GitEdge Colab extension confirm only the connections the waker started.
const url = new URL(process.argv[2]);
if (url.origin !== "https://colab.research.google.com") process.exit(1);
url.searchParams.set("gitedge-waker", "1");
const target = url.href;
const [command, args] =
  process.platform === "darwin"
    ? ["open", [target]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
      : ["xdg-open", [target]];
const child = spawn(command, args, { stdio: "ignore", detached: true });
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));

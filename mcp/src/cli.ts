#!/usr/bin/env node
/** `horizon-pulse setup [...]` runs the client setup; anything else starts the stdio MCP server. */
const [, , cmd, ...rest] = process.argv;
if (cmd === "setup") {
  const { runSetup, parseArgs, HELP } = await import("./setup.js");
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(HELP);
    process.exit(2);
  }
  process.exit(await runSetup(opts));
} else if (cmd === "--help" || cmd === "-h") {
  const { HELP } = await import("./setup.js");
  console.log("horizon-pulse            start the local stdio MCP server (pays x402 from HP_PRIVATE_KEY, capped)\n" + HELP);
} else {
  await import("./index.js");
}

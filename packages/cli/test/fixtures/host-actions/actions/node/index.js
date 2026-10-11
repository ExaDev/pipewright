// Writes the effect a host run is asserted on, so the test checks what the action really received.
const fs = require("node:fs");
const text = process.env.INPUT_TEXT;
if (text === undefined) throw new Error("INPUT_TEXT was not supplied");
fs.writeFileSync("node.txt", `${text}\n`);

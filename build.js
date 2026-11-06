// Cross-platform equivalent of build.sh (byte-identical output): node build.js
// artifact.html : page content only (claude.ai adds the document skeleton)
// index.html    : standalone document for running locally (declares UTF-8)
const fs = require("fs");
const path = require("path");
const read = f => fs.readFileSync(path.join(__dirname, f), "utf8");
const write = (f, s) => fs.writeFileSync(path.join(__dirname, f), s, "utf8");

const artifact = read("shell.html") + "<script>\n" + read("engine.js") + "\n" + read("ui.js") + "</script>\n";
write("artifact.html", artifact);
write("index.html",
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  "</head>\n<body>\n" + artifact + "\n</body>\n</html>\n");
console.log("built artifact.html and index.html");

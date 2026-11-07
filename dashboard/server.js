// Tiny zero-dependency static server for the dashboard.
//   node dashboard/server.js   (or: npm run dashboard)  ->  http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const routes = {
  "/": "dashboard/index.html",
  "/app.js": "dashboard/app.js",
  "/style.css": "dashboard/style.css",
  "/ethers.js": "node_modules/ethers/dist/ethers.umd.min.js",
  "/seed.json": "dashboard/data/seed.json",
};
const abis = ["RoleManager", "ParcelRegistry", "LienRegistry", "TransferManager", "DisputeRegistry", "StateAnchor"];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/abis.json") {
    const out = {};
    for (const n of abis) out[n] = JSON.parse(fs.readFileSync(path.join(ROOT, `artifacts/contracts/${n}.sol/${n}.json`))).abi;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  const file = routes[url];
  if (!file || !fs.existsSync(path.join(ROOT, file))) { res.writeHead(404); return res.end("not found (did you run scripts/seed.js?)"); }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "text/plain" });
  fs.createReadStream(path.join(ROOT, file)).pipe(res);
}).listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}  (RPC: http://127.0.0.1:8545)`));

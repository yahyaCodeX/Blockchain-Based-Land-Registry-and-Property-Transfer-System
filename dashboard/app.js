/* global ethers */
const RPC = "http://127.0.0.1:8545";
const PSTATUS = ["None", "Pending", "Active", "Frozen"];
const TSTATE = ["None", "Initiated", "Accepted", "TaxCleared", "Completed", "Cancelled", "Rejected"];
const short = (x) => `${x.slice(0, 8)}…${x.slice(-4)}`;
const pkr = (n) => Number(n).toLocaleString("en-PK");
const pill = (t, cls = t) => `<span class="pill ${cls}">${t}</span>`;

async function main() {
  const [seed, abis] = await Promise.all([fetch("/seed.json").then((r) => r.json()), fetch("/abis.json").then((r) => r.json())]);
  const provider = new ethers.JsonRpcProvider(RPC);
  const c = {};
  for (const [n, a] of Object.entries(seed.contracts)) c[n] = new ethers.Contract(a, abis[n], provider);
  const name = (id) => seed.directory[id] || short(id);
  const kh = (pid) => (seed.labels[pid] ? seed.labels[pid].khasra : short(pid));

  const net = await provider.getNetwork();
  const block = await provider.getBlockNumber();
  document.getElementById("net").textContent = `chainId ${net.chainId} · block #${block} · ${seed.network}`;

  // parcels from ParcelProposed events
  const proposed = await c.ParcelRegistry.queryFilter(c.ParcelRegistry.filters.ParcelProposed());
  const pids = [...new Set(proposed.map((e) => e.args.parcelId))];
  const parcels = [];
  for (const id of pids) {
    const p = await c.ParcelRegistry.getParcel(id);
    if (Number(p.status) === 0) continue;
    parcels.push({ id, ...p.toObject(), lien: await c.LienRegistry.isEncumbered(id) });
  }
  // transfers, liens, cases
  const tc = Number(await c.TransferManager.transferCount());
  const transfers = []; for (let i = 1; i <= tc; i++) transfers.push({ i, ...(await c.TransferManager.getTransfer(i)).toObject() });
  const lc = Number(await c.LienRegistry.lienCount());
  const lienList = []; for (let i = 1; i <= lc; i++) lienList.push({ i, ...(await c.LienRegistry.getLien(i)).toObject() });
  const cc = Number(await c.DisputeRegistry.caseCount());
  const cases = []; for (let i = 1; i <= cc; i++) cases.push({ i, ...(await c.DisputeRegistry.getCase(i)).toObject() });

  // KPIs
  const k = [
    [parcels.filter((p) => Number(p.status) === 2).length, "Active parcels"],
    [parcels.filter((p) => Number(p.status) === 1).length, "Pending approval"],
    [parcels.filter((p) => Number(p.status) === 3).length, "Frozen by court"],
    [transfers.filter((t) => [1, 2, 3].includes(Number(t.state))).length, "Open sales"],
    [transfers.filter((t) => Number(t.state) === 4).length, "Completed sales"],
    [lienList.filter((l) => l.active).length, "Active liens"],
  ];
  document.getElementById("kpis").innerHTML = k.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join("");

  document.querySelector("#parcels tbody").innerHTML = parcels.map((p) => {
    const st = PSTATUS[Number(p.status)];
    return `<tr><td><b>${kh(p.id)}</b></td><td>${seed.labels[p.id]?.place || ""}</td><td>${name(p.ownerId)}</td><td>${pkr(p.areaSqFt)}</td><td>${pill(st)}</td><td>v${p.version}</td><td>${p.lien ? pill("Mortgaged", "Active-lien") : "—"}</td></tr>`;
  }).join("");

  document.querySelector("#transfers tbody").innerHTML = transfers.map((t) => {
    const st = TSTATE[Number(t.state)];
    return `<tr><td>${t.i}</td><td>${kh(t.parcelId)}</td><td>${name(t.sellerId)} → ${name(t.buyerId)}</td><td>${pkr(t.pricePkr)}</td><td>${pill(st)}</td></tr>`;
  }).join("");

  document.querySelector("#encumb tbody").innerHTML =
    lienList.map((l) => `<tr><td>Lien #${l.i}</td><td>${kh(l.parcelId)}</td><td>Bank ${short(l.bank)} · PKR ${pkr(l.amountPkr)}</td><td>${pill(l.active ? "Active" : "Released", l.active ? "Active-lien" : "Released")}</td></tr>`).join("") +
    cases.map((x) => `<tr><td>Case #${x.i}</td><td>${kh(x.parcelId)}</td><td>Court ${short(x.court)} · ref ${short(x.caseRefHash)}</td><td>${pill(x.open ? "Open" : "Closed")}</td></tr>`).join("");

  // audit trail
  const ev = await c.ParcelRegistry.queryFilter(c.ParcelRegistry.filters.OwnershipChanged());
  document.getElementById("audit").innerHTML = ev.map((e) => {
    const byCourt = e.args.module.toLowerCase() === seed.contracts.DisputeRegistry.toLowerCase();
    return `<li class="${byCourt ? "court" : ""}"><b>${kh(e.args.parcelId)}</b> v${e.args.version}: ${name(e.args.fromId)} → ${name(e.args.toId)}
      <small>${byCourt ? "court decree (DisputeRegistry)" : "sale (TransferManager)"} · block #${e.blockNumber} · doc ${short(e.args.docHash)}</small></li>`;
  }).join("");

  document.querySelector("#contracts tbody").innerHTML = Object.entries(seed.contracts).map(([n, a]) => `<tr><td>${n}</td><td><code>${short(a)}</code></td></tr>`).join("");
  if (Number(await c.StateAnchor.checkpointCount()) > 0) {
    const cp = await c.StateAnchor.latest();
    document.getElementById("anchor").innerHTML = `Latest public checkpoint: consortium block #${cp.consortiumBlock} · root <code>${short(cp.parcelsMerkleRoot)}</code>`;
  }

  // bank verification form
  const vP = document.getElementById("vParcel"), vO = document.getElementById("vOwner");
  vP.innerHTML = parcels.map((p) => `<option value="${p.id}">${kh(p.id)} · ${seed.labels[p.id]?.place || ""}</option>`).join("");
  vO.innerHTML = Object.entries(seed.directory).map(([id, n]) => `<option value="${id}">${n}</option>`).join("");
  document.getElementById("vBtn").onclick = async () => {
    const [owns, status, version] = await c.ParcelRegistry.verifyOwnership(vP.value, vO.value);
    const enc = await c.LienRegistry.isEncumbered(vP.value);
    const out = document.getElementById("vOut");
    out.className = "result " + (owns && !enc ? "ok" : "no");
    out.innerHTML = owns
      ? `✔ ${vO.selectedOptions[0].text} owns ${kh(vP.value)} (record v${version}, ${PSTATUS[Number(status)]})${enc ? "<br>⚠ Already mortgaged: an active lien exists" : "<br>No active lien: safe to register a mortgage"}`
      : `✖ Not the current owner (record status ${PSTATUS[Number(status)]}, v${version})`;
  };
}
main().catch((e) => { document.getElementById("net").textContent = "error: " + e.message; console.error(e); });

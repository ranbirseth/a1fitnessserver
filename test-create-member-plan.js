/**
 * Regression suite for the "Create Member + Initial Plan" workflow.
 *
 * Verifies that creating a member WITH an optional Initial Plan records exactly
 * one Payment and yields a consistent member state (paymentStatus / isActivePlan
 * / status / valid membership dates), while creating a member WITHOUT an
 * Initial Plan preserves the legacy behavior (no plan, pending payment, no
 * Payment record).
 *
 * Uses the isolated gymza_payflow_test DB. Self-seeds TEST-gym data deterministically.
 */

const { spawn } = require("child_process");

const BASE = "http://localhost:5009";
const TEST_DB_URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

const results = [];

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log("  [" + mark + "] " + name);
  if (!pass) console.log("    Detail: " + detail);
}

function daysFromNow(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  return dt.toISOString();
}

function dateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("node " + script + " timed out")); }, 40000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function seed() {
  const res = await runNode("seed-test-data.js");
  if (res.code !== 0) throw new Error("Seed failed: " + res.out.slice(-800));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, MONGO_URI: TEST_DB_URI, PORT: "5009", NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server start timeout")); }, 40000);
    child.stdout.on("data", (d) => {
      output += d.toString();
      if (output.includes("Server running on port 5009")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    child.on("close", (code) => { if (!output.includes("MongoDB connected")) { clearTimeout(timeout); reject(new Error("Server exited: " + output.slice(-600))); } });
  });
}

async function waitForHealth(retries = 24) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      const d = await r.json();
      if (d && d.data && d.data.dbReady) return d;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Health check failed");
}

async function login(email, password, gymId) {
  const r = await api("POST", "/api/auth/login", { gymId, email, password });
  if (r.status !== 200) throw new Error("Login failed " + email + ": " + JSON.stringify(r.data));
  return r.data.data.accessToken;
}

(async () => {
  let proc;
  try {
    console.log("=== Seeding gymza_payflow_test ===");
    await seed();
    console.log("=== Starting server ===");
    proc = await startServer();
    const health = await waitForHealth();
    console.log("Server healthy, users:", health.data.totalUsers);
    console.log("");

    const GYM = "TEST";
    const saToken = await login("sa@payflow.local", "Super123456", GYM);
    const adminAToken = await login("admin_a@payflow.local", "Admin123456", GYM);
    console.log("Authenticated: superadmin, adminA (BR_A)");

    // Resolve plan IDs
    const planRes = (await api("GET", "/api/plans?gymId=TEST", null, saToken)).data.data;
    const plansArr = Array.isArray(planRes) ? planRes : (planRes.items || []);
    const planA = plansArr.find((p) => p.name === "Basic Plan");
    const planB = plansArr.find((p) => p.name === "Premium Plan");
    if (!planA || !planB) throw new Error("Could not resolve seed plans");
    console.log("planA (Basic 30d):", planA._id, "| planB (Premium 60d):", planB._id);

    const payTotal = async () => {
      const r = await api("GET", "/api/payments?gymId=TEST", null, saToken);
      return r.data.data.total;
    };

    let testCount = 0;
    const nextName = (n) => n;

    // ════════════════════════════════════════════════════════════════════
    // T1: Create member WITHOUT Initial Plan (admin) — legacy behavior preserved
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T1: Create member WITHOUT Initial Plan (Admin) ===");
    const before1 = await payTotal();
    const noPlanR = await api("POST", "/api/members", {
      name: "No Plan Member", email: "noplan@member.local", phone: "9876543210",
      password: "Pass123456", trainerId: "", branchCode: "BR_A"
    }, adminAToken);
    const noPlanMember = noPlanR.data.data;
    const afterNoPlan = await payTotal();
    const memNoPlan = (await api("GET", "/api/members/" + noPlanMember._id, null, saToken)).data.data;
    let p1 = true, d1 = "";
    if (noPlanR.status !== 201) { p1 = false; d1 += "status=" + noPlanR.status + "; "; }
    if (memNoPlan.currentPlan) { p1 = false; d1 += "currentPlan set unexpectedly; "; }
    if (memNoPlan.paymentStatus !== "pending") { p1 = false; d1 += "paymentStatus=" + memNoPlan.paymentStatus + "; "; }
    if (memNoPlan.isActivePlan !== false) { p1 = false; d1 += "isActivePlan=" + memNoPlan.isActivePlan + "; "; }
    if (memNoPlan.membershipStartDate || memNoPlan.membershipExpiryDate) { p1 = false; d1 += "membership dates set without plan; "; }
    if (afterNoPlan !== before1) { p1 = false; d1 += "payment count " + before1 + "->" + afterNoPlan + " (expected unchanged); "; }
    record(nextName("Create member WITHOUT Initial Plan (Admin)"), p1, d1 || "All checks passed");

    // ════════════════════════════════════════════════════════════════════
    // T2: Create member WITH Initial Plan + PAID payment (admin)
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T2: Create member WITH Initial Plan + paid (Admin) ===");
    const before2 = await payTotal();
    const paidR = await api("POST", "/api/members", {
      name: "Paid Plan Member", email: "paid@member.local", phone: "9876543211",
      password: "Pass123456", trainerId: "", branchCode: "BR_A",
      planId: planA._id,
      payment: { amount: 1000, method: "cash", status: "paid", note: "Initial paid" }
    }, adminAToken);
    const paidMember = paidR.data.data;
    const paidPay = paidMember ? paidMember.payment : null;
    const afterPaid = await payTotal();
    const memPaid = (await api("GET", "/api/members/" + (paidMember && paidMember._id), null, saToken)).data.data;
    const planExpectedExpiry = new Date(); planExpectedExpiry.setDate(planExpectedExpiry.getDate() + planA.duration);
    let p2 = true, d2 = "";
    if (paidR.status !== 201) { p2 = false; d2 += "status=" + paidR.status + " " + JSON.stringify(paidR.data); }
    if (memPaid.currentPlan && memPaid.currentPlan._id !== planA._id) { p2 = false; d2 += "currentPlan not planA; "; }
    if (memPaid.paymentStatus !== "paid") { p2 = false; d2 += "paymentStatus=" + memPaid.paymentStatus + "; "; }
    if (memPaid.isActivePlan !== true) { p2 = false; d2 += "isActivePlan=" + memPaid.isActivePlan + "; "; }
    if (!memPaid.membershipStartDate || !memPaid.membershipExpiryDate) { p2 = false; d2 += "membership dates missing; "; }
    if (dateOnly(memPaid.membershipExpiryDate) !== dateOnly(planExpectedExpiry)) { p2 = false; d2 += "expiry wrong; "; }
    if (memPaid.status !== "active") { p2 = false; d2 += "status=" + memPaid.status + "; "; }
    if (!paidPay) { p2 = false; d2 += "no payment in response; "; }
    if (paidPay && paidPay.status !== "paid") { p2 = false; d2 += "pay.status=" + paidPay.status + "; "; }
    if (paidPay && String(paidPay.member) !== String(paidMember._id)) { p2 = false; d2 += "pay.member mismatch; "; }
    if (paidPay && paidPay.amount !== 1000) { p2 = false; d2 += "pay.amount=" + paidPay.amount + "; "; }
    if (afterPaid !== before2 + 1) { p2 = false; d2 += "payment count " + before2 + "->" + afterPaid + " (expected +1); "; }
    record(nextName("Create member WITH Initial Plan + paid (Admin)"), p2, d2 || "All checks passed");

    // ════════════════════════════════════════════════════════════════════
    // T3: Create member WITH Initial Plan + PAID payment (Superadmin)
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T3: Create member WITH Initial Plan + paid (Superadmin) ===");
    const before3 = await payTotal();
    const saPaidR = await api("POST", "/api/members", {
      name: "SA Paid Member", email: "sapaid@member.local", phone: "9876543212",
      password: "Pass123456", trainerId: "", branchCode: "BR_A",
      planId: planB._id,
      payment: { amount: 2500, method: "upi", status: "paid", note: "SA initial paid" }
    }, saToken);
    const saPaidMember = saPaidR.data.data;
    const saPaidPay = saPaidMember ? saPaidMember.payment : null;
    const afterSaPaid = await payTotal();
    const memSaPaid = (await api("GET", "/api/members/" + (saPaidMember && saPaidMember._id), null, saToken)).data.data;
    let p3 = true, d3 = "";
    if (saPaidR.status !== 201) { p3 = false; d3 += "status=" + saPaidR.status + " " + JSON.stringify(saPaidR.data); }
    if (memSaPaid.paymentStatus !== "paid") { p3 = false; d3 += "paymentStatus=" + memSaPaid.paymentStatus + "; "; }
    if (memSaPaid.isActivePlan !== true) { p3 = false; d3 += "isActivePlan=" + memSaPaid.isActivePlan + "; "; }
    if (memSaPaid.status !== "active") { p3 = false; d3 += "status=" + memSaPaid.status + "; "; }
    if (memSaPaid.currentPlan && memSaPaid.currentPlan._id !== planB._id) { p3 = false; d3 += "currentPlan not planB; "; }
    if (saPaidPay && saPaidPay.method !== "upi") { p3 = false; d3 += "pay.method=" + (saPaidPay && saPaidPay.method) + "; "; }
    if (saPaidPay && saPaidPay.branchCode !== "BR_A") { p3 = false; d3 += "pay.branchCode=" + (saPaidPay && saPaidPay.branchCode) + "; "; }
    if (afterSaPaid !== before3 + 1) { p3 = false; d3 += "payment count " + before3 + "->" + afterSaPaid + " (expected +1); "; }
    record(nextName("Create member WITH Initial Plan + paid (Superadmin)"), p3, d3 || "All checks passed");

    // ════════════════════════════════════════════════════════════════════
    // T4: Create member WITH Initial Plan + PENDING payment (admin)
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T4: Create member WITH Initial Plan + pending (Admin) ===");
    const before4 = await payTotal();
    const pendR = await api("POST", "/api/members", {
      name: "Pending Plan Member", email: "pending@member.local", phone: "9876543213",
      password: "Pass123456", trainerId: "", branchCode: "BR_A",
      planId: planA._id,
      payment: { amount: 1000, method: "cash", status: "pending", note: "Initial pending" }
    }, adminAToken);
    const pendMember = pendR.data.data;
    const pendPay = pendMember ? pendMember.payment : null;
    const afterPend = await payTotal();
    const memPend = (await api("GET", "/api/members/" + (pendMember && pendMember._id), null, saToken)).data.data;
    let p4 = true, d4 = "";
    if (pendR.status !== 201) { p4 = false; d4 += "status=" + pendR.status + " " + JSON.stringify(pendR.data); }
    // Pending payment => consistent NON-active state, but a plan + term is recorded
    if (memPend.paymentStatus !== "pending") { p4 = false; d4 += "paymentStatus=" + memPend.paymentStatus + "; "; }
    if (memPend.isActivePlan !== false) { p4 = false; d4 += "isActivePlan=" + memPend.isActivePlan + "; "; }
    if (!pendPay) { p4 = false; d4 += "no payment in response; "; }
    if (pendPay && pendPay.status !== "pending") { p4 = false; d4 += "pay.status=" + pendPay.status + "; "; }
    if (afterPend !== before4 + 1) { p4 = false; d4 += "payment count " + before4 + "->" + afterPend + " (expected +1); "; }
    record(nextName("Create member WITH Initial Plan + pending (Admin)"), p4, d4 || "All checks passed");

    // ════════════════════════════════════════════════════════════════════
    // T5: Payment Section shows the new payment (GET /api/payments)
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T5: Payment Section displays created payment ===");
    const payList = (await api("GET", "/api/payments?gymId=TEST", null, saToken)).data.data.items;
    const paidMemberId = paidMember && (paidMember._id || (paidMember.member && paidMember.member._id));
    const inList = payList.some((p) => {
      const pmid = p.member && p.member._id ? String(p.member._id) : String(p.member);
      return p._id === (paidPay && paidPay._id) && p.status === "paid" && p.amount === 1000 && pmid === String(paidMemberId);
    });
    record("Payment Section displays created payment (T5)", inList, inList ? "Payment visible in list" : "Payment not found: " + JSON.stringify(payList.map((x) => ({ id: x._id, m: String(x.member), s: x.status, a: x.amount }))));

    // ════════════════════════════════════════════════════════════════════
    // T6: No duplicate payment on a single create request
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T6: No duplicate payment per create request ===");
    const before6 = await payTotal();
    const oneR = await api("POST", "/api/members", {
      name: "One Pay Member", email: "onepay@member.local", phone: "9876543214",
      password: "Pass123456", trainerId: "", branchCode: "BR_A",
      planId: planA._id,
      payment: { amount: 1000, method: "cash", status: "paid", note: "single" }
    }, adminAToken);
    const after6 = await payTotal();
    let p6 = true, d6 = "";
    if (after6 !== before6 + 1) { p6 = false; d6 += "payment count " + before6 + "->" + after6 + " (expected +1 exactly); "; }
    record("No duplicate payment per create request (T6)", p6, d6 || "Exactly +1 for one request");

    // ════════════════════════════════════════════════════════════════════
    // T7: Rollback — invalid plan must NOT leave a member with a plan/no payment
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T7: Rollback — invalid plan fails cleanly ===");
    const before7 = await payTotal();
    const badPlanR = await api("POST", "/api/members", {
      name: "Bad Plan Member", email: "badplan@member.local", phone: "9876543215",
      password: "Pass123456", trainerId: "", branchCode: "BR_A",
      planId: "000000000000000000000000",
      payment: { amount: 1000, status: "paid" }
    }, adminAToken);
    const after7 = await payTotal();
    let p7 = true, d7 = "";
    if (badPlanR.status === 201) { p7 = false; d7 += "expected failure, got 201; "; }
    if (after7 !== before7) { p7 = false; d7 += "payment created during failure " + before7 + "->" + after7 + "; "; }
    // Verify no member was created for that email either
    const search7 = (await api("GET", "/api/members?search=badplan&gymId=TEST", null, saToken)).data.data;
    const found7 = search7.items.some((m) => m.user && m.user.email === "badplan@member.local");
    if (found7) { p7 = false; d7 += "member created without payment during failure; "; }
    record("Rollback — invalid plan fails cleanly (T7)", p7, d7 || "No member, no payment left behind");

    // ════════════════════════════════════════════════════════════════════
    // T8: Existing assign-plan flow still works unchanged
    // ════════════════════════════════════════════════════════════════════
    console.log("=== T8: Existing assign-plan flow unchanged ===");
    const before8 = await payTotal();
    // Use an existing member = the one created in T2 (paid plan member, in BR_A)
    const assignR = await api("PATCH", "/api/members/" + paidMember._id + "/assign-plan", { planId: planB._id, membershipStartDate: daysFromNow(0) }, adminAToken);
    const after8 = await payTotal();
    const assignPay = assignR.data.data ? assignR.data.data.payment : null;
    let p8 = true, d8 = "";
    if (assignR.status !== 200) { p8 = false; d8 += "status=" + assignR.status + " " + JSON.stringify(assignR.data); }
    if (assignPay && assignPay.operationType !== "assign") { p8 = false; d8 += "opType=" + (assignPay && assignPay.operationType) + "; "; }
    if (after8 !== before8 + 1) { p8 = false; d8 += "payment count " + before8 + "->" + after8 + " (expected +1); "; }
    record("Existing assign-plan flow unchanged (T8)", p8, d8 || "All checks passed");

    // ════════════════════════════════════════════════════════════════════
    // REPORT
    // ════════════════════════════════════════════════════════════════════
    console.log("");
    console.log("=".repeat(70));
    console.log("TEST REPORT: Create Member + Initial Plan");
    console.log("=".repeat(70));
    console.log("");
    const passes = results.filter((r) => r.pass).length;
    const fails = results.filter((r) => !r.pass).length;
    for (const r of results) {
      console.log((r.pass ? "PASS" : "FAIL") + " | " + r.name);
      if (r.detail && !r.pass) console.log("       " + r.detail);
    }
    console.log("");
    console.log("Total: " + results.length + " checks, " + passes + " PASS, " + fails + " FAIL");
    console.log("");
    if (fails === 0) {
      console.log("VERDICT: CREATE MEMBER + INITIAL PLAN WORKFLOW OK");
    } else {
      console.log("VERDICT: FAILURES PRESENT -- FIX REQUIRED");
    }
    console.log("");
    console.log("=".repeat(70));

  } catch (err) {
    console.error("FATAL:", err && err.stack ? err.stack : err);
  } finally {
    if (proc) { proc.kill(); console.log("Server stopped."); }
  }
})();

/**
 * End-to-end test suite for atomic membership + payment operations (payflow).
 * Uses isolated gymza_payflow_test DB. Data pre-seeded by seed-test-data.js.
 */

const { spawn } = require("child_process");

const BASE = "http://localhost:5000";
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

function record(testNum, name, pass, detail) {
  results.push({ testNum, name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log("  [" + mark + "] Test " + testNum + ": " + name);
  if (!pass) console.log("    Detail: " + detail);
}

function daysFromNow(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  return dt.toISOString();
}

function sameDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function dateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, MONGO_URI: TEST_DB_URI, PORT: "5000", NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server start timeout")); }, 40000);
    child.stdout.on("data", (d) => {
      output += d.toString();
      if (output.includes("Server running on port 5000")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    child.on("close", (code) => { if (!output.includes("MongoDB connected")) { clearTimeout(timeout); reject(new Error("Server exited: " + output.slice(-600))); } });
  });
}

async function waitForHealth(retries = 20) {
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
    console.log("=== Starting server against gymza_payflow_test ===");
    proc = await startServer();
    const health = await waitForHealth();
    console.log("Server healthy, users:", health.data.totalUsers);
    console.log("");

    const GYM = "TEST";
    const saToken = await login("sa@payflow.local", "Super123456", GYM);
    const adminAToken = await login("admin_a@payflow.local", "Admin123456", GYM);
    const adminBToken = await login("admin_b@payflow.local", "Admin123456", GYM);
    console.log("Authenticated: superadmin, adminA (BR_A), adminB (BR_B)");

    // Resolve test entity IDs
    const memberList = (await api("GET", "/api/members?gymId=TEST", null, saToken)).data.data;
    let memberAId = null, memberBId = null;
    for (const m of memberList.items) {
      if (m.user && m.user.email === "member_a@payflow.local") memberAId = m._id;
      if (m.user && m.user.email === "member_b@payflow.local") memberBId = m._id;
    }
    const planList = (await api("GET", "/api/plans?gymId=TEST", null, saToken)).data.data;
    let planAId = null, planBId = null;
    const plansArr = Array.isArray(planList) ? planList : (planList.items || []);
    for (const p of plansArr) {
      if (p.name === "Basic Plan") planAId = p._id;
      if (p.name === "Premium Plan") planBId = p._id;
    }
    console.log("memberA:", memberAId, "memberB:", memberBId);
    console.log("planA:", planAId, "planB:", planBId);
    if (!memberAId || !memberBId || !planAId || !planBId) throw new Error("Missing seed data resolution (memberA/memberB/planA/planB)");

    const payCount = async () => {
      const r = await api("GET", "/api/payments?gymId=TEST", null, saToken);
      return r.data.data.total;
    };

    // ════════════════════════════════════════════════════════════════════
    // TEST 1: Superadmin Assign
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 1: Superadmin Assign ===");
    let before = await payCount();
    const assignR = await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: planAId, membershipStartDate: daysFromNow(0) }, saToken);
    let after = await payCount();
    const mem1 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    const pay1 = assignR.data && assignR.data.data ? assignR.data.data.payment : null;

    let p1 = true, d1 = "";
    if (assignR.status !== 200) { p1 = false; d1 += "status=" + assignR.status + " " + JSON.stringify(assignR.data); }
    if (!pay1) { p1 = false; d1 += "no payment; "; }
    if (pay1 && pay1.operationType !== "assign") { p1 = false; d1 += "opType=" + pay1.operationType + "; "; }
    if (pay1 && pay1.termKey === undefined) { p1 = false; d1 += "termKey missing; "; }
    if (pay1 && pay1.plan !== planAId) { p1 = false; d1 += "plan mismatch; "; }
    if (pay1 && pay1.member !== memberAId) { p1 = false; d1 += "member mismatch; "; }
    if (after !== before + 1) { p1 = false; d1 += "count " + before + "->" + after + " (expected +1); "; }
    if (mem1.paymentStatus !== "paid") { p1 = false; d1 += "paymentStatus=" + mem1.paymentStatus + "; "; }
    if (mem1.isActivePlan !== true) { p1 = false; d1 += "isActivePlan=" + mem1.isActivePlan + "; "; }
    if (pay1 && pay1.branchCode !== "BR_A") { p1 = false; d1 += "pay.branch=" + pay1.branchCode + "; "; }
    if (pay1 && pay1.gymId !== "TEST") { p1 = false; d1 += "pay.gymId=" + pay1.gymId + "; "; }
    if (pay1 && mem1 && dateOnly(pay1.membershipStartDate) !== dateOnly(mem1.membershipStartDate)) { p1 = false; d1 += "start mismatch; "; }
    if (pay1 && mem1 && dateOnly(pay1.membershipExpiryDate) !== dateOnly(mem1.membershipExpiryDate)) { p1 = false; d1 += "expiry mismatch; "; }
    record(1, "Superadmin Assign", p1, d1 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    const memAStart = mem1.membershipStartDate;
    const memAExpiry = mem1.membershipExpiryDate;

    // ════════════════════════════════════════════════════════════════════
    // TEST 2: Duplicate Assign / Retry
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 2: Duplicate Assign / Retry ===");
    before = await payCount();
    const dupR = await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: planAId, membershipStartDate: memAStart }, saToken);
    after = await payCount();
    const mem2 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    let p2 = true, d2 = "";
    const isReplay2 = dupR.status === 200 && (dupR.data.message || "").includes("already");
    if (!isReplay2) { p2 = false; d2 += "expected replay, got " + dupR.status + " " + JSON.stringify(dupR.data.message); }
    if (after !== before) { p2 = false; d2 += "count changed " + before + "->" + after + "; "; }
    if (dateOnly(mem2.membershipExpiryDate) !== dateOnly(memAExpiry)) { p2 = false; d2 += "expiry changed; "; }
    record(2, "Duplicate Assign / Retry", p2, d2 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    // idempotencyKey path
    const idem1 = await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: planAId, membershipStartDate: memAStart, idempotencyKey: "idem-assign-001" }, saToken);
    const idem2 = await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: planAId, membershipStartDate: memAStart, idempotencyKey: "idem-assign-001" }, saToken);
    const idemOk = idem1.status === 200 && idem2.status === 200 && (idem2.data.message || "").includes("already");
    console.log("  idempotencyKey replay:", idemOk ? "PASS" : "FAIL");

    // ════════════════════════════════════════════════════════════════════
    // TEST 3: Admin Assign
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 3: Admin Assign ===");
    before = await payCount();
    const admAssign = await api("PATCH", "/api/members/" + memberAId + "/upgrade-plan", { planId: planBId }, adminAToken);
    after = await payCount();
    const mem3 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    const pay3 = admAssign.data && admAssign.data.data ? admAssign.data.data.payment : null;
    let p3 = true, d3 = "";
    if (admAssign.status !== 200) { p3 = false; d3 += "status=" + admAssign.status + " " + JSON.stringify(admAssign.data); }
    if (after !== before + 1) { p3 = false; d3 += "count " + before + "->" + after + "; "; }
    if (pay3 && pay3.branchCode !== "BR_A") { p3 = false; d3 += "branchCode=" + pay3.branchCode + "; "; }
    if (pay3 && pay3.gymId !== "TEST") { p3 = false; d3 += "gymId=" + pay3.gymId + "; "; }
    if (mem3.currentPlan && mem3.currentPlan._id !== planBId) { p3 = false; d3 += "currentPlan not planB; "; }
    record(3, "Admin Assign", p3, d3 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    const memAExpiryAfter3 = mem3.membershipExpiryDate;

    // ════════════════════════════════════════════════════════════════════
    // TEST 4: Cross-Branch Security
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 4: Cross-Branch Security ===");
    before = await payCount();
    const cross = await api("PATCH", "/api/members/" + memberBId + "/assign-plan", { planId: planAId }, adminAToken);
    after = await payCount();
    const memB4 = (await api("GET", "/api/members/" + memberBId, null, saToken)).data.data;
    let p4 = true, d4 = "";
    if (cross.status === 200) { p4 = false; d4 += "cross-branch assign not rejected; "; }
    if (after !== before) { p4 = false; d4 += "payment created " + before + "->" + after + "; "; }
    if (memB4.currentPlan && memB4.currentPlan._id) { p4 = false; d4 += "memberB plan changed; "; }
    // branchCode manipulation attempt
    const cross2 = await api("PATCH", "/api/members/" + memberBId + "/assign-plan", { planId: planAId, branchCode: "BR_A" }, adminAToken);
    if (cross2.status === 200) { p4 = false; d4 += "body branchCode bypass not blocked; "; }
    record(4, "Cross-Branch Security", p4, d4 || "All checks passed");
    console.log("  Payment count:", before, "->", after);
    console.log("  Cross-branch status:", cross.status, JSON.stringify(cross.data && cross.data.message));

    // ════════════════════════════════════════════════════════════════════
    // TEST 5: PlanBranch Isolation
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 5: PlanBranch Isolation ===");
    // Plan A is NOT available in BR_B -> adminB assigning planA to memberB must fail
    const pbReject = await api("PATCH", "/api/members/" + memberBId + "/assign-plan", { planId: planAId }, adminBToken);
    let p5 = true, d5 = "";
    if (pbReject.status === 200) { p5 = false; d5 += "planBranch not enforced; "; }
    if (!pbReject.data.message || !pbReject.data.message.includes("not available")) { p5 = false; d5 += "wrong msg: " + JSON.stringify(pbReject.data.message); }

    // Plan B IS available in BR_B -> should succeed with exactly +1
    before = await payCount();
    const pbOk = await api("PATCH", "/api/members/" + memberBId + "/assign-plan", { planId: planBId }, adminBToken);
    after = await payCount();
    const pay5 = pbOk.data && pbOk.data.data ? pbOk.data.data.payment : null;
    if (pbOk.status !== 200) { p5 = false; d5 += "valid assign failed " + pbOk.status + "; "; }
    if (after !== before + 1) { p5 = false; d5 += "count " + before + "->" + after + "; "; }
    if (pay5 && pay5.branchCode !== "BR_B") { p5 = false; d5 += "branchCode=" + pay5.branchCode + "; "; }
    record(5, "PlanBranch Isolation", p5, d5 || "All checks passed");
    console.log("  Reject status:", pbReject.status, "| Ok count:", before, "->", after);

    // ════════════════════════════════════════════════════════════════════
    // TEST 6: Renew
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 6: Renew ===");
    // Member A is on planB (upgraded in test 3), status active. Renew extends from current expiry.
    const memA6 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    const oldExpiry = memA6.membershipExpiryDate;
    before = await payCount();
    const renewR = await api("PATCH", "/api/members/" + memberAId + "/renew-plan", { planId: planBId }, saToken);
    after = await payCount();
    const memA6b = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    const pay6 = renewR.data && renewR.data.data ? renewR.data.data.payment : null;
    let p6 = true, d6 = "";
    if (renewR.status !== 200) { p6 = false; d6 += "status=" + renewR.status + " " + JSON.stringify(renewR.data); }
    if (after !== before + 1) { p6 = false; d6 += "count " + before + "->" + after + "; "; }
    if (pay6 && pay6.operationType !== "renew") { p6 = false; d6 += "opType=" + pay6.operationType + "; "; }
    // Renewal should start from old expiry (member was active)
    const expectedRenewStart = oldExpiry;
    if (dateOnly(memA6b.membershipStartDate) !== dateOnly(expectedRenewStart)) { p6 = false; d6 += "renew start != old expiry; "; }
    // new expiry = old expiry + 60 (planB)
    const expExpected = new Date(oldExpiry); expExpected.setDate(expExpected.getDate() + 60);
    if (dateOnly(memA6b.membershipExpiryDate) !== dateOnly(expExpected)) { p6 = false; d6 += "renew expiry wrong; "; }
    record(6, "Renew", p6, d6 || "All checks passed");
    console.log("  Payment count:", before, "->", after);
    console.log("  Old expiry:", oldExpiry, "| New expiry:", memA6b.membershipExpiryDate);

    const renewStart = memA6b.membershipStartDate;
    const renewExpiry = memA6b.membershipExpiryDate;

    // ════════════════════════════════════════════════════════════════════
    // TEST 7: Duplicate Renew
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 7: Duplicate Renew ===");
    before = await payCount();
    const dupRenew = await api("PATCH", "/api/members/" + memberAId + "/renew-plan", { planId: planBId, membershipStartDate: renewStart }, saToken);
    after = await payCount();
    const mem7 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    let p7 = true, d7 = "";
    const isReplay7 = dupRenew.status === 200 && (dupRenew.data.message || "").includes("already");
    if (!isReplay7) { p7 = false; d7 += "expected replay, got " + dupRenew.status + " " + JSON.stringify(dupRenew.data.message); }
    if (after !== before) { p7 = false; d7 += "count changed " + before + "->" + after + "; "; }
    if (dateOnly(mem7.membershipExpiryDate) !== dateOnly(renewExpiry)) { p7 = false; d7 += "expiry extended twice!; "; }
    record(7, "Duplicate Renew", p7, d7 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    // ════════════════════════════════════════════════════════════════════
    // TEST 8: Upgrade
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 8: Upgrade ===");
    before = await payCount();
    const upgR = await api("PATCH", "/api/members/" + memberAId + "/upgrade-plan", { planId: planAId }, saToken);
    after = await payCount();
    const mem8 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    const pay8 = upgR.data && upgR.data.data ? upgR.data.data.payment : null;
    let p8 = true, d8 = "";
    if (upgR.status !== 200) { p8 = false; d8 += "status=" + upgR.status + "; "; }
    if (after !== before + 1) { p8 = false; d8 += "count " + before + "->" + after + "; "; }
    if (pay8 && pay8.operationType !== "upgrade") { p8 = false; d8 += "opType=" + pay8.operationType + "; "; }
    if (mem8.currentPlan && mem8.currentPlan._id !== planAId) { p8 = false; d8 += "currentPlan not planA; "; }
    if (!sameDay(mem8.membershipStartDate, new Date())) { p8 = false; d8 += "start not today; "; }
    const exp8 = new Date(); exp8.setDate(exp8.getDate() + 30);
    if (dateOnly(mem8.membershipExpiryDate) !== dateOnly(exp8)) { p8 = false; d8 += "expiry wrong; "; }
    record(8, "Upgrade", p8, d8 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    const upgStart = mem8.membershipStartDate;
    const upgExpiry = mem8.membershipExpiryDate;

    // ════════════════════════════════════════════════════════════════════
    // TEST 9: Duplicate Upgrade
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 9: Duplicate Upgrade ===");
    before = await payCount();
    const dupUpg = await api("PATCH", "/api/members/" + memberAId + "/upgrade-plan", { planId: planAId, membershipStartDate: upgStart }, saToken);
    after = await payCount();
    const mem9 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    let p9 = true, d9 = "";
    const isReplay9 = dupUpg.status === 200 && (dupUpg.data.message || "").includes("already");
    if (!isReplay9) { p9 = false; d9 += "expected replay, got " + dupUpg.status + " " + JSON.stringify(dupUpg.data.message); }
    if (after !== before) { p9 = false; d9 += "count changed " + before + "->" + after + "; "; }
    if (dateOnly(mem9.membershipExpiryDate) !== dateOnly(upgExpiry)) { p9 = false; d9 += "expiry extended twice!; "; }
    record(9, "Duplicate Upgrade", p9, d9 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    // ════════════════════════════════════════════════════════════════════
    // TEST 10: Web Two-Call Compatibility
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 10: Web Two-Call Compatibility ===");
    before = await payCount();
    const call1 = await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: planBId }, adminAToken);
    const afterCall1 = await payCount();
    const call2 = await api("POST", "/api/payments", { member: memberAId, plan: planBId, amount: 3000, method: "card", status: "paid", note: "Legacy two-call" }, adminAToken);
    const afterCall2 = await payCount();
    let p10 = true, d10 = "";
    if (call1.status !== 200) { p10 = false; d10 += "call1 failed; "; }
    if (afterCall1 !== before + 1) { p10 = false; d10 += "after call1 " + before + "->" + afterCall1 + "; "; }
    if (afterCall2 !== afterCall1) { p10 = false; d10 += "after call2 " + afterCall1 + "->" + afterCall2 + " (extra revenue!); "; }
    if (!(call2.data.message || "").includes("already")) { p10 = false; d10 += "call2 msg: " + JSON.stringify(call2.data.message); }
    const patched = call2.data.data;
    if (!patched || patched.amount !== 3000) { p10 = false; d10 += "amount not patched to 3000: " + (patched && patched.amount); }
    if (!patched || patched.method !== "card") { p10 = false; d10 += "method not patched to card; "; }
    record(10, "Web Two-Call Compatibility", p10, d10 || "All checks passed");
    console.log("  Payment count:", before, "->", afterCall1, "->", afterCall2);

    // ════════════════════════════════════════════════════════════════════
    // TEST 11: Standalone Payment
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 11: Standalone Payment ===");
    // After Test 10, memberA's current term is planB with a matching Payment, so a
    // POST for planB would hit the current-term dedupe guard (200, patch) instead of
    // creating a new record. To exercise the genuinely-new standalone path, record a
    // standalone Payment for planA: no planA Payment exists for memberA's CURRENT term
    // (planB dates), so the guard does not match and a fresh 201 record is created.
    before = await payCount();
    const stdR = await api("POST", "/api/payments", { member: memberAId, plan: planAId, amount: 2600, method: "upi", status: "paid", note: "Standalone test" }, saToken);
    after = await payCount();
    const sp = stdR.data.data;
    let p11 = true, d11 = "";
    if (stdR.status !== 201) { p11 = false; d11 += "status=" + stdR.status + " " + JSON.stringify(stdR.data); }
    if (after !== before + 1) { p11 = false; d11 += "count " + before + "->" + after + " (expected +1); "; }
    if (!sp || sp.amount !== 2600) { p11 = false; d11 += "amount=" + (sp && sp.amount) + "; "; }
    if (!sp || sp.method !== "upi") { p11 = false; d11 += "method=" + (sp && sp.method) + "; "; }
    if (!sp || !sp.invoiceNumber) { p11 = false; d11 += "invoiceNumber missing; "; }
    record(11, "Standalone Payment", p11, d11 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    // ════════════════════════════════════════════════════════════════════
    // TEST 12: Rollback / Failure
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 12: Rollback / Failure ===");
    before = await payCount();
    const memBefore12 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    const planBefore12 = memBefore12.currentPlan ? memBefore12.currentPlan._id : null;
    const expBefore12 = memBefore12.membershipExpiryDate;
    const failR = await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: "000000000000000000000000" }, saToken);
    after = await payCount();
    const memAfter12 = (await api("GET", "/api/members/" + memberAId, null, saToken)).data.data;
    let p12 = true, d12 = "";
    if (failR.status === 200) { p12 = false; d12 += "expected failure, got 200; "; }
    if (after !== before) { p12 = false; d12 += "payment created during failure " + before + "->" + after + "; "; }
    const planAfter12 = memAfter12.currentPlan ? memAfter12.currentPlan._id : null;
    if (planAfter12 !== planBefore12) { p12 = false; d12 += "member plan changed; "; }
    if (memAfter12.membershipExpiryDate !== expBefore12) { p12 = false; d12 += "member expiry changed; "; }
    record(12, "Rollback / Failure", p12, d12 || "All checks passed");
    console.log("  Payment count:", before, "->", after);

    // ════════════════════════════════════════════════════════════════════
    // TEST 13: Revenue Verification
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 13: Revenue Verification ===");
    const paidList = (await api("GET", "/api/payments?gymId=TEST&status=paid", null, saToken)).data.data;
    const sum = paidList.items.reduce((a, p) => a + (p.amount || 0), 0);
    let p13 = true, d13 = "Paid payments: " + paidList.items.length + ", sum: " + sum;
    if (paidList.items.length === 0) { p13 = false; d13 += " [no paid payments]"; }
    record(13, "Revenue Verification", p13, d13);

    // ════════════════════════════════════════════════════════════════════
    // TEST 14: Historical Payment Integrity
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 14: Historical Payment Integrity ===");
    const histBefore = (await api("GET", "/api/payments?gymId=TEST", null, saToken)).data.data.items;
    const snaps = histBefore.map((p) => ({ id: p._id, amount: p.amount, status: p.status, method: p.method }));
    // trigger another operation
    await api("PATCH", "/api/members/" + memberAId + "/assign-plan", { planId: planAId }, adminAToken);
    const histAfter = (await api("GET", "/api/payments?gymId=TEST", null, saToken)).data.data.items;
    let p14 = true, d14 = "";
    for (const s of snaps) {
      const h = histAfter.find((x) => x._id === s.id);
      if (!h) { p14 = false; d14 += "payment " + s.id + " disappeared; "; continue; }
      if (h.amount !== s.amount) { p14 = false; d14 += s.id + " amount " + s.amount + "->" + h.amount + "; "; }
      if (h.status !== s.status) { p14 = false; d14 += s.id + " status " + s.status + "->" + h.status + "; "; }
      if (h.method !== s.method) { p14 = false; d14 += s.id + " method " + s.method + "->" + h.method + "; "; }
    }
    record(14, "Historical Payment Integrity", p14, d14 || "Checked " + snaps.length + " payments, all unchanged");

    // ════════════════════════════════════════════════════════════════════
    // TEST 15: Index Verification (indirect via runtime)
    // ════════════════════════════════════════════════════════════════════
    console.log("=== Test 15: Index Verification ===");
    // termKey uniqueness proven by tests 2/7/9 (no dupes). Legacy payment readable:
    const legacyCheck = (await api("GET", "/api/payments?gymId=TEST", null, saToken)).data.data.items.some((p) => p.invoiceNumber === "INV-LEGACY-001");
    let p15 = true, d15 = "";
    if (!legacyCheck) { p15 = false; d15 += "legacy payment unreadable; "; }
    if (!(p2 && p7 && p9)) { p15 = false; d15 += "termKey uniqueness not demonstrated (2/7/9); "; }
    record(15, "Index Verification", p15, d15 || "Sparse/index behavior confirmed via termKey (2/7/9) + legacy readability");

    // ════════════════════════════════════════════════════════════════════
    // REPORT
    // ════════════════════════════════════════════════════════════════════
    console.log("");
    console.log("=".repeat(70));
    console.log("TEST REPORT");
    console.log("=".repeat(70));
    console.log("");
    console.log("### Environment");
    console.log("- Database: gymza_payflow_test (Atlas, isolated)");
    console.log("- Server port: 5000");
    console.log("- Superadmin: sa@payflow.local (TEST)");
    console.log("- Admin A: admin_a@payflow.local (BR_A)");
    console.log("- Admin B: admin_b@payflow.local (BR_B)");
    console.log("- Member A: BR_A | Member B: BR_B");
    console.log("- Plan A: Basic 30d (BR_A only) | Plan B: Premium 60d (BR_A+BR_B)");
    console.log("- Seeded legacy payment: INV-LEGACY-001 (no termKey/idempotencyKey)");
    console.log("");
    console.log("### Results");
    console.log("");
    const passes = results.filter((r) => r.pass).length;
    const fails = results.filter((r) => !r.pass).length;
    for (const r of results) {
      console.log((r.pass ? "PASS" : "FAIL") + " | Test " + r.testNum + ": " + r.name);
      if (r.detail) console.log("       " + r.detail);
    }
    console.log("");
    console.log("Total: " + results.length + " tests, " + passes + " PASS, " + fails + " FAIL");
    console.log("");
    console.log("### Final Verdict");
    if (fails === 0) {
      console.log("READY FOR REACT NATIVE PLANS");
    } else {
      console.log("NOT READY -- FIX REQUIRED");
    }
    console.log("");
    console.log("=".repeat(70));

  } catch (err) {
    console.error("FATAL:", err && err.stack ? err.stack : err);
  } finally {
    if (proc) { proc.kill(); console.log("Server stopped."); }
  }
})();
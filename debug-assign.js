const { spawn } = require("child_process");
const TEST_DB_URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";
const BASE = "http://localhost:5010";

function startServer() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, MONGO_URI: TEST_DB_URI, PORT: "5010", NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { const s = d.toString(); console.log("[server]", s); if (s.includes("Server running on port 5010")) resolve(child); });
    child.stderr.on("data", (d) => { const s = d.toString(); console.log("[server-err]", s); });
  });
}

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

(async () => {
  const proc = await startServer();
  try {
    await new Promise((r) => setTimeout(r, 3000));
    const login = await api("POST", "/api/auth/login", { gymId: "TEST", email: "sa@payflow.local", password: "Super123456" });
    console.log("login:", login.status, login.data && login.data.message);
    const token = login.data.data.accessToken;

    const members = (await api("GET", "/api/members?gymId=TEST", null, token)).data.data.items;
    const memA = members.find((m) => m.user && m.user.email === "member_a@payflow.local");
    console.log("memberA:", memA._id, "plan:", memA.currentPlan);

    const plans = (await api("GET", "/api/plans?gymId=TEST", null, token)).data.data;
    const planA = (Array.isArray(plans) ? plans : plans.items).find((p) => p.name === "Basic Plan");
    console.log("planA:", planA._id);

    console.log("--- Doing assign ---");
    const assign = await api("PATCH", "/api/members/" + memA._id + "/assign-plan", { planId: planA._id }, token);
    console.log("assign:", assign.status, JSON.stringify(assign.data));
  } catch (e) { console.error("ERR", e); }
  proc.kill();
  process.exit(0);
})();
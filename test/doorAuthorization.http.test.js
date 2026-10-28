const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");

let scannerDocs = [];
let controllerDocs = [];
let doorAuthStore = [];
let doorAuthFindOneAndUpdateCalls = 0;
let doorAuthIdCounter = 0;

const ScannerMock = {
  findOne(query) {
    let found = null;
    if (!query) return null;
    if (query.deviceId !== undefined) {
      found = scannerDocs.find((scanner) => scanner.deviceId === query.deviceId) || null;
    } else if (query.controllerId !== undefined) {
      found = scannerDocs.find((scanner) => scanner.controllerId === query.controllerId) || null;
    } else {
      return null;
    }
    const result = found ? Object.assign({}, found) : null;
    const chain = {
      select() { return chain; },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      }
    };
    return chain;
  }
};

const DoorControllerMock = {
  findOne(query) {
    const found = controllerDocs.find((controller) => controller.controllerId === query.controllerId) || null;
    const result = found ? Object.assign({}, found) : null;
    const chain = {
      select() { return chain; },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      }
    };
    return chain;
  }
};

const DoorAuthorizationMock = {
  async findOneAndUpdate(filter, update) {
    doorAuthFindOneAndUpdateCalls += 1;

    const now = filter.expiresAt && filter.expiresAt.$gt;
    if (!(now instanceof Date)) return null;

    const found = doorAuthStore.find((authorization) => {
      const expiresAt = authorization.expiresAt instanceof Date
        ? authorization.expiresAt
        : new Date(authorization.expiresAt);

      let scannerOk = true;
      if (filter.scanner !== undefined) {
        if (filter.scanner && typeof filter.scanner === "object" && filter.scanner.$in) {
          const allowed = Array.isArray(filter.scanner.$in) ? filter.scanner.$in.map(String) : [];
          scannerOk = allowed.includes(String(authorization.scanner));
        } else {
          scannerOk = String(authorization.scanner) === String(filter.scanner);
        }
      }
      if (!scannerOk) return false;

      let deviceOk = true;
      if (filter.deviceId !== undefined) {
        if (filter.deviceId && typeof filter.deviceId === "object" && filter.deviceId.$in) {
          const allowed = Array.isArray(filter.deviceId.$in) ? filter.deviceId.$in.map(String) : [];
          deviceOk = allowed.includes(String(authorization.deviceId));
        } else {
          deviceOk = String(authorization.deviceId) === String(filter.deviceId);
        }
      }
      if (!deviceOk) return false;

      return authorization.tokenHash === filter.tokenHash &&
        authorization.gymId === filter.gymId &&
        authorization.branchCode === filter.branchCode &&
        authorization.status === filter.status &&
        expiresAt.getTime() > now.getTime();
    });

    if (!found) return null;

    Object.assign(found, update.$set || {});
    return found;
  }
};

function installMock(relPath, exports) {
  const absolutePath = require.resolve(path.join(ROOT, relPath));
  require.cache[absolutePath] = {
    id: absolutePath,
    filename: absolutePath,
    loaded: true,
    exports,
    children: [],
    paths: []
  };
}

installMock("models/scanner.model.js", ScannerMock);
installMock("models/doorController.model.js", DoorControllerMock);
installMock("models/doorAuthorization.model.js", DoorAuthorizationMock);

const express = require("express");
const { hashKey } = require(path.join(ROOT, "utils/deviceKey.js"));
const { authenticateController } = require(path.join(ROOT, "middlewares/scannerAuth.middleware.js"));
const { redeem } = require(path.join(ROOT, "controllers/doorAuthorization.controller.js"));
const { hashToken } = require(path.join(ROOT, "services/doorAuthorization.service.js"));
const { errorHandler } = require(path.join(ROOT, "middlewares/error.middleware.js"));

const REDEEM_PATH = "/api/scanners/door-authorizations/redeem";
const SCANNER_A = "TEST-SCANNER-A";
const SCANNER_A_KEY = "test-scanner-key-a";
const SCANNER_A_ID = "scn_test_a";
const SCANNER_B = "TEST-SCANNER-B";
const SCANNER_B_KEY = "test-scanner-key-b";
const SCANNER_B_ID = "scn_test_b";
const CONTROLLER_A_ID = "CTRL-A";
const CONTROLLER_A_KEY = "ctrl-key-a";
const CONTROLLER_B_ID = "CTRL-B";
const CONTROLLER_B_KEY = "ctrl-key-b";

const app = express();
app.use(express.json());
app.post(REDEEM_PATH, authenticateController, redeem);
app.use(errorHandler);

let server;
let port;

before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  port = server.address().port;
  assert.ok(port > 0);
});

after(async () => {
  scannerDocs = [];
  doorAuthStore = [];
  doorAuthFindOneAndUpdateCalls = 0;

  if (server && server.listening) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

function resetState() {
  scannerDocs = [
    {
      _id: SCANNER_A_ID,
      gymId: "MAIN",
      branchCode: "BR2",
      deviceId: SCANNER_A,
      apiKeyHash: hashKey(SCANNER_A_KEY),
      status: "online",
      controllerId: CONTROLLER_A_ID,
      controllerKeyHash: hashKey(CONTROLLER_A_KEY)
    },
    {
      _id: SCANNER_B_ID,
      gymId: "MAIN",
      branchCode: "BR2",
      deviceId: SCANNER_B,
      apiKeyHash: hashKey(SCANNER_B_KEY),
      status: "online",
      controllerId: CONTROLLER_B_ID,
      controllerKeyHash: hashKey(CONTROLLER_B_KEY)
    }
  ];
  controllerDocs = scannerDocs.map((scanner) => ({
    _id: scanner._id,
    gymId: scanner.gymId,
    branchCode: scanner.branchCode,
    controllerId: scanner.controllerId,
    controllerKeyHash: scanner.controllerKeyHash,
    status: scanner.status,
    allowedScanners: [],
    allowedScannerIds: []
  }));
  doorAuthStore = [];
  doorAuthFindOneAndUpdateCalls = 0;
  doorAuthIdCounter = 0;
}

function seedAuthorization({
  token,
  scanner = SCANNER_A_ID,
  branchCode = "BR2",
  gymId = "MAIN",
  expiresAt = new Date(Date.now() + 30000),
  status = "pending"
} = {}) {
  const authorization = {
    _id: `door_test_${++doorAuthIdCounter}`,
    gymId,
    branchCode,
    scanner,
    deviceId: scanner === SCANNER_A_ID ? SCANNER_A : SCANNER_B,
    member: "mem_test",
    attendance: "att_test",
    scannerEvent: "sev_test",
    tokenHash: hashToken(token),
    status,
    expiresAt,
    consumedAt: null
  };

  doorAuthStore.push(authorization);
  return authorization;
}

function request({ body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const requestHeaders = { ...headers };

    if (payload) {
      requestHeaders["Content-Type"] = "application/json";
      requestHeaders["Content-Length"] = payload.length;
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: REDEEM_PATH,
        headers: requestHeaders
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function redeemRequest(token, {
  deviceId = CONTROLLER_A_ID,
  key = CONTROLLER_A_KEY,
  authenticate = true,
  headers: extraHeaders = {}
} = {}) {
  const headers = authenticate
    ? { "x-controller-id": deviceId, "x-controller-key": key, ...extraHeaders }
    : { ...extraHeaders };
  const body = token === undefined ? {} : { token };
  return request({ body, headers });
}

function assertInvalidRedemption(res) {
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, {
    success: false,
    message: "Door authorization is invalid, expired, or already used",
    code: "INTERNAL_ERROR",
    data: {}
  });
}

beforeEach(resetState);

test("DOOR AUTH HTTP: valid redemption returns 200 and consumes the token", async () => {
  const token = "test-token-valid-redemption";
  const authorization = seedAuthorization({ token });

  const res = await redeemRequest(token);

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"].includes("application/json"), true);
  assert.equal(res.json.success, true);
  assert.equal(res.json.message, "Door authorization accepted");
  assert.deepEqual(res.json.data, {
    authorized: true,
    expiresAt: authorization.expiresAt.toISOString()
  });
  assert.equal(authorization.status, "consumed");
  assert.ok(authorization.consumedAt instanceof Date);
  assert.equal(doorAuthFindOneAndUpdateCalls, 1);

  assert.equal(Object.prototype.hasOwnProperty.call(res.json.data, "token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.json.data, "tokenHash"), false);
  assert.equal(res.text.includes(token), false);
  assert.equal(res.text.includes(authorization.tokenHash), false);
});

test("DOOR AUTH HTTP: replaying a consumed token returns 403 and does not consume it twice", async () => {
  const token = "test-token-replay";
  const authorization = seedAuthorization({ token });

  const first = await redeemRequest(token);
  assert.equal(first.status, 200);

  const consumedAt = authorization.consumedAt.getTime();
  const replay = await redeemRequest(token);

  assertInvalidRedemption(replay);
  assert.equal(authorization.status, "consumed");
  assert.equal(authorization.consumedAt.getTime(), consumedAt);
  assert.equal(doorAuthStore.length, 1);
  assert.equal(doorAuthFindOneAndUpdateCalls, 2);
});

test("DOOR AUTH HTTP: an expired token returns 403 and remains pending", async () => {
  const token = "test-token-expired";
  const authorization = seedAuthorization({
    token,
    expiresAt: new Date(Date.now() - 1000)
  });

  const res = await redeemRequest(token);

  assertInvalidRedemption(res);
  assert.equal(authorization.status, "pending");
  assert.equal(authorization.consumedAt, null);
  assert.equal(doorAuthFindOneAndUpdateCalls, 1);
});

test("DOOR AUTH HTTP: an invalid token returns 403 without consuming another token", async () => {
  const authorization = seedAuthorization({ token: "test-token-stored" });

  const res = await redeemRequest("test-token-not-stored");

  assertInvalidRedemption(res);
  assert.equal(authorization.status, "pending");
  assert.equal(authorization.consumedAt, null);
  assert.equal(doorAuthFindOneAndUpdateCalls, 1);
});

test("DOOR AUTH HTTP: a token bound to another scanner returns 403", async () => {
  const token = "test-token-wrong-scanner";
  const authorization = seedAuthorization({ token, scanner: SCANNER_A_ID });

  const res = await redeemRequest(token, {
    deviceId: CONTROLLER_B_ID,
    key: CONTROLLER_B_KEY
  });

  assertInvalidRedemption(res);
  assert.equal(authorization.status, "pending");
  assert.equal(authorization.consumedAt, null);
  assert.equal(doorAuthFindOneAndUpdateCalls, 1);
});

test("DOOR AUTH HTTP: a controller cannot redeem for a scanner outside its allowlist", async () => {
  const token = "test-token-controller-allowlist";
  const authorization = seedAuthorization({ token, scanner: SCANNER_A_ID });
  controllerDocs[0].allowedScanners = [SCANNER_B_ID];

  const res = await redeemRequest(token);

  assertInvalidRedemption(res);
  assert.equal(authorization.status, "pending");
  assert.equal(authorization.consumedAt, null);
});

test("DOOR AUTH HTTP: a token bound to another gym returns 403", async () => {
  const token = "test-token-wrong-gym";
  const authorization = seedAuthorization({ token, gymId: "OTHER" });

  const res = await redeemRequest(token);

  assertInvalidRedemption(res);
  assert.equal(authorization.status, "pending");
  assert.equal(authorization.consumedAt, null);
});

test("DOOR AUTH HTTP: a token bound to another branch returns 403", async () => {
  const token = "test-token-wrong-branch";
  const authorization = seedAuthorization({ token, branchCode: "BR3" });

  const res = await redeemRequest(token);

  assertInvalidRedemption(res);
  assert.equal(authorization.status, "pending");
  assert.equal(authorization.consumedAt, null);
});

test("DOOR AUTH HTTP: a valid controller ID with another controller key returns 401", async () => {
  const token = "test-token-controller-mismatch";
  const authorization = seedAuthorization({ token });

  const res = await redeemRequest(token, {
    deviceId: CONTROLLER_A_ID,
    key: CONTROLLER_B_KEY
  });

  assert.equal(res.status, 401);
  assert.deepEqual(res.json, {
    success: false,
    message: "Invalid controller credentials"
  });
  assert.equal(authorization.status, "pending");
  assert.equal(doorAuthFindOneAndUpdateCalls, 0);
});

test("DOOR AUTH HTTP: concurrent redemptions consume a token only once", async () => {
  const token = "test-token-concurrent-redemption";
  const authorization = seedAuthorization({ token });

  const responses = await Promise.all([
    redeemRequest(token),
    redeemRequest(token)
  ]);

  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 403]);
  assert.equal(authorization.status, "consumed");
  assert.ok(authorization.consumedAt instanceof Date);
  assert.equal(doorAuthStore.length, 1);
  assert.equal(doorAuthFindOneAndUpdateCalls, 2);
});

test("DOOR AUTH HTTP: a missing token returns 403 without touching storage", async () => {
  const res = await redeemRequest(undefined);

  assertInvalidRedemption(res);
  assert.equal(doorAuthFindOneAndUpdateCalls, 0);
});

test("DOOR AUTH HTTP: missing authentication returns 401 without touching storage", async () => {
  const token = "test-token-missing-auth";
  const authorization = seedAuthorization({ token });

  const res = await redeemRequest(token, { authenticate: false });

  assert.equal(res.status, 401);
  assert.deepEqual(res.json, {
    success: false,
    message: "Missing controller credentials"
  });
  assert.equal(authorization.status, "pending");
  assert.equal(doorAuthFindOneAndUpdateCalls, 0);
});

test("DOOR AUTH HTTP: invalid scanner credentials return 401 without touching storage", async () => {
  const token = "test-token-invalid-credentials";
  const authorization = seedAuthorization({ token });

  const res = await redeemRequest(token, {
    deviceId: SCANNER_A,
    key: "wrong-test-key"
  });

  assert.equal(res.status, 401);
  assert.deepEqual(res.json, {
    success: false,
    message: "Invalid controller credentials"
  });
  assert.equal(authorization.status, "pending");
  assert.equal(doorAuthFindOneAndUpdateCalls, 0);
});

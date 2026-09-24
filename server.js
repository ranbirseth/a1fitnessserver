
const fs = require("fs");
const path = require("path");

// Environment loading is anchored to THIS file (server/.env) so the server's
// configuration is picked up no matter which directory the process is started
// from. A standard dotenv() call would resolve ".env" against process.cwd()
// and silently miss these values when started from the repo root.
const serverEnvFile = path.join(__dirname, ".env");
if (fs.existsSync(serverEnvFile)) {
  require("dotenv").config({ path: serverEnvFile });
}
require("dotenv").config();

const User = require("./models/user.model");
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const { connectDb, isDbConnected } = require("./config/db");
const { asyncHandler } = require("./utils/asyncHandler");
const { seedData, ensureDevSuperadmin, ensureDevTrainer, ensureDevMember } = require("./seeds/seedLogic");
const { connectRedis } = require("./config/redis");
const { configureCloudinary } = require("./config/cloudinary");
const { errorHandler } = require("./middlewares/error.middleware");
const { startExpiryReminderJob } = require("./jobs/expiryReminder.job");
const { backfillTemplateBranches } = require("./services/templateBranch.service");
const { migrateUserEmailIndex } = require("./services/userIndex.service");
const whatsappService = require("./services/whatsapp.service");
const { logConfig } = require("./utils/whatsappDebug");
const { initRealtime } = require("./services/realtime.service");

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();
const server = http.createServer(app);

// ============================================================
// CORS CONFIGURATION
// ============================================================

const allowedOrigins = [
  "http://localhost:5173",
  "https://a1-fitness-alpha.vercel.app",
];

// Also support CLIENT_ORIGIN from Render environment variables
if (process.env.CLIENT_ORIGIN) {
  const envOrigins = process.env.CLIENT_ORIGIN
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  envOrigins.forEach((origin) => {
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  });
}

console.log("=================================");
console.log("Allowed CORS Origins:");
console.log(allowedOrigins);
console.log("=================================");

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests without an Origin header.
    // Useful for Postman, server-to-server requests, etc.
    if (!origin) {
      return callback(null, true);
    }

    // Allow the frontend origin
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn("CORS BLOCKED:", origin);

    return callback(new Error(`CORS blocked origin: ${origin}`));
  },

  credentials: true,

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  optionsSuccessStatus: 200,
};

// ============================================================
// CORS MIDDLEWARE
// IMPORTANT: MUST BE BEFORE API ROUTES
// ============================================================

app.use(cors(corsOptions));

// Handle browser preflight requests
app.options("*", cors(corsOptions));

// ============================================================
// SOCKET.IO
// ============================================================

const io = new Server(server, {
  cors: corsOptions,
});

app.locals.io = io;
initRealtime(io);

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// ============================================================
// ADMS DEVICE PUSH MIDDLEWARE (eSSL/ZKTeco access terminals)
// ============================================================
// Registered BEFORE the global JSON parser so the raw, unparsed tab/newline
// separated log streams a terminal POSTs to /iclock/* stay as plain strings in
// req.body. Express json() only consumes application/json, but this ordering is
// mandatory: if an upstream proxy ever labels the stream as JSON, a parser
// registered first (json) would corrupt the payload with a serialization error.
app.use("/iclock", express.text({ type: "*/*", limit: "5mb" }));
app.use("/iclock", require("./routes/adms.routes"));

app.use(
  express.json({
    limit: "1mb",
  })
);

app.use(cookieParser());

app.use(morgan("dev"));

// ============================================================
// RATE LIMIT
// ============================================================

// Hardware admission terminals and scanner-managed endpoints must never be
// throttled as DDoS traffic. These path prefixes are the explicit whitelist.
const RATE_LIMIT_BYPASS_PREFIXES = ["/api/scanners", "/iclock"];

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    skip: (req) => RATE_LIMIT_BYPASS_PREFIXES.some((prefix) => req.path.startsWith(prefix)),
  })
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    // Database unavailable
    if (!isDbConnected()) {
      return res.json({
        success: true,
        message:
          "Server healthy, but the database is currently unavailable.",
        data: {
          dbReady: false,
          totalUsers: 0,
          adminExists: false,
          gymId: "MAIN",
        },
      });
    }

    // Count users
    const userCount = await User.countDocuments();

    // Check MAIN gym admin
    const admin = await User.findOne({
      email: "admin@gmail.com",
      gymId: "MAIN",
      role: "admin",
    });

    return res.json({
      success: true,
      message: "Server healthy",
      data: {
        dbReady: true,
        totalUsers: userCount,
        adminExists: !!admin,
        gymId: "MAIN",
      },
    });
  })
);

// ============================================================
// API ROUTES
// ============================================================

app.use(
  "/api/auth",
  require("./routes/auth.routes")
);

app.use(
  "/api/members",
  require("./routes/member.routes")
);

app.use(
  "/api/plans",
  require("./routes/plan.routes")
);

app.use(
  "/api/payments",
  require("./routes/payment.routes")
);

app.use(
  "/api/attendance",
  require("./routes/attendance.routes")
);

app.use(
  "/api/dashboard",
  require("./routes/dashboard.routes")
);

app.use(
  "/api/analytics",
  require("./routes/analytics.routes")
);

app.use(
  "/api/progress",
  require("./routes/progress.routes")
);

app.use(
  "/api/entities",
  require("./routes/generic.routes")
);

app.use(
  "/api/branches",
  require("./routes/branch.routes")
);

app.use(
  "/api/trainers",
  require("./routes/trainer.routes")
);

app.use(
  "/api/admins",
  require("./routes/admin.routes")
);

app.use(
  "/api/notifications",
  require("./routes/notification.routes")
);

app.use(
  "/api/bookings",
  require("./routes/booking.routes")
);

app.use(
  "/api/referrals",
  require("./routes/referral.routes")
);

app.use(
  "/api/workouts",
  require("./routes/workout.routes")
);

app.use(
  "/api/diets",
  require("./routes/diet.routes")
);

app.use(
  "/api/users",
  require("./routes/user.routes")
);

app.use(
  "/api/scanners",
  require("./routes/scanner.routes")
);

// ============================================================
// SERVE CLIENT BUILD IN PRODUCTION
// ============================================================

if (
  process.env.NODE_ENV === "production" ||
  process.env.RENDER
) {
  const clientPath = path.join(
    __dirname,
    "../client/dist"
  );

  console.log(
    "Serving static files from:",
    clientPath
  );

  app.use(express.static(clientPath));

  app.get("*", (req, res) => {
    // Never serve index.html for unknown API routes
    if (req.path.startsWith("/api")) {
      return res.status(404).json({
        success: false,
        message: "API route not found",
      });
    }

    res.sendFile(
      path.resolve(clientPath, "index.html")
    );
  });
} else {
  app.get("/", (_req, res) => {
    res.send(
      "Gym Management API is running. Start client in dev mode or build for production."
    );
  });
}

// ============================================================
// SOCKET.IO CONNECTION
// ============================================================

io.on("connection", (socket) => {
  const gymId = socket.handshake.query.gymId;

  if (gymId) {
    socket.join(gymId);

    socket.emit("connected", {
      message: `Joined realtime for gym: ${gymId}`,
    });
  } else {
    socket.emit("connected", {
      message:
        "Realtime connected. Join a gym room.",
    });
  }

  socket.on("joinGym", (id) => {
    if (id) {
      socket.join(id);
    }
  });
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(errorHandler);

// ============================================================
// SERVER START FUNCTION
// ============================================================

const startServer = (port, attempt = 1) => {
  server.once("error", (error) => {
    // If port is already in use, try next port
    if (
      error.code === "EADDRINUSE" &&
      attempt < 5
    ) {
      const nextPort = port + 1;

      console.warn(
        `Port ${port} is busy. Trying ${nextPort}...`
      );

      startServer(
        nextPort,
        attempt + 1
      );

      return;
    }

    console.error(
      "Critical server startup error:",
      error.message
    );

    process.exit(1);
  });

  server.listen(port, () => {
    console.log(
      `Server running on port ${port}`
    );
  });
};

// ============================================================
// APPLICATION STARTUP
// ============================================================

const start = async () => {
  try {
    console.log(
      "Environment:",
      process.env.NODE_ENV || "development"
    );

    console.log(
      "RENDER:",
      process.env.RENDER || "false"
    );

    // --------------------------------------------------------
    // WHATSAPP CONFIGURATION DIAGNOSTICS (safe: booleans only,
    // never the access token or any credential value)
    // --------------------------------------------------------
    logConfig(whatsappService.getSafeConfig());

    // --------------------------------------------------------
    // CONNECT DATABASE
    // --------------------------------------------------------

    const dbReady = await connectDb();

    app.locals.dbReady = dbReady;

    if (dbReady) {
      console.log("Database connection successful");
      await seedData();
      await ensureDevSuperadmin();
      await ensureDevTrainer();
      await ensureDevMember();
      // One-time idempotent migration: build junction rows for legacy templates
      // that were stored with a single branchCode field.
      await backfillTemplateBranches();
      // One-time idempotent migration: BUG-04 made member email optional. Ensure
      // the gymId/email unique index is sparse so members without email can coexist.
      await migrateUserEmailIndex();
    } else {
      console.warn(
        "Database is unavailable. " +
          "Continuing without database."
      );
    }

    // --------------------------------------------------------
    // CONNECT OTHER SERVICES
    // --------------------------------------------------------

    connectRedis();

    configureCloudinary();

    startExpiryReminderJob();

    // --------------------------------------------------------
    // START SERVER
    // --------------------------------------------------------

    const port = Number(
      process.env.PORT || 5000
    );

    startServer(port);
  } catch (error) {
    console.error(
      "Critical server startup error:",
      error.message
    );

    if (error.code === "ENOTFOUND") {
      console.error(
        "DNS Resolution failed. " +
          "Please check your MONGO_URI " +
          "and internet connection."
      );
    }

    process.exit(1);
  }
};

// ============================================================
// ADMS HARDWARE LISTENER (LOCAL DEV ONLY)
// ============================================================
// The eSSL K30 firmware refuses to share the main REST API port, so it pushes
// raw text streams to a dedicated 8081 listener in local development. Render
// web services expose only a single public port, so this listener is skipped
// when RENDER=true and /iclock remains served from the main Express app.
if (process.env.RENDER !== "true") {
  const admsApp = express();
  const admsPort = Number(process.env.ADMS_PORT || 8081);

  // Raw text parser BEFORE any JSON parsing so the tab/newline separated device
  // streams reach req.body as untouched strings.
  admsApp.use(express.text({ type: "*/*", limit: "5mb" }));

  // Global debug middleware for diagnosing biometric machine transmissions
  admsApp.use((req, res, next) => {
    // 1. Silent short-circuit filter to eliminate mobile tablet socket spam
    if (req.url.startsWith('/message')) {
      res.header('Connection', 'close');
      return res.status(404).end();
    }

    // 2. Standard operational biometric logging (Only fires for actual machine data)
    console.log(`\n=================================`);
    console.log(`[ADMS RAW REQUEST] ${req.method} ${req.url}`);
    console.log(`Headers:`, req.headers);
    if (req.query && Object.keys(req.query).length) {
      console.log("Query Params:", req.query);
    }
    if (req.body && Object.keys(req.body).length) {
      console.log("Body Payload:", req.body);
    }
    console.log(`=================================\n`);
    next();
  });

  // Route all incoming /iclock paths to the ADMS router endpoints.
  admsApp.use("/iclock", require("./routes/adms.routes"));

  const admsServer = http.createServer(admsApp);
  admsServer.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[adms] Port ${admsPort} is already in use. ADMS listener NOT started. Main API continues.`);
    } else {
      console.error("[adms] ADMS listener error:", err.message);
    }
  });
  admsServer.listen(admsPort, () => {
    console.log(`[adms] ADMS server running on port ${admsPort}`);
  });
}

// ============================================================
// START APPLICATION
// ============================================================

start();
const express = require("express");
const { handleGetRequest, handleCdata, handleDeviceCmd } = require("../controllers/adms.controller");

// eSSL/ZKTeco devices send a raw SN query string plus (for cdata/devicecmd)
// tab or newline separated text bodies. This router must be mounted with the
// dedicated raw text body parser middleware (see server.js) so req.body arrives
// as the untouched string stream instead of being JSON-ified.
function buildUrl(req) {
  return new URL(req.originalUrl, "http://localhost");
}

// express.text() leaves req.body unset (or as a generic {} object) when the
// request carries no body. The former standalone ADMS listener's readBody()
// always produced a raw string ("" for an empty stream), so normalize back to
// that exact contract before handing the payload to the controller.
function rawBody(req) {
  const body = req.body;
  return typeof body === "string" ? body : "";
}

// The previous standalone ADMS listener answered device-facing errors in plain
// text. Keep that contract here instead of delegating to the JSON error handler.
function respondError(res, err) {
  if (res.headersSent) return false;
  const statusCode = err && err.statusCode ? err.statusCode : 500;
  res.status(statusCode).type("text/plain").send(err && err.message ? err.message : "Internal Server Error");
  return true;
}

function wrap(handler) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, buildUrl(req), rawBody(req)))
      .catch((err) => {
        if (!respondError(res, err)) next(err);
      });
  };
}

const router = express.Router();

router.get("/getrequest", wrap(handleGetRequest));
router.get("/getrequest.aspx", wrap(handleGetRequest));

router.post("/devicecmd", wrap(handleDeviceCmd));
router.post("/devicecmd.aspx", wrap(handleDeviceCmd));

// Devices may push cdata with either GET (query-embedded logs) or POST (body).
router.get("/cdata", wrap(handleCdata));
router.post("/cdata", wrap(handleCdata));
router.get("/cdata.aspx", wrap(handleCdata));
router.post("/cdata.aspx", wrap(handleCdata));

module.exports = router;
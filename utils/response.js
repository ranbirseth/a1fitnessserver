const sendResponse = (res, { status = 200, success = true, message = "OK", data = {} }) =>
  res.status(status).json({ success, message, data });

module.exports = { sendResponse };

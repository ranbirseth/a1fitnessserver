const errorHandler = (err, _req, res, _next) => {
  const status = err.statusCode || 500;
  return res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
    code: err.code || (status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR"),
    data: err.details || {}
  });
};

module.exports = { errorHandler };

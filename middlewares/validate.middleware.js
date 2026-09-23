const { ZodError } = require("zod");
const { AppError } = require("../utils/appError");

const validate = (schema) => (req, _res, next) => {
  try {
    req.validated = schema.parse({
      body: req.body,
      query: req.query,
      params: req.params
    });
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      return next(new AppError("Validation failed", 400, "VALIDATION_ERROR", err.flatten()));
    }
    next(err);
  }
};

module.exports = { validate };

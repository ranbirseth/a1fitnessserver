const { z } = require("zod");

const signupSchema = z.object({
  body: z.object({
    gymId: z.string().min(1),
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(6)
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough()
});

const loginSchema = z.object({
  body: z.object({
    gymId: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6)
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough()
});

const refreshSchema = z.object({
  body: z.object({ refreshToken: z.string().optional() }).optional(),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough()
});

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email(),
    gymId: z.string().min(1)
  })
});

const resetPasswordSchema = z.object({
  params: z.object({
    token: z.string().min(1)
  }),
  body: z.object({
    password: z.string().min(6)
  })
});

module.exports = { signupSchema, loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema };

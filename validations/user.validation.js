const { z } = require("zod");

const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, "Name is required"),
    email: z.string().trim().email("Valid email is required"),
    phone: z.string().trim().regex(/^\d{10}$/, "Phone number must be exactly 10 digits"),
    password: z.string().min(6, "Password must be at least 6 characters").optional().or(z.literal("")),
    photo: z.string().url("Photo must be a valid URL").optional().or(z.literal("")),
    address: z.string().optional(),
    emergencyContact: z.string().optional()
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough()
});

module.exports = { updateProfileSchema };

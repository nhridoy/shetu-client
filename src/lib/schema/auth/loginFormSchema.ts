import { z } from "zod";

export const loginFormSchema = z.object({
  email: z
    .email({ error: "Please enter a valid email address" })
    .trim()
    .min(1, { error: "Email is required" })
    .max(254, { error: "Email must be at most 254 characters" }),
  password: z
    .string()
    .trim()
    .min(1, { error: "Password is required" })
    .min(8, { error: "Password must be at least 8 characters" })
    .max(128, { error: "Password must be at most 128 characters" }),
});

export type LoginFormSchema = z.infer<typeof loginFormSchema>;

export const requiredFields = Object.entries(loginFormSchema.shape).reduce(
  (acc, [key, schema]) => {
    if (!schema.safeParse(undefined).success) acc.push(key);
    return acc;
  },
  [] as string[],
);

export const loginFormDefaultValues: LoginFormSchema = {
  email: "",
  password: "",
};

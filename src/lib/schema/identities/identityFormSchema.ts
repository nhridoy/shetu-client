import { z } from "zod";

export const identityFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Label is required" })
    .max(255, { error: "Label must be at most 255 characters" }),
  username: z.string().trim().min(1, { error: "Username is required" }),
  password: z.string(),
  keyId: z.string(),
  totpSecret: z.string().trim(),
});

export type IdentityFormSchema = z.infer<typeof identityFormSchema>;

export const identityFormDefaultValues: IdentityFormSchema = {
  name: "",
  username: "",
  password: "",
  keyId: "",
  totpSecret: "",
};

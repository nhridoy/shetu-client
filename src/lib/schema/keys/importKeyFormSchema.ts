import { z } from "zod";

export const importKeyFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Key name is required" })
    .max(255, { error: "Key name must be at most 255 characters" }),
  description: z.string().max(1024).optional(),
  privateKey: z
    .string()
    .min(1, { error: "Private key is required" })
    .max(65536, { error: "Private key must be at most 65536 characters" }),
  publicKey: z.string().optional(),
  passphrase: z.string().max(1024).optional(),
});

export type ImportKeyFormSchema = z.infer<typeof importKeyFormSchema>;

export const importKeyFormDefaultValues: ImportKeyFormSchema = {
  name: "",
  description: "",
  privateKey: "",
  publicKey: "",
  passphrase: "",
};

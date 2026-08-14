import { z } from "zod";

export const hostFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "Host name is required" })
      .max(255, { error: "Host name must be at most 255 characters" }),
    address: z
      .string()
      .trim()
      .min(1, { error: "Address is required" })
      .max(255, { error: "Address must be at most 255 characters" }),
    port: z
      .number()
      .int({ error: "Port must be an integer" })
      .min(1, { error: "Port must be at least 1" })
      .max(65535, { error: "Port must be at most 65535" }),
    username: z
      .string()
      .trim()
      .min(1, { error: "Username is required" })
      .max(255, { error: "Username must be at most 255 characters" }),
    authType: z.enum(["password", "key", "both", "none"]),
    password: z.string().max(4096).optional(),
    keyId: z.string().optional(),
    color: z.string().optional(),
    groupId: z.string().optional(),
    tags: z.string().optional(),
  })
  .refine(
    (data) => {
      if (
        (data.authType === "password" || data.authType === "both") &&
        !data.password
      )
        return false;
      return true;
    },
    { error: "Password is required", path: ["password"] },
  )
  .refine(
    (data) => {
      if ((data.authType === "key" || data.authType === "both") && !data.keyId)
        return false;
      return true;
    },
    { error: "Please select an SSH key", path: ["keyId"] },
  );

export type HostFormSchema = z.infer<typeof hostFormSchema>;

export const hostFormDefaultValues: HostFormSchema = {
  name: "",
  address: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  keyId: "",
  color: "#64748b",
  groupId: "",
  tags: "",
};

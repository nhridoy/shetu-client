import { z } from "zod";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    port: z.coerce
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
    jumpHostId: z.string().nullable().optional(),
    color: z.string().optional(),
    groupId: z.string().optional(),
    tags: z.string().optional(),
    keepaliveMode: z.enum(["default", "off", "custom"]),
    keepaliveSecs: z.coerce.number().optional(),
    forwardAgent: z.boolean(),
    env: z.array(
      z.object({
        name: z.string().refine((n) => n === "" || ENV_NAME.test(n), {
          error: "Use letters, digits and underscores; no leading digit",
        }),
        value: z.string(),
      }),
    ),
    startupMode: z.enum(["none", "snippet", "command"]),
    startupSnippetId: z.string().optional(),
    startupCommand: z.string().optional(),
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
  )
  .refine(
    (d) =>
      d.keepaliveMode !== "custom" ||
      (Number.isInteger(d.keepaliveSecs) &&
        (d.keepaliveSecs as number) >= 5 &&
        (d.keepaliveSecs as number) <= 600),
    { error: "Keepalive must be 5-600 seconds", path: ["keepaliveSecs"] },
  )
  .refine((d) => d.startupMode !== "snippet" || !!d.startupSnippetId, {
    error: "Select a snippet",
    path: ["startupSnippetId"],
  });

export type HostFormSchema = z.infer<typeof hostFormSchema>;
export type HostFormValues = z.input<typeof hostFormSchema>;

export const hostFormDefaultValues: HostFormSchema = {
  name: "",
  address: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  keyId: "",
  jumpHostId: null,
  color: "#64748b",
  groupId: "",
  tags: "",
  keepaliveMode: "default",
  keepaliveSecs: undefined,
  forwardAgent: false,
  env: [],
  startupMode: "none",
  startupSnippetId: "",
  startupCommand: "",
};

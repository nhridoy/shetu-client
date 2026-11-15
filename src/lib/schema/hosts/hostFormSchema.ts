import { z } from "zod";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const envRowsSchema = z.array(
  z.object({
    name: z.string().refine((n) => n === "" || ENV_NAME.test(n), {
      error: "Use letters, digits and underscores; no leading digit",
    }),
    value: z.string(),
  }),
);

export const isBlank = (v: unknown) => v == null || String(v).trim() === "";

/** Number input value: a number, or a string from the field; empty means "not set". */
const numberField = z.union([z.number(), z.string()]).nullish();

export const portOk = (v: unknown) =>
  isBlank(v) ||
  (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535);
export const PORT_ERROR = "Port must be between 1 and 65535";

/** Empty = inherit/default, 0 = off, otherwise 5-600 seconds. */
export const keepaliveOk = (v: unknown) =>
  isBlank(v) ||
  Number(v) === 0 ||
  (Number.isInteger(Number(v)) && Number(v) >= 5 && Number(v) <= 600);
export const KEEPALIVE_ERROR = "Keepalive must be 0 (off) or 5-600 seconds";

/** Only the address is required. */
export const hostFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .max(255, { error: "Host name must be at most 255 characters" }),
    address: z
      .string()
      .trim()
      .min(1, { error: "Address is required" })
      .max(255, { error: "Address must be at most 255 characters" }),
    port: numberField.refine(portOk, { error: PORT_ERROR }),
    username: z
      .string()
      .trim()
      .max(255, { error: "Username must be at most 255 characters" }),
    identityId: z.string().optional(),
    password: z.string().max(4096).optional(),
    keyId: z.string().optional(),
    jumpHostId: z.string().nullable().optional(),
    color: z.string().optional(),
    groupId: z.string().optional(),
    tags: z.string().optional(),
    keepaliveSecs: numberField.refine(keepaliveOk, {
      error: KEEPALIVE_ERROR,
    }),
    forwardAgentMode: z.enum(["inherit", "on", "off"]),
    env: envRowsSchema,
    startupMode: z.enum(["inherit", "none", "snippet", "command"]),
    startupSnippetId: z.string().optional(),
    startupCommand: z.string().optional(),
  })
  .refine((d) => d.startupMode !== "snippet" || !!d.startupSnippetId, {
    error: "Select a snippet",
    path: ["startupSnippetId"],
  });

export type HostFormSchema = z.infer<typeof hostFormSchema>;
export type HostFormValues = z.input<typeof hostFormSchema>;

export const hostFormDefaultValues: HostFormSchema = {
  name: "",
  address: "",
  port: "",
  username: "",
  identityId: "",
  password: "",
  keyId: "",
  jumpHostId: null,
  color: "#64748b",
  groupId: "",
  tags: "",
  keepaliveSecs: "",
  forwardAgentMode: "off",
  env: [],
  startupMode: "none",
  startupSnippetId: "",
  startupCommand: "",
};

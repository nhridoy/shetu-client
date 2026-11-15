import { z } from "zod";
import {
  envRowsSchema,
  KEEPALIVE_ERROR,
  keepaliveOk,
  PORT_ERROR,
  portOk,
} from "./hostFormSchema";

// Every field except the name is optional: empty means "this group doesn't set it".
export const groupFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "Group name is required" })
      .max(255, { error: "Group name must be at most 255 characters" }),
    username: z
      .string()
      .trim()
      .max(255, { error: "Username must be at most 255 characters" })
      .optional(),
    /** The stored method; the credential fields decide the saved one. */
    authType: z.string().nullish(),
    identityId: z.string().optional(),
    password: z.string().max(4096).optional(),
    keyId: z.string().optional(),
    port: z
      .union([z.number(), z.string()])
      .nullish()
      .refine(portOk, { error: PORT_ERROR }),
    keepaliveSecs: z
      .union([z.number(), z.string()])
      .nullish()
      .refine(keepaliveOk, { error: KEEPALIVE_ERROR }),
    forwardAgent: z.enum(["unset", "on", "off"]),
    env: envRowsSchema,
    startupMode: z.enum(["none", "snippet", "command"]),
    startupSnippetId: z.string().optional(),
    startupCommand: z.string().optional(),
  })
  .refine((d) => d.startupMode !== "snippet" || !!d.startupSnippetId, {
    error: "Select a snippet",
    path: ["startupSnippetId"],
  });

export type GroupFormSchema = z.infer<typeof groupFormSchema>;
export type GroupFormValues = z.input<typeof groupFormSchema>;

export const groupFormDefaultValues: GroupFormValues = {
  name: "",
  username: "",
  authType: "",
  identityId: "",
  password: "",
  keyId: "",
  port: "",
  keepaliveSecs: "",
  forwardAgent: "unset",
  env: [],
  startupMode: "none",
  startupSnippetId: "",
  startupCommand: "",
};

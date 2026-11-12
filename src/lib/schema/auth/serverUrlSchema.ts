import { z } from "zod";

export const serverUrlSchema = z.object({
  serverUrl: z
    .url({
      protocol: /^https?$/,
      error: "Enter a full http:// or https:// URL",
    })
    .optional()
    .or(z.literal("")),
});

export type ServerUrlSchema = z.infer<typeof serverUrlSchema>;

export const serverUrlDefaultValues: ServerUrlSchema = {
  serverUrl: "",
};

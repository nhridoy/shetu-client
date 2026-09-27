import { z } from "zod";

const name = z.string().trim().min(1, "Name is required").max(128);
const port = z
  .number()
  .int("Port must be an integer")
  .min(1, "Port must be at least 1")
  .max(65535, "Port must be at most 65535");
const destinationHost = z
  .string()
  .trim()
  .min(1, "Destination host is required")
  .max(255);

export const portForwardFormSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("local"),
    name,
    localPort: port,
    destinationHost,
    destinationPort: port,
  }),
  z.object({
    mode: z.literal("remote"),
    name,
    remoteBindAddress: z.enum(["127.0.0.1", "0.0.0.0"]),
    remotePort: port,
    destinationHost,
    destinationPort: port,
  }),
  z.object({ mode: z.literal("dynamic"), name, localPort: port }),
]);

export type PortForwardFormSchema = z.infer<typeof portForwardFormSchema>;

export const portForwardFormDefaultValues: PortForwardFormSchema = {
  mode: "local",
  name: "",
  localPort: 8080,
  destinationHost: "localhost",
  destinationPort: 80,
};

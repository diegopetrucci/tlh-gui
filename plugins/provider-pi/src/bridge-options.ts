import { z } from "zod";

export const PI_FLAVORS = ["tlh", "tlh-main", "pi"] as const;
export type PiFlavor = (typeof PI_FLAVORS)[number];

const piBridgeOptionsSchema = z.object({
  piFlavor: z.enum(PI_FLAVORS),
  displayName: z.string().min(1),
  command: z.string().min(1),
  loginCommand: z.string().min(1),
  maintenance: z.enum(["tlh", "npm"]),
  agentDir: z.string().min(1).optional(),
});

export type PiBridgeOptions = z.infer<typeof piBridgeOptionsSchema>;

export const PI_BRIDGE_OPTIONS_BY_FLAVOR: Readonly<
  Record<PiFlavor, PiBridgeOptions>
> = {
  tlh: {
    piFlavor: "tlh",
    displayName: "TLH",
    command: "tlh",
    loginCommand: "tlh",
    maintenance: "tlh",
    agentDir: "~/.the-last-harness/agent",
  },
  "tlh-main": {
    piFlavor: "tlh-main",
    displayName: "TLH main",
    command: "tlh-main",
    loginCommand: "tlh-main",
    maintenance: "tlh",
    agentDir: "~/.the-last-harness-main/agent",
  },
  pi: {
    piFlavor: "pi",
    displayName: "Pi",
    command: "pi",
    loginCommand: "pi",
    maintenance: "npm",
  },
};

export const DEFAULT_PI_BRIDGE_OPTIONS = PI_BRIDGE_OPTIONS_BY_FLAVOR.pi;

export function parsePiBridgeOptions(
  providerOptions: unknown,
): PiBridgeOptions | null {
  if (
    typeof providerOptions !== "object" ||
    providerOptions === null ||
    !("piFlavor" in providerOptions)
  ) {
    return null;
  }
  const parsed = piBridgeOptionsSchema.safeParse(providerOptions);
  if (!parsed.success) {
    throw new Error(
      `Invalid provider-pi bridge options: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

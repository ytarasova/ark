import type { TypedSecret, TypedSecretPlacer, PlacementCtx } from "../placement-types.js";

export const envVarPlacer: TypedSecretPlacer = {
  type: "env-var",
  async place(secret: TypedSecret, ctx: PlacementCtx) {
    if (typeof secret.value !== "string") {
      throw new Error(`env-var secret '${secret.name}' has no value`);
    }
    ctx.setEnv(secret.name, secret.value);
  },
};

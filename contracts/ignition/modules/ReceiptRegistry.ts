import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys ReceiptRegistry(owner, serviceSigner). Both are constructor arguments and the
 * contract is not upgradeable; run scripts/check-deploy-params.mjs on the parameter file
 * first (the deploy:* npm scripts do).
 */
export default buildModule("ReceiptRegistryModule", (m) => {
  const owner = m.getParameter("owner");
  const serviceSigner = m.getParameter("serviceSigner");

  const registry = m.contract("ReceiptRegistry", [owner, serviceSigner]);

  return { registry };
});
